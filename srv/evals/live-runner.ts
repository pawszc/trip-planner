import type { AiConfig } from '../ai/config.ts';
import {
  canonicalizeJson,
  createInputFingerprint,
  isValidAiRunId,
  type AiCallResult,
  type AiUsage,
  type StructuredAiRequest,
} from '../ai/contracts.ts';
import { AI_ERROR_CODE_VALUES, AiError, type AiErrorCode } from '../ai/errors.ts';
import type {
  AiProviderIncompleteReason,
  AiProviderResponseStatus,
} from '../ai/failure-execution-evidence.ts';
import type { GroundedOptionContext } from '../narratives/grounded-option-context.ts';
import {
  createNarrativeJudgeRequest,
  parseNarrativeJudgeOutput,
  type NarrativeJudgeOutput,
  type NarrativeJudgeReasonCode,
} from '../narratives/narrative-judge.ts';
import type { NarrativeModelView } from '../narratives/narrative-model-view.ts';
import { buildNarrativePersistenceBundle } from '../narratives/narrative-persistence.ts';
import { decideNarrativePublication } from '../narratives/narrative-publication-policy.ts';
import type { NarrativeQualityContext } from '../narratives/narrative-quality-context.ts';
import {
  buildNarrativeReviewPublicationBundle,
  type NarrativeReviewAiRunExpectation,
  type NarrativeReviewDimensionResults,
} from '../narratives/narrative-review-persistence.ts';
import { runNarrativeSafetyPrecheck } from '../narratives/narrative-safety-precheck.ts';
import {
  parseOptionNarrativeOutput,
  type OptionNarrativeOutput,
} from '../narratives/option-narrative.ts';
import {
  EvalContractError,
  NARRATIVE_QUALITY_SENTINEL_CASE_IDS,
  loadNarrativeQualityDataset,
  resolveNarrativeQualityDataset,
  type NarrativeQualityDimension,
  type ResolvedNarrativeQualityDataset,
} from './dataset.ts';
import {
  LiveEvalBudgetGuard,
  preflightLiveEvaluation,
  type LiveCallReservation,
} from './live-guard.ts';
import {
  buildNarrativeLiveEvalQualityContext,
  prepareNarrativeQualityLiveEvalPlan,
  type NarrativeLiveEvalCallDescriptor,
  type NarrativeLiveEvalPass,
  type PreparedSemanticCase,
  type PreparedLivePlan,
} from './live-plan.ts';
import {
  summarizeNarrativeLiveEvalCostPreflight,
  type NarrativeLiveEvalCostPreflight,
} from './live-preflight.ts';
import type { EndToEndCaseOutcome, SemanticCaseOutcome } from './metrics.ts';
import type { AiPriceSnapshot, BillableTokenUsage } from './price-snapshot.ts';
import {
  NARRATIVE_EVAL_CONTRACT_VERSIONS,
  buildPrivacySafeEvalReport,
  type EvalOperationEvidence,
  type NarrativeEvalReport,
} from './report.ts';
import {
  NARRATIVE_E2E_REQUIRED_PROPERTY_CATALOG_VERSION,
  evaluateNarrativeE2eRequiredProperties,
} from './required-properties.ts';
import { resolveSyntheticNarrativeQualityFixture } from './synthetic-fixtures.ts';

export * from './live-plan.ts';

export interface NarrativeLiveEvalExecutorResult<TOutput> {
  readonly result: AiCallResult<TOutput>;
  /** A true value means the persistent gateway completed terminal SUCCEEDED audit. */
  readonly auditSucceeded: boolean;
}

export interface NarrativeLiveEvalExecutor {
  call<TOutput>(
    descriptor: NarrativeLiveEvalCallDescriptor<TOutput>,
  ): Promise<NarrativeLiveEvalExecutorResult<TOutput>>;
}

export type NarrativeLiveEvalPreflightSummary = NarrativeLiveEvalCostPreflight;

export interface RunNarrativeLiveEvaluationInput {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly config: AiConfig;
  readonly priceSnapshot: AiPriceSnapshot;
  readonly createExecutor: () => Promise<NarrativeLiveEvalExecutor>;
  readonly resolvedDataset?: ResolvedNarrativeQualityDataset;
  readonly onPreflight?: (summary: NarrativeLiveEvalPreflightSummary) => void;
}

