import type { AiProvider } from '../ai/contracts.ts';
import { EvalContractError } from './dataset.ts';
import {
  USD_MICROS_PER_CENT,
  estimateCallCostUsdMicros,
  findModelPrice,
  parseAiPriceSnapshot,
  sumUsdMicros,
  type AiPriceSnapshot,
  type BillableTokenUsage,
} from './price-snapshot.ts';

export const LIVE_EVAL_HARD_CAPS = Object.freeze({
  logicalCalls: 48,
  providerAttempts: 56,
  estimatedCostUsdCents: 300,
  estimatedCostUsdMicros: 3_000_000,
});

export const LIVE_EVAL_ENABLED_DEFAULT = false;

export interface LiveEvalLimits {
  readonly maxLogicalCalls: number;
  readonly maxProviderAttempts: number;
  readonly maxEstimatedCostUsdMicros: number;
}

export interface LogicalCallBudget {
  readonly provider: AiProvider;
  readonly configuredModel: string;
  readonly maxAttempts: number;
  /** Conservative per-attempt token ceiling, not an expected average. */
  readonly maximumUsagePerAttempt: BillableTokenUsage;
}

export interface LiveEvalPreflightInput {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly aiEnabled: boolean;
  readonly credentialsConfigured: boolean;
  readonly priceSnapshot: unknown;
  readonly plannedCalls: readonly LogicalCallBudget[];
}

export interface LiveEvalCallEstimate {
  readonly plannedSequence: number;
  readonly provider: AiProvider;
  readonly configuredModel: string;
  readonly maximumAttempts: number;
  readonly oneAttemptMaximumCostUsdMicros: number;
  readonly allAttemptsMaximumCostUsdMicros: number;
}

export interface LiveEvalBudgetEstimate {
  readonly limits: LiveEvalLimits;
  readonly priceSnapshot: AiPriceSnapshot;
  readonly plannedLogicalCalls: number;
  readonly plannedMaximumAttempts: number;
  readonly plannedMaximumCostUsdMicros: number;
  readonly withinLogicalCallCap: boolean;
  readonly withinProviderAttemptCap: boolean;
  readonly withinCostCap: boolean;
  readonly withinAllCaps: boolean;
  readonly calls: readonly LiveEvalCallEstimate[];
}

export interface LiveEvalPreflight extends LiveEvalBudgetEstimate {
  readonly enabled: true;
}

export interface EstimateLiveEvaluationBudgetInput {
  readonly limits: LiveEvalLimits;
  readonly priceSnapshot: unknown;
  readonly plannedCalls: readonly LogicalCallBudget[];
}

function parseExactBoolean(value: string | undefined, field: string): boolean {
  if (value === undefined) return false;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new EvalContractError('LIVE_EVAL_BLOCKED', `${field} must be exactly true or false.`);
}

