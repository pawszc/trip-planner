import { z } from 'zod';
import type { AiConfig } from '../ai/config.ts';
import { AiTaskType, createInputFingerprint, type JsonValue } from '../ai/contracts.ts';
import {
  EvalContractError,
  loadNarrativeQualityDataset,
  resolveNarrativeQualityDataset,
  type ResolvedNarrativeQualityDataset,
} from './dataset.ts';
import {
  estimateLiveEvaluationBudget,
  readLiveEvalLimits,
  type LiveEvalBudgetEstimate,
  type LiveEvalLimits,
} from './live-guard.ts';
import {
  prepareNarrativeQualityLiveEvalPlan,
  type NarrativeLiveEvalSafePlan,
  type PreparedLivePlan,
} from './live-plan.ts';
import { formatUsdMicrosDecimal, sumUsdMicros, type AiPriceSnapshot } from './price-snapshot.ts';
import { NARRATIVE_EVAL_CONTRACT_VERSIONS } from './report.ts';
import { resolveSyntheticNarrativeQualityFixture } from './synthetic-fixtures.ts';

export interface NarrativeLiveEvalProfileCostCeiling {
  readonly provider: 'OPENAI' | 'ANTHROPIC';
  readonly configuredModel: string;
  readonly effort: AiConfig['taskProfiles']['GENERATE']['effort'];
  readonly maxOutputTokens: number;
  readonly minimumInputTokensPerAttempt: number;
  readonly maximumInputTokensPerAttempt: number;
  readonly maximumOutputTokensPerAttempt: number;
}

export interface NarrativeLiveEvalCostTotal {
  readonly plannedCalls: number;
  readonly plannedMaximumCostUsdMicros: number;
  readonly plannedMaximumCostUsd: string;
}

export interface NarrativeLiveEvalProviderModelCost extends NarrativeLiveEvalCostTotal {
  readonly provider: 'OPENAI' | 'ANTHROPIC';
  readonly configuredModel: string;
}

export interface NarrativeLiveEvalCostBreakdown {
  readonly generate: NarrativeLiveEvalCostTotal;
  readonly judge: NarrativeLiveEvalCostTotal;
  readonly byProviderModel: readonly NarrativeLiveEvalProviderModelCost[];
}

export interface NarrativeLiveEvalCostPreflight {
  readonly plan: NarrativeLiveEvalSafePlan;
  readonly workloadFingerprint: string;
  readonly limits: LiveEvalLimits;
  readonly priceCatalogVersion: string;
  readonly pricingVerifiedAt: string;
  readonly plannedGenerateCalls: number;
  readonly plannedJudgeCalls: number;
  readonly plannedMaximumCostUsdMicros: number;
  readonly plannedMaximumCostUsd: string;
  readonly maxRetries: number;
  readonly profiles: {
    readonly generate: NarrativeLiveEvalProfileCostCeiling;
    readonly judge: NarrativeLiveEvalProfileCostCeiling;
  };
  readonly configuredCostCapUsdMicros: number;
  readonly configuredCostCapUsd: string;
  readonly withinLogicalCallCap: boolean;
  readonly withinProviderAttemptCap: boolean;
  readonly withinCostCap: boolean;
  readonly withinAllCaps: boolean;
  readonly costBreakdown: NarrativeLiveEvalCostBreakdown;
}

export interface BuildNarrativeLiveEvalCostPreflightInput {
  readonly config: AiConfig;
  readonly priceSnapshot: AiPriceSnapshot;
  readonly limits?: LiveEvalLimits;
  readonly resolvedDataset?: ResolvedNarrativeQualityDataset;
}

function sumCosts(costs: readonly number[]): number {
  return sumUsdMicros(costs);
}

function costTotal(costs: readonly number[]): NarrativeLiveEvalCostTotal {
  const plannedMaximumCostUsdMicros = sumCosts(costs);
  return {
    plannedCalls: costs.length,
    plannedMaximumCostUsdMicros,
    plannedMaximumCostUsd: formatUsdMicrosDecimal(plannedMaximumCostUsdMicros),
  };
}

function workloadFingerprint(plan: PreparedLivePlan): string {
  const calls = plan.calls.map((call) => {
    let outputSchema: unknown;
    try {
      outputSchema = z.toJSONSchema(call.request.outputSchema);
    } catch {
      throw new EvalContractError(
        'INVALID_EVAL_INPUT',
        'A live-eval output schema cannot be fingerprinted for cost preflight.',
      );
    }
    return {
      plannedSequence: call.plannedSequence,
      caseId: call.caseId,
      pass: call.pass,
      taskType: call.request.taskType,
      promptVersion: call.request.promptVersion,
      schemaVersion: call.request.schemaVersion,
      schemaName: call.request.schemaName,
      instructionsFingerprint: createInputFingerprint({ value: call.request.instructions }),
      inputFingerprint: createInputFingerprint(call.request.input),
      outputSchemaFingerprint: createInputFingerprint(outputSchema as JsonValue),
      maximumInputTokensPerAttempt: call.budget.maximumUsagePerAttempt.inputTokens / 3,
      maximumOutputTokensPerAttempt: call.budget.maximumUsagePerAttempt.outputTokens / 2,
    };
  });
  return createInputFingerprint({ versions: NARRATIVE_EVAL_CONTRACT_VERSIONS, calls });
}