export interface NarrativeLiveEvaluationResult {
  readonly preflight: NarrativeLiveEvalPreflightSummary;
  readonly primaryOutcomes: readonly SemanticCaseOutcome[];
  readonly repeatedSentinelOutcomes: readonly SemanticCaseOutcome[];
  readonly endToEndOutcomes: readonly EndToEndCaseOutcome[];
  readonly report: NarrativeEvalReport;
}

export interface SafeNarrativeLiveEvalFailure {
  readonly status: 'FAILED';
  readonly code:
    | AiErrorCode
    | EvalContractError['code']
    | 'LIVE_EVAL_EXECUTION_FAILED'
    | 'LIVE_EVAL_RUNNER_FAILED';
  readonly reportProduced: false;
  readonly providerCallMayHaveOccurred: boolean;
  readonly attemptAccountingComplete: boolean;
  readonly caseId?: string;
  readonly taskType?: 'GENERATE' | 'JUDGE';
  readonly logicalCallSequence?: number;
  readonly completedLogicalCalls?: number;
  readonly underlyingCode?: string;
  readonly provider?: 'OPENAI' | 'ANTHROPIC';
  readonly configuredModel?: string;
  readonly responseModel?: string;
  readonly providerResponseStatus?: AiProviderResponseStatus;
  readonly providerIncompleteReason?: AiProviderIncompleteReason;
  readonly attempts?: number;
  readonly usage?: Readonly<Required<AiUsage>>;
  readonly latencyMs?: number;
  readonly knownCumulativeProviderAttempts?: number;
  readonly knownCumulativeEstimatedCostUsdMicros?: number;
}

interface ValidatedExecution<TOutput> {
  readonly result: AiCallResult<TOutput>;
  readonly usage: BillableTokenUsage;
  readonly auditSucceeded: true;
}

const RESPONSE_MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u;
const PRECHECK_DIMENSION_BY_REASON = Object.freeze({
  MONEY_CALCULATION_OR_REFORMAT: 'MONEY_DATE_TIME_FIDELITY',
  UNTRUSTED_CONTENT_EXPOSED: 'SAFETY_INSTRUCTION_INTEGRITY',
  PII_OR_SECRET_EXPOSURE: 'SAFETY_INSTRUCTION_INTEGRITY',
} as const satisfies Partial<Record<NarrativeJudgeReasonCode, NarrativeQualityDimension>>);

function uniqueInOrder<T>(values: readonly T[]): readonly T[] {
  return [...new Set(values)];
}

function normalizeUsage(usage: AiUsage): BillableTokenUsage {
  const values = [
    usage.inputTokens,
    usage.outputTokens,
    usage.totalTokens,
    usage.cacheReadTokens ?? 0,
    usage.cacheWriteTokens ?? 0,
    usage.reasoningTokens ?? 0,
  ];
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new EvalContractError(
      'LIVE_EVAL_BLOCKED',
      'Provider usage metadata contains an invalid integer.',
    );
  }
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens ?? 0,
    cacheWriteTokens: usage.cacheWriteTokens ?? 0,
    reasoningTokens: usage.reasoningTokens ?? 0,
  };
}

function validateExecutionResult<TOutput>(
  descriptor: NarrativeLiveEvalCallDescriptor<TOutput>,
  execution: NarrativeLiveEvalExecutorResult<TOutput>,
): ValidatedExecution<TOutput> {
  const { result } = execution;
  if (
    execution.auditSucceeded !== true ||
    !isValidAiRunId(result.aiRunId) ||
    result.provider !== descriptor.profile.provider ||
    result.configuredModel !== descriptor.profile.model ||
    result.taskType !== descriptor.request.taskType ||
    result.promptVersion !== descriptor.request.promptVersion ||
    result.schemaVersion !== descriptor.request.schemaVersion ||
    result.inputFingerprint !== createInputFingerprint(descriptor.request.input) ||
    !RESPONSE_MODEL_PATTERN.test(result.responseModel) ||
    !Number.isSafeInteger(result.latencyMs) ||
    result.latencyMs < 0 ||
    !Number.isSafeInteger(result.attempts) ||
    result.attempts < 1 ||
    result.attempts > descriptor.budget.maxAttempts ||
    result.refusal.refused
  ) {
    throw new EvalContractError(
      'LIVE_EVAL_BLOCKED',
      'A live-eval result failed local metadata, audit, refusal, or profile validation.',
    );
  }
  const parsedOutput = descriptor.request.outputSchema.safeParse(result.output);
  if (!parsedOutput.success) {
    throw new EvalContractError(
      'LIVE_EVAL_BLOCKED',
      'A live-eval result failed strict local structured-output validation.',
    );
  }
  return {
    result: { ...result, output: parsedOutput.data },
    usage: normalizeUsage(result.usage),
    auditSucceeded: true,
  };
}