function parsePositiveCap(
  value: string | undefined,
  fallback: number,
  hardMaximum: number,
  field: string,
): number {
  if (value === undefined) return fallback;
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new EvalContractError('LIVE_EVAL_BLOCKED', `${field} must be a positive integer.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > hardMaximum) {
    throw new EvalContractError('LIVE_EVAL_BLOCKED', `${field} exceeds its hard phase cap.`);
  }
  return parsed;
}

export function readLiveEvalLimits(
  env: Readonly<Record<string, string | undefined>>,
): LiveEvalLimits {
  const maxLogicalCalls = parsePositiveCap(
    env.AI_LIVE_EVAL_MAX_LOGICAL_CALLS,
    LIVE_EVAL_HARD_CAPS.logicalCalls,
    LIVE_EVAL_HARD_CAPS.logicalCalls,
    'AI_LIVE_EVAL_MAX_LOGICAL_CALLS',
  );
  const maxProviderAttempts = parsePositiveCap(
    env.AI_LIVE_EVAL_MAX_PROVIDER_ATTEMPTS,
    LIVE_EVAL_HARD_CAPS.providerAttempts,
    LIVE_EVAL_HARD_CAPS.providerAttempts,
    'AI_LIVE_EVAL_MAX_PROVIDER_ATTEMPTS',
  );
  const maxEstimatedCostUsdCents = parsePositiveCap(
    env.AI_LIVE_EVAL_MAX_ESTIMATED_COST_USD_CENTS,
    LIVE_EVAL_HARD_CAPS.estimatedCostUsdCents,
    LIVE_EVAL_HARD_CAPS.estimatedCostUsdCents,
    'AI_LIVE_EVAL_MAX_ESTIMATED_COST_USD_CENTS',
  );
  return {
    maxLogicalCalls,
    maxProviderAttempts,
    maxEstimatedCostUsdMicros: maxEstimatedCostUsdCents * USD_MICROS_PER_CENT,
  };
}

function estimateMaximumCallCost(
  snapshot: AiPriceSnapshot,
  call: LogicalCallBudget,
): { readonly oneAttemptUsdMicros: number; readonly allAttemptsUsdMicros: number } {
  if (!Number.isSafeInteger(call.maxAttempts) || call.maxAttempts < 1) {
    throw new EvalContractError(
      'LIVE_EVAL_BLOCKED',
      'Every planned logical call needs a positive integer attempt cap.',
    );
  }
  const price = findModelPrice(snapshot, call.provider, call.configuredModel);
  if (price === undefined) {
    throw new EvalContractError(
      'LIVE_EVAL_BLOCKED',
      'Unknown configured model pricing blocks live evaluation before the first call.',
    );
  }
  const oneAttempt = estimateCallCostUsdMicros(price, call.maximumUsagePerAttempt).usdMicros;
  return {
    oneAttemptUsdMicros: oneAttempt,
    allAttemptsUsdMicros: sumUsdMicros(Array.from({ length: call.maxAttempts }, () => oneAttempt)),
  };
}

function sumSafeIntegers(values: readonly number[], label: string): number {
  const total = values.reduce((sum, value) => {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new EvalContractError('LIVE_EVAL_BLOCKED', `${label} contains an invalid integer.`);
    }
    return sum + BigInt(value);
  }, 0n);
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new EvalContractError('LIVE_EVAL_BLOCKED', `${label} is too large.`);
  }
  return Number(total);
}

/**
 * Pure, credential-free budget estimation shared by the operator-only cost preflight and the
 * production live preflight. It calculates an over-cap plan completely so callers can report the
 * exact comparison; only the production authorization wrapper turns cap flags into a rejection.
 */
export function estimateLiveEvaluationBudget(
  input: EstimateLiveEvaluationBudgetInput,
): LiveEvalBudgetEstimate {
  const priceSnapshot = parseAiPriceSnapshot(input.priceSnapshot);
  const calls = input.plannedCalls.map((call, index): LiveEvalCallEstimate => {
    const estimate = estimateMaximumCallCost(priceSnapshot, call);
    return {
      plannedSequence: index + 1,
      provider: call.provider,
      configuredModel: call.configuredModel,
      maximumAttempts: call.maxAttempts,
      oneAttemptMaximumCostUsdMicros: estimate.oneAttemptUsdMicros,
      allAttemptsMaximumCostUsdMicros: estimate.allAttemptsUsdMicros,
    };
  });
  const plannedLogicalCalls = calls.length;
  const plannedMaximumAttempts = sumSafeIntegers(
    calls.map(({ maximumAttempts }) => maximumAttempts),
    'Live-eval planned attempts',
  );
  const plannedMaximumCostUsdMicros = sumUsdMicros(
    calls.map(({ allAttemptsMaximumCostUsdMicros }) => allAttemptsMaximumCostUsdMicros),
  );
  const withinLogicalCallCap =
    plannedLogicalCalls > 0 && plannedLogicalCalls <= input.limits.maxLogicalCalls;
  const withinProviderAttemptCap = plannedMaximumAttempts <= input.limits.maxProviderAttempts;
  const withinCostCap = plannedMaximumCostUsdMicros <= input.limits.maxEstimatedCostUsdMicros;
  return {
    limits: input.limits,
    priceSnapshot,
    plannedLogicalCalls,
    plannedMaximumAttempts,
    plannedMaximumCostUsdMicros,
    withinLogicalCallCap,
    withinProviderAttemptCap,
    withinCostCap,
    withinAllCaps: withinLogicalCallCap && withinProviderAttemptCap && withinCostCap,
    calls,
  };
}

export function assertLiveEvaluationBudgetWithinLimits(estimate: LiveEvalBudgetEstimate): void {
  if (!estimate.withinAllCaps) {
    throw new EvalContractError(
      'LIVE_EVAL_BLOCKED',
      'The conservative live-eval plan exceeds a configured phase cap.',
    );
  }
}

export function preflightLiveEvaluation(input: LiveEvalPreflightInput): LiveEvalPreflight {
  if (!parseExactBoolean(input.env.AI_LIVE_EVAL_ENABLED, 'AI_LIVE_EVAL_ENABLED')) {
    throw new EvalContractError(
      'LIVE_EVAL_BLOCKED',
      'Live evaluation is disabled by default and requires explicit opt-in.',
    );
  }
  if (!input.aiEnabled) {
    throw new EvalContractError(
      'LIVE_EVAL_BLOCKED',
      'The existing AI gateway opt-in is required for live evaluation.',
    );
  }
  if (!input.credentialsConfigured) {
    throw new EvalContractError(
      'LIVE_EVAL_BLOCKED',
      'Required provider credentials are not configured.',
    );
  }
  const limits = readLiveEvalLimits(input.env);
  const estimate = estimateLiveEvaluationBudget({
    limits,
    priceSnapshot: input.priceSnapshot,
    plannedCalls: input.plannedCalls,
  });
  assertLiveEvaluationBudgetWithinLimits(estimate);
  return { enabled: true, ...estimate };
}

export interface LiveCallReservation {
  readonly sequence: number;
  readonly maximumAttempts: number;
  readonly maximumCostUsdMicros: number;
}

export interface CompletedLiveCall {
  readonly reservation: LiveCallReservation;
  readonly attempts: number;
  /** Missing usage for a failed attempt is charged at the conservative per-attempt ceiling. */
  readonly attemptUsages: readonly BillableTokenUsage[];
}

export interface LiveEvalBudgetSnapshot {
  readonly logicalCallsStarted: number;
  readonly providerAttemptsCompleted: number;
  readonly estimatedCostUsdMicros: number;
  readonly activeReservation: boolean;
}

/** Sequential guard that reserves worst-case attempts and cost before each provider call. */
export class LiveEvalBudgetGuard {
  readonly #preflight: LiveEvalPreflight;
  #logicalCallsStarted = 0;
  #providerAttemptsCompleted = 0;
  #estimatedCostUsdMicros = 0;
  #active:
    | {
        readonly reservation: LiveCallReservation;
        readonly call: LogicalCallBudget;
        readonly oneAttemptMaximumCostUsdMicros: number;
      }
    | undefined;

  constructor(preflight: LiveEvalPreflight) {
    this.#preflight = preflight;
  }

  authorizeNextCall(call: LogicalCallBudget): LiveCallReservation {
    if (this.#active !== undefined) {
      throw new EvalContractError(
        'LIVE_EVAL_BLOCKED',
        'The previous live call must be settled before starting another.',
      );
    }
    const maximumCost = estimateMaximumCallCost(this.#preflight.priceSnapshot, call);
    const maximumCostUsdMicros = maximumCost.allAttemptsUsdMicros;
    const oneAttemptMaximumCostUsdMicros = maximumCost.oneAttemptUsdMicros;
    if (
      this.#logicalCallsStarted + 1 > this.#preflight.limits.maxLogicalCalls ||
      this.#providerAttemptsCompleted + call.maxAttempts >
        this.#preflight.limits.maxProviderAttempts ||
      this.#estimatedCostUsdMicros + maximumCostUsdMicros >
        this.#preflight.limits.maxEstimatedCostUsdMicros
    ) {
      throw new EvalContractError(
        'LIVE_EVAL_BLOCKED',
        'The next live call could exceed a cap and was blocked before provider execution.',
      );
    }
    const reservation = {
      sequence: this.#logicalCallsStarted + 1,
      maximumAttempts: call.maxAttempts,
      maximumCostUsdMicros,
    };
    this.#logicalCallsStarted += 1;
    this.#active = { reservation, call, oneAttemptMaximumCostUsdMicros };
    return reservation;
  }

  settleCall(completed: CompletedLiveCall): LiveEvalBudgetSnapshot {
    const active = this.#active;
    if (
      active === undefined ||
      completed.reservation !== active.reservation ||
      !Number.isSafeInteger(completed.attempts) ||
      completed.attempts < 1 ||
      completed.attempts > active.reservation.maximumAttempts ||
      completed.attemptUsages.length > completed.attempts
    ) {
      throw new EvalContractError(
        'LIVE_EVAL_BLOCKED',
        'A live-call settlement does not match its active reservation.',
      );
    }
    const price = findModelPrice(
      this.#preflight.priceSnapshot,
      active.call.provider,
      active.call.configuredModel,
    )!;
    const knownCosts = completed.attemptUsages.map((usage) => {
      const maximum = active.call.maximumUsagePerAttempt;
      if (
        usage.inputTokens > maximum.inputTokens ||
        usage.outputTokens > maximum.outputTokens ||
        usage.cacheReadTokens > maximum.cacheReadTokens ||
        usage.cacheWriteTokens > maximum.cacheWriteTokens ||
        usage.reasoningTokens > maximum.reasoningTokens
      ) {
        throw new EvalContractError(
          'LIVE_EVAL_BLOCKED',
          'Actual usage exceeded the conservative reservation.',
        );
      }
      return estimateCallCostUsdMicros(price, usage).usdMicros;
    });
    const unknownAttemptCount = completed.attempts - completed.attemptUsages.length;
    const actualCost = sumUsdMicros([
      ...knownCosts,
      ...Array.from({ length: unknownAttemptCount }, () => active.oneAttemptMaximumCostUsdMicros),
    ]);
    if (actualCost > active.reservation.maximumCostUsdMicros) {
      throw new EvalContractError(
        'LIVE_EVAL_BLOCKED',
        'Actual estimated cost exceeded the active reservation.',
      );
    }
    this.#providerAttemptsCompleted += completed.attempts;
    this.#estimatedCostUsdMicros += actualCost;
    this.#active = undefined;
    return this.snapshot();
  }

  snapshot(): LiveEvalBudgetSnapshot {
    return {
      logicalCallsStarted: this.#logicalCallsStarted,
      providerAttemptsCompleted: this.#providerAttemptsCompleted,
      estimatedCostUsdMicros: this.#estimatedCostUsdMicros,
      activeReservation: this.#active !== undefined,
    };
  }
}