function profileSummary(
  plan: PreparedLivePlan,
  taskType: 'GENERATE' | 'JUDGE',
): NarrativeLiveEvalProfileCostCeiling {
  const calls = plan.safe.calls.filter((call) => call.taskType === taskType);
  const first = calls[0];
  if (
    first === undefined ||
    calls.some(
      (call) =>
        call.provider !== first.provider ||
        call.configuredModel !== first.configuredModel ||
        call.configuredEffort !== first.configuredEffort ||
        call.configuredMaxOutputTokens !== first.configuredMaxOutputTokens,
    )
  ) {
    throw new EvalContractError(
      'INVALID_EVAL_INPUT',
      `The ${taskType} cost preflight requires one exact configured profile.`,
    );
  }
  return {
    provider: first.provider,
    configuredModel: first.configuredModel,
    effort: first.configuredEffort,
    maxOutputTokens: first.configuredMaxOutputTokens,
    minimumInputTokensPerAttempt: Math.min(
      ...calls.map(({ maximumInputTokensPerAttempt }) => maximumInputTokensPerAttempt),
    ),
    maximumInputTokensPerAttempt: Math.max(
      ...calls.map(({ maximumInputTokensPerAttempt }) => maximumInputTokensPerAttempt),
    ),
    maximumOutputTokensPerAttempt: Math.max(
      ...calls.map(({ maximumOutputTokensPerAttempt }) => maximumOutputTokensPerAttempt),
    ),
  };
}

function buildCostBreakdown(
  plan: PreparedLivePlan,
  estimate: LiveEvalBudgetEstimate,
): NarrativeLiveEvalCostBreakdown {
  if (
    plan.calls.length !== estimate.calls.length ||
    plan.calls.some((call, index) => {
      const estimated = estimate.calls[index];
      return (
        estimated === undefined ||
        estimated.plannedSequence !== call.plannedSequence ||
        estimated.provider !== call.profile.provider ||
        estimated.configuredModel !== call.profile.model
      );
    })
  ) {
    throw new EvalContractError(
      'INVALID_EVAL_INPUT',
      'The live-eval cost lines do not match the frozen logical-call plan.',
    );
  }

  const generateCosts: number[] = [];
  const judgeCosts: number[] = [];
  const byModel = new Map<
    string,
    { provider: 'OPENAI' | 'ANTHROPIC'; configuredModel: string; costs: number[] }
  >();
  plan.calls.forEach((call, index) => {
    const cost = estimate.calls[index]!.allAttemptsMaximumCostUsdMicros;
    if (call.request.taskType === AiTaskType.GENERATE) generateCosts.push(cost);
    else if (call.request.taskType === AiTaskType.JUDGE) judgeCosts.push(cost);
    else {
      throw new EvalContractError(
        'INVALID_EVAL_INPUT',
        'The live-eval cost plan contains an unsupported task.',
      );
    }
    const key = `${call.profile.provider}:${call.profile.model}`;
    const current = byModel.get(key) ?? {
      provider: call.profile.provider,
      configuredModel: call.profile.model,
      costs: [],
    };
    current.costs.push(cost);
    byModel.set(key, current);
  });

  return {
    generate: costTotal(generateCosts),
    judge: costTotal(judgeCosts),
    byProviderModel: [...byModel.values()].map(({ provider, configuredModel, costs }) => ({
      provider,
      configuredModel,
      ...costTotal(costs),
    })),
  };
}

export function summarizeNarrativeLiveEvalCostPreflight(
  plan: PreparedLivePlan,
  estimate: LiveEvalBudgetEstimate,
  maxRetries: number,
): NarrativeLiveEvalCostPreflight {
  const costBreakdown = buildCostBreakdown(plan, estimate);
  return {
    plan: plan.safe,
    workloadFingerprint: workloadFingerprint(plan),
    limits: estimate.limits,
    priceCatalogVersion: estimate.priceSnapshot.priceCatalogVersion,
    pricingVerifiedAt: estimate.priceSnapshot.pricingVerifiedAt,
    plannedGenerateCalls: costBreakdown.generate.plannedCalls,
    plannedJudgeCalls: costBreakdown.judge.plannedCalls,
    plannedMaximumCostUsdMicros: estimate.plannedMaximumCostUsdMicros,
    plannedMaximumCostUsd: formatUsdMicrosDecimal(estimate.plannedMaximumCostUsdMicros),
    maxRetries,
    profiles: {
      generate: profileSummary(plan, AiTaskType.GENERATE),
      judge: profileSummary(plan, AiTaskType.JUDGE),
    },
    configuredCostCapUsdMicros: estimate.limits.maxEstimatedCostUsdMicros,
    configuredCostCapUsd: formatUsdMicrosDecimal(estimate.limits.maxEstimatedCostUsdMicros),
    withinLogicalCallCap: estimate.withinLogicalCallCap,
    withinProviderAttemptCap: estimate.withinProviderAttemptCap,
    withinCostCap: estimate.withinCostCap,
    withinAllCaps: estimate.withinAllCaps,
    costBreakdown,
  };
}

/** Pure cost preflight: no opt-ins, credentials, executor, adapter, gateway, database or network. */
export function buildNarrativeLiveEvalCostPreflight(
  input: BuildNarrativeLiveEvalCostPreflightInput,
): NarrativeLiveEvalCostPreflight {
  const resolvedDataset =
    input.resolvedDataset ??
    resolveNarrativeQualityDataset(
      loadNarrativeQualityDataset(),
      resolveSyntheticNarrativeQualityFixture,
    );
  const plan = prepareNarrativeQualityLiveEvalPlan(resolvedDataset, input.config);
  const estimate = estimateLiveEvaluationBudget({
    limits: input.limits ?? readLiveEvalLimits({}),
    priceSnapshot: input.priceSnapshot,
    plannedCalls: plan.calls.map(({ budget }) => budget),
  });
  return summarizeNarrativeLiveEvalCostPreflight(plan, estimate, input.config.maxRetries);
}