function underlyingFailureCode(error: unknown): string {
  if (error instanceof AiError || error instanceof EvalContractError) return error.code;
  if (typeof error !== 'object' || error === null) return 'UNKNOWN';
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/u.test(code) ? code : 'UNKNOWN';
}

export class NarrativeLiveEvalExecutionError extends Error {
  readonly code = 'LIVE_EVAL_EXECUTION_FAILED' as const;
  readonly caseId: string;
  readonly taskType: 'GENERATE' | 'JUDGE';
  readonly logicalCallSequence: number;
  readonly providerCallMayHaveOccurred: boolean;
  readonly underlyingCode: string;
  readonly completedLogicalCalls: number;
  readonly attemptAccountingComplete: boolean;
  readonly provider?: 'OPENAI' | 'ANTHROPIC';
  readonly configuredModel?: string;
  readonly responseModel?: string;
  readonly providerResponseStatus?: AiProviderResponseStatus;
  readonly providerIncompleteReason?: AiProviderIncompleteReason;
  readonly attempts?: number;
  readonly usage?: Readonly<Required<AiUsage>>;
  readonly latencyMs?: number;
  readonly knownCumulativeProviderAttempts: number;
  readonly knownCumulativeEstimatedCostUsdMicros: number;

  constructor(
    descriptor: NarrativeLiveEvalCallDescriptor<unknown>,
    logicalCallSequence: number,
    providerCallMayHaveOccurred: boolean,
    underlying: unknown,
    accounting: FailureAccounting,
  ) {
    super('Live evaluation stopped safely without a partial report.');
    this.name = 'NarrativeLiveEvalExecutionError';
    this.caseId = descriptor.caseId;
    this.taskType = descriptor.request.taskType as 'GENERATE' | 'JUDGE';
    this.logicalCallSequence = logicalCallSequence;
    this.providerCallMayHaveOccurred = providerCallMayHaveOccurred;
    this.underlyingCode = underlyingFailureCode(underlying);
    this.completedLogicalCalls = accounting.completedLogicalCalls;
    this.attemptAccountingComplete = accounting.attemptAccountingComplete;
    this.knownCumulativeProviderAttempts = accounting.knownCumulativeProviderAttempts;
    this.knownCumulativeEstimatedCostUsdMicros = accounting.knownCumulativeEstimatedCostUsdMicros;
    if (accounting.provider !== undefined) this.provider = accounting.provider;
    if (accounting.configuredModel !== undefined) {
      this.configuredModel = accounting.configuredModel;
    }
    if (accounting.responseModel !== undefined) this.responseModel = accounting.responseModel;
    if (accounting.providerResponseStatus !== undefined) {
      this.providerResponseStatus = accounting.providerResponseStatus;
    }
    if (accounting.providerIncompleteReason !== undefined) {
      this.providerIncompleteReason = accounting.providerIncompleteReason;
    }
    if (accounting.attempts !== undefined) this.attempts = accounting.attempts;
    if (accounting.usage !== undefined) this.usage = accounting.usage;
    if (accounting.latencyMs !== undefined) this.latencyMs = accounting.latencyMs;
  }
}

interface FailureAccounting {
  readonly completedLogicalCalls: number;
  readonly attemptAccountingComplete: boolean;
  readonly provider?: 'OPENAI' | 'ANTHROPIC';
  readonly configuredModel?: string;
  readonly responseModel?: string;
  readonly providerResponseStatus?: AiProviderResponseStatus;
  readonly providerIncompleteReason?: AiProviderIncompleteReason;
  readonly attempts?: number;
  readonly usage?: Readonly<Required<AiUsage>>;
  readonly latencyMs?: number;
  readonly knownCumulativeProviderAttempts: number;
  readonly knownCumulativeEstimatedCostUsdMicros: number;
}

function settleFailureAccounting(
  guard: LiveEvalBudgetGuard,
  descriptor: NarrativeLiveEvalCallDescriptor<unknown>,
  reservation: LiveCallReservation | undefined,
  error: unknown,
  completedLogicalCalls: number,
): FailureAccounting {
  const before = guard.snapshot();
  const evidence = error instanceof AiError ? error.executionEvidence : undefined;
  const common = {
    completedLogicalCalls,
    ...(evidence?.provider === undefined ? {} : { provider: evidence.provider }),
    ...(evidence?.configuredModel === undefined
      ? {}
      : { configuredModel: evidence.configuredModel }),
    ...(evidence?.responseModel === undefined ? {} : { responseModel: evidence.responseModel }),
    ...(evidence?.providerResponseStatus === undefined
      ? {}
      : { providerResponseStatus: evidence.providerResponseStatus }),
    ...(evidence?.providerIncompleteReason === undefined
      ? {}
      : { providerIncompleteReason: evidence.providerIncompleteReason }),
    ...(evidence?.attempts === undefined ? {} : { attempts: evidence.attempts }),
    ...(evidence?.usage === undefined ? {} : { usage: evidence.usage }),
    ...(evidence?.latencyMs === undefined ? {} : { latencyMs: evidence.latencyMs }),
  };
  if (reservation === undefined) {
    return {
      ...common,
      attemptAccountingComplete: true,
      knownCumulativeProviderAttempts: before.providerAttemptsCompleted,
      knownCumulativeEstimatedCostUsdMicros: before.estimatedCostUsdMicros,
    };
  }
  if (
    evidence === undefined ||
    evidence.provider !== descriptor.profile.provider ||
    evidence.configuredModel !== descriptor.profile.model ||
    evidence.attempts !== 1 ||
    evidence.usage === undefined
  ) {
    return {
      ...common,
      attemptAccountingComplete: false,
      knownCumulativeProviderAttempts: before.providerAttemptsCompleted,
      knownCumulativeEstimatedCostUsdMicros: before.estimatedCostUsdMicros,
    };
  }
  try {
    const usage = normalizeUsage(evidence.usage);
    const settled = guard.settleCall({ reservation, attempts: 1, attemptUsages: [usage] });
    return {
      ...common,
      attemptAccountingComplete: true,
      knownCumulativeProviderAttempts: settled.providerAttemptsCompleted,
      knownCumulativeEstimatedCostUsdMicros: settled.estimatedCostUsdMicros,
    };
  } catch {
    return {
      ...common,
      attemptAccountingComplete: false,
      knownCumulativeProviderAttempts: before.providerAttemptsCompleted,
      knownCumulativeEstimatedCostUsdMicros: before.estimatedCostUsdMicros,
    };
  }
}

export function toSafeNarrativeLiveEvalFailure(error: unknown): SafeNarrativeLiveEvalFailure {
  if (error instanceof NarrativeLiveEvalExecutionError) {
    return {
      status: 'FAILED',
      code: error.code,
      reportProduced: false,
      providerCallMayHaveOccurred: error.providerCallMayHaveOccurred,
      attemptAccountingComplete: error.attemptAccountingComplete,
      caseId: error.caseId,
      taskType: error.taskType,
      logicalCallSequence: error.logicalCallSequence,
      completedLogicalCalls: error.completedLogicalCalls,
      underlyingCode: error.underlyingCode,
      ...(error.provider === undefined ? {} : { provider: error.provider }),
      ...(error.configuredModel === undefined ? {} : { configuredModel: error.configuredModel }),
      ...(error.responseModel === undefined ? {} : { responseModel: error.responseModel }),
      ...(error.providerResponseStatus === undefined
        ? {}
        : { providerResponseStatus: error.providerResponseStatus }),
      ...(error.providerIncompleteReason === undefined
        ? {}
        : { providerIncompleteReason: error.providerIncompleteReason }),
      ...(error.attempts === undefined ? {} : { attempts: error.attempts }),
      ...(error.usage === undefined ? {} : { usage: error.usage }),
      ...(error.latencyMs === undefined ? {} : { latencyMs: error.latencyMs }),
      knownCumulativeProviderAttempts: error.knownCumulativeProviderAttempts,
      knownCumulativeEstimatedCostUsdMicros: error.knownCumulativeEstimatedCostUsdMicros,
    };
  }
  if (error instanceof EvalContractError) {
    return {
      status: 'FAILED',
      code: error.code,
      reportProduced: false,
      providerCallMayHaveOccurred: false,
      attemptAccountingComplete: true,
    };
  }
  if (error instanceof AiError) {
    return {
      status: 'FAILED',
      code: error.code,
      reportProduced: false,
      providerCallMayHaveOccurred: false,
      attemptAccountingComplete: true,
    };
  }
  const candidateCode = underlyingFailureCode(error);
  return {
    status: 'FAILED',
    code: AI_ERROR_CODE_VALUES.includes(candidateCode as AiErrorCode)
      ? (candidateCode as AiErrorCode)
      : 'LIVE_EVAL_RUNNER_FAILED',
    reportProduced: false,
    providerCallMayHaveOccurred: false,
    attemptAccountingComplete: true,
  };
}

function precheckOutcome(prepared: PreparedSemanticCase): SemanticCaseOutcome {
  if (prepared.precheck.passed) {
    throw new EvalContractError('INVALID_EVAL_INPUT', 'A passing precheck has no reject outcome.');
  }
  const reasonCodes = uniqueInOrder(prepared.precheck.findings.map(({ reasonCode }) => reasonCode));
  const failedDimensions = uniqueInOrder(
    reasonCodes.map((reasonCode) => {
      const dimension =
        PRECHECK_DIMENSION_BY_REASON[reasonCode as keyof typeof PRECHECK_DIMENSION_BY_REASON];
      if (dimension === undefined) {
        throw new EvalContractError(
          'INVALID_EVAL_INPUT',
          'The deterministic precheck returned a reason outside its dimension convention.',
        );
      }
      return dimension;
    }),
  );
  return {
    caseId: prepared.qualityCase.authored.id,
    actualDecision: 'REJECT',
    actualStage: 'PRECHECK',
    failedDimensions,
    reasonCodes,
    strictJudgeOutputValid: null,
  };
}

function judgeOutcome(caseId: string, output: NarrativeJudgeOutput): SemanticCaseOutcome {
  return {
    caseId,
    actualDecision: decideNarrativePublication(output),
    actualStage: 'JUDGE',
    failedDimensions: output.dimensions
      .filter(({ status }) => status === 'FAIL')
      .map(({ dimension }) => dimension),
    reasonCodes: uniqueInOrder(output.findings.map(({ reasonCode }) => reasonCode)),
    strictJudgeOutputValid: true,
  };
}

function reviewDimensions(output: NarrativeJudgeOutput): NarrativeReviewDimensionResults {
  return Object.fromEntries(
    output.dimensions.map(({ dimension, status }) => [dimension, status]),
  ) as unknown as NarrativeReviewDimensionResults;
}

function succeededAudit(
  result: AiCallResult<unknown>,
  context: GroundedOptionContext,
): NarrativeReviewAiRunExpectation {
  return {
    ID: result.aiRunId,
    planningRun_ID: context.planningRun.id,
    status: 'SUCCEEDED',
    taskType: result.taskType as 'GENERATE' | 'JUDGE',
    promptVersion: result.promptVersion,
    schemaVersion: result.schemaVersion,
    inputFingerprint: result.inputFingerprint,
  };
}

function validatePublicationBundleLinkageInMemory(input: {
  readonly context: GroundedOptionContext;
  readonly modelView: NarrativeModelView;
  readonly candidate: OptionNarrativeOutput;
  readonly qualityContext: NarrativeQualityContext;
  readonly judgeOutput: NarrativeJudgeOutput;
  readonly generateResult: AiCallResult<OptionNarrativeOutput>;
  readonly judgeResult: AiCallResult<NarrativeJudgeOutput>;
}): boolean {
  try {
    const completedAt = '2000-01-01T00:00:00.000Z';
    const generateAudit = succeededAudit(input.generateResult, input.context);
    const judgeAudit = succeededAudit(input.judgeResult, input.context);
    const narrativeBundle = buildNarrativePersistenceBundle({
      context: input.context,
      modelView: input.modelView,
      output: input.candidate,
      aiRunId: input.generateResult.aiRunId,
      completedAt,
    });
    const publicationBundle = buildNarrativeReviewPublicationBundle({
      planningRunId: input.context.planningRun.id,
      rankedOptionId: input.context.rankedOption.id,
      generateAudit,
      judgeAiRunId: judgeAudit.ID,
      judgeAudit,
      contextFingerprint: input.context.fingerprint,
      modelViewFingerprint: input.modelView.fingerprint,
      narrativeFingerprint: input.qualityContext.narrativeFingerprint,
      qualityContextFingerprint: input.qualityContext.fingerprint,
      versions: NARRATIVE_EVAL_CONTRACT_VERSIONS,
      dimensions: reviewDimensions(input.judgeOutput),
      narrativeBundle,
      completedAt,
    });
    return (
      publicationBundle.expectedGenerateAiRun.ID === input.generateResult.aiRunId &&
      publicationBundle.expectedJudgeAiRun.ID === input.judgeResult.aiRunId &&
      publicationBundle.narrativeRun.contextFingerprint === input.context.fingerprint &&
      publicationBundle.narrativeRun.narrativeFingerprint ===
        input.qualityContext.narrativeFingerprint &&
      publicationBundle.narrativeRun.qualityContextFingerprint === input.qualityContext.fingerprint
    );
  } catch {
    return false;
  }
}

function findCall<TOutput>(
  plan: PreparedLivePlan,
  caseId: string,
  pass: NarrativeLiveEvalPass,
): NarrativeLiveEvalCallDescriptor<TOutput> {
  const descriptor = plan.calls.find(
    (candidate) => candidate.caseId === caseId && candidate.pass === pass,
  );
  if (descriptor === undefined) {
    throw new EvalContractError('INVALID_EVAL_INPUT', 'The live-eval call plan is incomplete.');
  }
  return descriptor as NarrativeLiveEvalCallDescriptor<TOutput>;
}

/**
 * Executes only after the complete synthetic plan passes opt-in, credential, price and cap
 * preflight. Retry remains zero. A terminal failure settles its active reservation only when the
 * thrown error carries a complete, validated one-attempt usage record for the exact profile. Every
 * failure stops the run before the next call and never emits a partial report.
 */
export async function runNarrativeQualityLiveEvaluation(
  input: RunNarrativeLiveEvaluationInput,
): Promise<NarrativeLiveEvaluationResult> {
  const resolvedDataset =
    input.resolvedDataset ??
    resolveNarrativeQualityDataset(
      loadNarrativeQualityDataset(),
      resolveSyntheticNarrativeQualityFixture,
    );
  const plan = prepareNarrativeQualityLiveEvalPlan(resolvedDataset, input.config);
  const requiredProviders = new Set(plan.calls.map(({ profile }) => profile.provider));
  const credentialsConfigured = [...requiredProviders].every(
    (provider) => input.config.providers[provider].apiKey !== undefined,
  );
  const preflight = preflightLiveEvaluation({
    env: input.env,
    aiEnabled: input.config.enabled,
    credentialsConfigured,
    priceSnapshot: input.priceSnapshot,
    plannedCalls: plan.calls.map(({ budget }) => budget),
  });
  if (input.config.maxRetries !== 0) {
    throw new EvalContractError(
      'LIVE_EVAL_BLOCKED',
      'Live eval requires the phase contract of zero provider retries.',
    );
  }
  const preflightSummary = summarizeNarrativeLiveEvalCostPreflight(
    plan,
    preflight,
    input.config.maxRetries,
  );
  input.onPreflight?.(preflightSummary);

  // This factory is deliberately after every preflight check. Production may connect CAP and
  // construct SDK clients here; blocked runs never touch the database or either provider.
  const executor = await input.createExecutor();
  const guard = new LiveEvalBudgetGuard(preflight);
  const operations: EvalOperationEvidence[] = [];
  const responseModelsByProfile = new Map<string, string>();

  const execute = async <TOutput>(
    descriptor: NarrativeLiveEvalCallDescriptor<TOutput>,
    actualRequest: StructuredAiRequest<TOutput> = descriptor.request,
  ): Promise<ValidatedExecution<TOutput>> => {
    const actualDescriptor =
      actualRequest === descriptor.request ? descriptor : { ...descriptor, request: actualRequest };
    let logicalCallSequence = guard.snapshot().logicalCallsStarted + 1;
    let providerCallMayHaveOccurred = false;
    let reservation: LiveCallReservation | undefined;
    try {
      reservation = guard.authorizeNextCall(actualDescriptor.budget);
      logicalCallSequence = reservation.sequence;
      providerCallMayHaveOccurred = true;
      const execution = await executor.call(actualDescriptor);
      const validated = validateExecutionResult(actualDescriptor, execution);
      const profileKey = `${validated.result.taskType}:${validated.result.provider}:${validated.result.configuredModel}`;
      const previousResponseModel = responseModelsByProfile.get(profileKey);
      if (
        previousResponseModel !== undefined &&
        previousResponseModel !== validated.result.responseModel
      ) {
        throw new EvalContractError(
          'LIVE_EVAL_BLOCKED',
          'A configured profile returned multiple response-model identities.',
        );
      }
      responseModelsByProfile.set(profileKey, validated.result.responseModel);
      const beforeCost = guard.snapshot().estimatedCostUsdMicros;
      const settled = guard.settleCall({
        reservation,
        attempts: validated.result.attempts,
        attemptUsages: [validated.usage],
      });
      operations.push({
        logicalCallSequence: reservation.sequence,
        caseId: actualDescriptor.caseId,
        taskType: validated.result.taskType as 'GENERATE' | 'JUDGE',
        provider: validated.result.provider,
        configuredModel: validated.result.configuredModel,
        responseModel: validated.result.responseModel,
        configuredEffort: actualDescriptor.profile.effort,
        configuredMaxOutputTokens: actualDescriptor.profile.maxOutputTokens,
        inputTokens: validated.usage.inputTokens,
        outputTokens: validated.usage.outputTokens,
        cacheReadTokens: validated.usage.cacheReadTokens,
        cacheWriteTokens: validated.usage.cacheWriteTokens,
        reasoningTokens: validated.usage.reasoningTokens,
        latencyMs: validated.result.latencyMs,
        attempts: validated.result.attempts,
        refused: false,
        refusalCategory: null,
        estimatedCostUsdMicros: settled.estimatedCostUsdMicros - beforeCost,
      });
      return validated;
    } catch (error) {
      throw new NarrativeLiveEvalExecutionError(
        actualDescriptor as NarrativeLiveEvalCallDescriptor<unknown>,
        logicalCallSequence,
        providerCallMayHaveOccurred,
        error,
        settleFailureAccounting(
          guard,
          actualDescriptor as NarrativeLiveEvalCallDescriptor<unknown>,
          reservation,
          error,
          operations.length,
        ),
      );
    }
  };

  const primaryOutcomes: SemanticCaseOutcome[] = [];
  for (const prepared of plan.semanticCases) {
    const caseId = prepared.qualityCase.authored.id;
    if (!prepared.precheck.passed) {
      primaryOutcomes.push(precheckOutcome(prepared));
      continue;
    }
    const qualityContext = prepared.qualityContext!;
    const descriptor = findCall<NarrativeJudgeOutput>(plan, caseId, 'PRIMARY');
    const execution = await execute(descriptor);
    const output = parseNarrativeJudgeOutput(execution.result.output, qualityContext);
    primaryOutcomes.push(judgeOutcome(caseId, output));
  }

  const semanticById = new Map(
    plan.semanticCases.map((prepared) => [prepared.qualityCase.authored.id, prepared]),
  );
  const repeatedSentinelOutcomes: SemanticCaseOutcome[] = [];
  for (const caseId of NARRATIVE_QUALITY_SENTINEL_CASE_IDS) {
    const prepared = semanticById.get(caseId)!;
    const descriptor = findCall<NarrativeJudgeOutput>(plan, caseId, 'STABILITY_REPEAT');
    const execution = await execute(descriptor);
    const output = parseNarrativeJudgeOutput(execution.result.output, prepared.qualityContext!);
    repeatedSentinelOutcomes.push(judgeOutcome(caseId, output));
  }

  const endToEndOutcomes: EndToEndCaseOutcome[] = [];
  for (const prepared of plan.endToEndCases) {
    const caseId = prepared.qualityCase.authored.id;
    const context = prepared.qualityCase.groundedContext;
    const initialDeterministicState = canonicalizeJson(context);
    const generateDescriptor = findCall<OptionNarrativeOutput>(plan, caseId, 'END_TO_END_GENERATE');
    const generated = await execute(generateDescriptor);
    const candidate = parseOptionNarrativeOutput(generated.result.output, context);
    const requiredPropertyResults = evaluateNarrativeE2eRequiredProperties({
      caseId,
      requiredPropertyIds: prepared.qualityCase.authored.requiredProperties,
      candidate,
      context,
      modelView: prepared.modelView,
      constraints: prepared.constraints,
    });
    const precheck = runNarrativeSafetyPrecheck({
      context,
      modelView: prepared.modelView,
      narrativeOutput: candidate,
    });
    if (!precheck.passed) {
      endToEndOutcomes.push({
        caseId,
        generateLogicalCalls: 1,
        judgeLogicalCalls: 0,
        generatedSchemaValid: true,
        exactReferencesValid: true,
        actualDecision: 'REJECT',
        requiredPropertyCatalogVersion: NARRATIVE_E2E_REQUIRED_PROPERTY_CATALOG_VERSION,
        requiredPropertyResults,
        generateAuditSucceeded: generated.auditSucceeded,
        judgeAuditSucceeded: false,
        publicationBundleLinkageValidInMemory: false,
        deterministicStateUnchanged: canonicalizeJson(context) === initialDeterministicState,
      });
      continue;
    }

    const qualityContext = buildNarrativeLiveEvalQualityContext(
      context,
      prepared.modelView,
      candidate,
      prepared.constraints,
    );
    const judgeRequest = createNarrativeJudgeRequest(qualityContext);
    const judgeDescriptor = findCall<NarrativeJudgeOutput>(plan, caseId, 'END_TO_END_JUDGE');
    const judged = await execute(judgeDescriptor, judgeRequest);
    const judgeOutput = parseNarrativeJudgeOutput(judged.result.output, qualityContext);
    const actualDecision = decideNarrativePublication(judgeOutput);
    const publicationBundleLinkageValidInMemory =
      actualDecision === 'PUBLISH' &&
      validatePublicationBundleLinkageInMemory({
        context,
        modelView: prepared.modelView,
        candidate,
        qualityContext,
        judgeOutput,
        generateResult: generated.result,
        judgeResult: judged.result,
      });
    endToEndOutcomes.push({
      caseId,
      generateLogicalCalls: 1,
      judgeLogicalCalls: 1,
      generatedSchemaValid: true,
      exactReferencesValid: true,
      actualDecision,
      requiredPropertyCatalogVersion: NARRATIVE_E2E_REQUIRED_PROPERTY_CATALOG_VERSION,
      requiredPropertyResults,
      generateAuditSucceeded: generated.auditSucceeded,
      judgeAuditSucceeded: judged.auditSucceeded,
      publicationBundleLinkageValidInMemory,
      deterministicStateUnchanged: canonicalizeJson(context) === initialDeterministicState,
    });
  }

  const report = buildPrivacySafeEvalReport({
    dataset: plan.resolvedDataset.dataset,
    versions: NARRATIVE_EVAL_CONTRACT_VERSIONS,
    outcomes: primaryOutcomes,
    repeatedSentinelOutcomes,
    endToEndOutcomes,
    operations,
  });
  return {
    preflight: preflightSummary,
    primaryOutcomes,
    repeatedSentinelOutcomes,
    endToEndOutcomes,
    report,
  };
}
