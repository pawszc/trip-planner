import { z } from 'zod';
import type { AiConfig } from '../ai/config.ts';
import {
  AiTaskType,
  canonicalizeJson,
  createInputFingerprint,
  isValidAiRunId,
  type AiCallResult,
  type AiExecutionProfile,
  type AiUsage,
  type StructuredAiRequest,
} from '../ai/contracts.ts';
import { AI_ERROR_CODE_VALUES, AiError, type AiErrorCode } from '../ai/errors.ts';
import type { GroundedOptionContext } from '../narratives/grounded-option-context.ts';
import {
  createNarrativeJudgeRequest,
  parseNarrativeJudgeOutput,
  type NarrativeJudgeOutput,
  type NarrativeJudgeReasonCode,
} from '../narratives/narrative-judge.ts';
import {
  buildNarrativeModelView,
  type NarrativeModelView,
} from '../narratives/narrative-model-view.ts';
import { buildNarrativePersistenceBundle } from '../narratives/narrative-persistence.ts';
import { decideNarrativePublication } from '../narratives/narrative-publication-policy.ts';
import {
  buildNarrativeQualityContext,
  NARRATIVE_QUALITY_CONTEXT_MAX_BYTES,
  type NarrativeConstraintSnapshot,
  type NarrativeQualityContext,
} from '../narratives/narrative-quality-context.ts';
import {
  buildNarrativeReviewPublicationBundle,
  type NarrativeReviewAiRunExpectation,
  type NarrativeReviewDimensionResults,
} from '../narratives/narrative-review-persistence.ts';
import { runNarrativeSafetyPrecheck } from '../narratives/narrative-safety-precheck.ts';
import {
  createOptionNarrativeRequest,
  parseOptionNarrativeOutput,
  type OptionNarrativeOutput,
} from '../narratives/option-narrative.ts';
import {
  EvalContractError,
  NARRATIVE_QUALITY_PRECHECK_CASE_IDS,
  NARRATIVE_QUALITY_SENTINEL_CASE_IDS,
  loadNarrativeQualityDataset,
  resolveNarrativeQualityDataset,
  type NarrativeQualityDimension,
  type NarrativeQualityAuthoringContext,
  type ResolvedNarrativeQualityCase,
  type ResolvedNarrativeQualityDataset,
  type ResolvedNarrativeQualityEndToEndCase,
} from './dataset.ts';
import {
  LiveEvalBudgetGuard,
  preflightLiveEvaluation,
  type LiveEvalPreflight,
  type LogicalCallBudget,
} from './live-guard.ts';
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
import {
  buildSyntheticNarrativeConstraintSnapshot,
  resolveSyntheticNarrativeQualityFixture,
} from './synthetic-fixtures.ts';

export const NARRATIVE_LIVE_EVAL_PLAN_VERSION = 'narrative-quality-live-plan-v1';
export const NARRATIVE_LIVE_EVAL_TOKEN_CEILING_VERSION =
  'utf8-wire-bytes-plus-4096-protocol-tokens-v1';
export const NARRATIVE_LIVE_EVAL_COST_CEILING_VERSION = 'full-ceiling-each-token-class-v1';
export const NARRATIVE_LIVE_EVAL_RETRY_POLICY_VERSION =
  'zero-retry-until-failure-attempt-metadata-v1';

export const NARRATIVE_LIVE_EVAL_EXPECTED_LOGICAL_CALLS = 46;
export const NARRATIVE_LIVE_EVAL_EXPECTED_JUDGE_CALLS = 42;
export const NARRATIVE_LIVE_EVAL_EXPECTED_GENERATE_CALLS = 4;
export const NARRATIVE_LIVE_EVAL_PROTOCOL_TOKEN_RESERVE = 4_096;

export type NarrativeLiveEvalPass =
  'PRIMARY' | 'STABILITY_REPEAT' | 'END_TO_END_GENERATE' | 'END_TO_END_JUDGE';

export interface NarrativeLiveEvalCallDescriptor<TOutput> {
  readonly plannedSequence: number;
  readonly caseId: string;
  readonly pass: NarrativeLiveEvalPass;
  readonly request: StructuredAiRequest<TOutput>;
  readonly profile: AiExecutionProfile;
  readonly budget: LogicalCallBudget;
}

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

export interface NarrativeLiveEvalSafePlannedCall {
  readonly plannedSequence: number;
  readonly caseId: string;
  readonly pass: NarrativeLiveEvalPass;
  readonly taskType: 'GENERATE' | 'JUDGE';
  readonly provider: 'OPENAI' | 'ANTHROPIC';
  readonly configuredModel: string;
  readonly configuredEffort: AiExecutionProfile['effort'];
  readonly configuredMaxOutputTokens: number;
  readonly maximumAttempts: number;
  readonly maximumInputTokensPerAttempt: number;
  readonly maximumOutputTokensPerAttempt: number;
}

export interface NarrativeLiveEvalSafePlan {
  readonly planVersion: typeof NARRATIVE_LIVE_EVAL_PLAN_VERSION;
  readonly tokenCeilingVersion: typeof NARRATIVE_LIVE_EVAL_TOKEN_CEILING_VERSION;
  readonly costCeilingVersion: typeof NARRATIVE_LIVE_EVAL_COST_CEILING_VERSION;
  readonly retryPolicyVersion: typeof NARRATIVE_LIVE_EVAL_RETRY_POLICY_VERSION;
  readonly syntheticOnly: true;
  readonly semanticCases: 32;
  readonly precheckCases: 2;
  readonly repeatedSentinels: 8;
  readonly endToEndCases: 4;
  readonly plannedLogicalCalls: 46;
  readonly plannedMaximumAttempts: number;
  readonly calls: readonly NarrativeLiveEvalSafePlannedCall[];
}

export interface NarrativeLiveEvalPreflightSummary {
  readonly plan: NarrativeLiveEvalSafePlan;
  readonly limits: LiveEvalPreflight['limits'];
  readonly plannedMaximumCostUsdMicros: number;
  readonly priceCatalogVersion: string;
}

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
  readonly underlyingCode?: string;
}

interface PreparedSemanticCase {
  readonly qualityCase: ResolvedNarrativeQualityCase;
  readonly modelView: NarrativeModelView;
  readonly precheck: ReturnType<typeof runNarrativeSafetyPrecheck>;
  readonly constraints: NarrativeConstraintSnapshot;
  readonly qualityContext?: NarrativeQualityContext;
  readonly judgeRequest?: StructuredAiRequest<NarrativeJudgeOutput>;
}

interface PreparedEndToEndCase {
  readonly qualityCase: ResolvedNarrativeQualityEndToEndCase;
  readonly modelView: NarrativeModelView;
  readonly constraints: NarrativeConstraintSnapshot;
  readonly generateRequest: StructuredAiRequest<OptionNarrativeOutput>;
  readonly maximumJudgeRequest: StructuredAiRequest<NarrativeJudgeOutput>;
}

interface PreparedLivePlan {
  readonly resolvedDataset: ResolvedNarrativeQualityDataset;
  readonly semanticCases: readonly PreparedSemanticCase[];
  readonly endToEndCases: readonly PreparedEndToEndCase[];
  readonly calls: readonly NarrativeLiveEvalCallDescriptor<unknown>[];
  readonly safe: NarrativeLiveEvalSafePlan;
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

function safeIntegerSum(values: readonly number[], label: string): number {
  const total = values.reduce((sum, value) => {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new EvalContractError('INVALID_EVAL_INPUT', `${label} contains an invalid integer.`);
    }
    return sum + BigInt(value);
  }, 0n);
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new EvalContractError('INVALID_EVAL_INPUT', `${label} is too large.`);
  }
  return Number(total);
}

function profileForRequest(
  config: AiConfig,
  request: StructuredAiRequest<unknown>,
): AiExecutionProfile {
  if (request.taskType !== AiTaskType.GENERATE && request.taskType !== AiTaskType.JUDGE) {
    throw new EvalContractError('INVALID_EVAL_INPUT', 'The live eval plan uses an invalid task.');
  }
  const profile = config.taskProfiles[request.taskType];
  if (profile.taskType !== request.taskType) {
    throw new EvalContractError(
      'INVALID_EVAL_INPUT',
      'A configured live-eval profile has mismatched task routing.',
    );
  }
  return profile;
}

function schemaWireBytes(request: StructuredAiRequest<unknown>): number {
  let schema: unknown;
  try {
    schema = z.toJSONSchema(request.outputSchema);
  } catch {
    throw new EvalContractError(
      'INVALID_EVAL_INPUT',
      'A live-eval structured-output schema cannot be serialized for preflight.',
    );
  }
  return Buffer.byteLength(JSON.stringify(schema), 'utf8');
}

function requestInputTokenCeiling(
  request: StructuredAiRequest<unknown>,
  inputJsonByteCeiling?: number,
): number {
  const actualInputBytes = Buffer.byteLength(canonicalizeJson(request.input), 'utf8');
  if (
    inputJsonByteCeiling !== undefined &&
    (!Number.isSafeInteger(inputJsonByteCeiling) || inputJsonByteCeiling < actualInputBytes)
  ) {
    throw new EvalContractError(
      'INVALID_EVAL_INPUT',
      'A live-eval input byte ceiling is smaller than its planning fixture.',
    );
  }
  return safeIntegerSum(
    [
      inputJsonByteCeiling ?? actualInputBytes,
      Buffer.byteLength(request.instructions, 'utf8'),
      Buffer.byteLength(request.promptVersion, 'utf8'),
      Buffer.byteLength(request.schemaVersion, 'utf8'),
      Buffer.byteLength(request.schemaName, 'utf8'),
      schemaWireBytes(request),
      NARRATIVE_LIVE_EVAL_PROTOCOL_TOKEN_RESERVE,
    ],
    'Live-eval input-token ceiling',
  );
}

function allTokenClassesUsageCeiling(
  inputTokens: number,
  outputTokens: number,
): BillableTokenUsage {
  // Cost every possible class independently at its full request ceiling. `inputTokens` is three
  // times the provider-input ceiling so uncached, cache-read and cache-write each receive one full
  // ceiling without overlap. `outputTokens` similarly reserves visible and reasoning output.
  // This intentionally overestimates instead of relying on an unknown cache mix.
  return {
    inputTokens: safeIntegerSum([inputTokens, inputTokens, inputTokens], 'Input-class ceiling'),
    outputTokens: safeIntegerSum([outputTokens, outputTokens], 'Output-class ceiling'),
    cacheReadTokens: inputTokens,
    cacheWriteTokens: inputTokens,
    reasoningTokens: outputTokens,
  };
}

function createCallBudget(
  request: StructuredAiRequest<unknown>,
  profile: AiExecutionProfile,
  config: AiConfig,
  inputJsonByteCeiling?: number,
): LogicalCallBudget {
  const inputTokens = requestInputTokenCeiling(request, inputJsonByteCeiling);
  const outputTokens = request.maxOutputTokens ?? profile.maxOutputTokens;
  return {
    provider: profile.provider,
    configuredModel: profile.model,
    maxAttempts: config.maxRetries + 1,
    maximumUsagePerAttempt: allTokenClassesUsageCeiling(inputTokens, outputTokens),
  };
}

function buildQualityContext(
  context: GroundedOptionContext,
  modelView: NarrativeModelView,
  candidate: OptionNarrativeOutput,
  constraints: NarrativeConstraintSnapshot,
): NarrativeQualityContext {
  return buildNarrativeQualityContext({
    context,
    modelView,
    narrativeOutput: candidate,
    constraints,
    versions: NARRATIVE_EVAL_CONTRACT_VERSIONS,
  });
}

function prepareSemanticCase(
  qualityCase: ResolvedNarrativeQualityCase,
  authoredContext: NarrativeQualityAuthoringContext,
): PreparedSemanticCase {
  const modelView = buildNarrativeModelView(qualityCase.groundedContext);
  const constraints = buildSyntheticNarrativeConstraintSnapshot(authoredContext);
  const precheck = runNarrativeSafetyPrecheck({
    context: qualityCase.groundedContext,
    modelView,
    narrativeOutput: qualityCase.candidate,
  });
  if (!precheck.passed) return { qualityCase, modelView, precheck, constraints };
  const qualityContext = buildQualityContext(
    qualityCase.groundedContext,
    modelView,
    qualityCase.candidate,
    constraints,
  );
  return {
    qualityCase,
    modelView,
    precheck,
    constraints,
    qualityContext,
    judgeRequest: createNarrativeJudgeRequest(qualityContext),
  };
}

function maximumLocallyValidCandidate(context: GroundedOptionContext): OptionNarrativeOutput {
  const factReferences = context.facts.slice(0, 32).map(({ factId }) => factId);
  if (factReferences.length === 0) {
    throw new EvalContractError(
      'INVALID_EVAL_INPUT',
      'An E2E planning context has no grounded fact reference.',
    );
  }
  return parseOptionNarrativeOutput(
    {
      contextFingerprint: context.fingerprint,
      blocks: Array.from({ length: 8 }, () => ({
        kind: 'ADVANTAGE',
        // A three-byte BMP code point reaches the maximum UTF-8 byte size per JS code unit.
        text: '界'.repeat(1_200),
        factReferences,
      })),
    },
    context,
  );
}

function prepareEndToEndCase(
  qualityCase: ResolvedNarrativeQualityEndToEndCase,
  authoredContext: NarrativeQualityAuthoringContext,
): PreparedEndToEndCase {
  const modelView = buildNarrativeModelView(qualityCase.groundedContext);
  const constraints = buildSyntheticNarrativeConstraintSnapshot(authoredContext);
  const generateRequest = createOptionNarrativeRequest(qualityCase.groundedContext, modelView);
  const maximumQualityContext = buildQualityContext(
    qualityCase.groundedContext,
    modelView,
    maximumLocallyValidCandidate(qualityCase.groundedContext),
    constraints,
  );
  return {
    qualityCase,
    modelView,
    constraints,
    generateRequest,
    maximumJudgeRequest: createNarrativeJudgeRequest(maximumQualityContext),
  };
}

function assertExactPrecheckMembership(semanticCases: readonly PreparedSemanticCase[]): void {
  const actual = semanticCases
    .filter(({ precheck }) => !precheck.passed)
    .map(({ qualityCase }) => qualityCase.authored.id)
    .sort();
  const expected = [...NARRATIVE_QUALITY_PRECHECK_CASE_IDS].sort();
  if (
    actual.length !== expected.length ||
    actual.some((caseId, index) => caseId !== expected[index])
  ) {
    throw new EvalContractError(
      'INVALID_EVAL_INPUT',
      'The deterministic precheck call boundary drifted from the frozen live plan.',
    );
  }
}

function createDescriptor<TOutput>(
  plannedSequence: number,
  caseId: string,
  pass: NarrativeLiveEvalPass,
  request: StructuredAiRequest<TOutput>,
  config: AiConfig,
  inputJsonByteCeiling?: number,
): NarrativeLiveEvalCallDescriptor<TOutput> {
  const profile = profileForRequest(config, request);
  return {
    plannedSequence,
    caseId,
    pass,
    request,
    profile,
    budget: createCallBudget(request, profile, config, inputJsonByteCeiling),
  };
}

function prepareLivePlan(
  resolvedDataset: ResolvedNarrativeQualityDataset,
  config: AiConfig,
): PreparedLivePlan {
  if (!resolvedDataset.dataset.synthetic) {
    throw new EvalContractError('INVALID_EVAL_INPUT', 'Live eval accepts synthetic data only.');
  }
  const authoredContexts = new Map(
    resolvedDataset.dataset.contexts.map((context) => [context.id, context]),
  );
  const semanticCases = resolvedDataset.cases.map((qualityCase) => {
    const authoredContext = authoredContexts.get(qualityCase.authored.contextId)!;
    return prepareSemanticCase(qualityCase, authoredContext);
  });
  assertExactPrecheckMembership(semanticCases);
  const endToEndCases = resolvedDataset.endToEndCases.map((qualityCase) => {
    const authoredContext = authoredContexts.get(qualityCase.authored.contextId)!;
    return prepareEndToEndCase(qualityCase, authoredContext);
  });
  const calls: NarrativeLiveEvalCallDescriptor<unknown>[] = [];

  const add = <TOutput>(
    caseId: string,
    pass: NarrativeLiveEvalPass,
    request: StructuredAiRequest<TOutput>,
    inputJsonByteCeiling?: number,
  ): void => {
    calls.push(
      createDescriptor(
        calls.length + 1,
        caseId,
        pass,
        request,
        config,
        inputJsonByteCeiling,
      ) as NarrativeLiveEvalCallDescriptor<unknown>,
    );
  };

  for (const prepared of semanticCases) {
    if (prepared.judgeRequest !== undefined) {
      add(prepared.qualityCase.authored.id, 'PRIMARY', prepared.judgeRequest);
    }
  }
  const semanticById = new Map(
    semanticCases.map((prepared) => [prepared.qualityCase.authored.id, prepared]),
  );
  for (const caseId of NARRATIVE_QUALITY_SENTINEL_CASE_IDS) {
    const prepared = semanticById.get(caseId);
    if (prepared?.judgeRequest === undefined) {
      throw new EvalContractError(
        'INVALID_EVAL_INPUT',
        'A frozen sentinel did not reach the semantic judge plan.',
      );
    }
    add(caseId, 'STABILITY_REPEAT', prepared.judgeRequest);
  }
  for (const prepared of endToEndCases) {
    const caseId = prepared.qualityCase.authored.id;
    add(caseId, 'END_TO_END_GENERATE', prepared.generateRequest);
    add(
      caseId,
      'END_TO_END_JUDGE',
      prepared.maximumJudgeRequest,
      NARRATIVE_QUALITY_CONTEXT_MAX_BYTES,
    );
  }

  const generateCount = calls.filter(
    ({ request }) => request.taskType === AiTaskType.GENERATE,
  ).length;
  const judgeCount = calls.filter(({ request }) => request.taskType === AiTaskType.JUDGE).length;
  if (
    calls.length !== NARRATIVE_LIVE_EVAL_EXPECTED_LOGICAL_CALLS ||
    generateCount !== NARRATIVE_LIVE_EVAL_EXPECTED_GENERATE_CALLS ||
    judgeCount !== NARRATIVE_LIVE_EVAL_EXPECTED_JUDGE_CALLS
  ) {
    throw new EvalContractError(
      'INVALID_EVAL_INPUT',
      'The synthetic live-eval logical call plan drifted from v1.',
    );
  }

  const safeCalls = calls.map(
    ({
      plannedSequence,
      caseId,
      pass,
      request,
      profile,
      budget,
    }): NarrativeLiveEvalSafePlannedCall => ({
      plannedSequence,
      caseId,
      pass,
      taskType: request.taskType as 'GENERATE' | 'JUDGE',
      provider: profile.provider,
      configuredModel: profile.model,
      configuredEffort: profile.effort,
      configuredMaxOutputTokens: profile.maxOutputTokens,
      maximumAttempts: budget.maxAttempts,
      maximumInputTokensPerAttempt: budget.maximumUsagePerAttempt.inputTokens / 3,
      maximumOutputTokensPerAttempt: budget.maximumUsagePerAttempt.outputTokens / 2,
    }),
  );
  const safe: NarrativeLiveEvalSafePlan = {
    planVersion: NARRATIVE_LIVE_EVAL_PLAN_VERSION,
    tokenCeilingVersion: NARRATIVE_LIVE_EVAL_TOKEN_CEILING_VERSION,
    costCeilingVersion: NARRATIVE_LIVE_EVAL_COST_CEILING_VERSION,
    retryPolicyVersion: NARRATIVE_LIVE_EVAL_RETRY_POLICY_VERSION,
    syntheticOnly: true,
    semanticCases: 32,
    precheckCases: 2,
    repeatedSentinels: 8,
    endToEndCases: 4,
    plannedLogicalCalls: NARRATIVE_LIVE_EVAL_EXPECTED_LOGICAL_CALLS,
    plannedMaximumAttempts: safeIntegerSum(
      safeCalls.map(({ maximumAttempts }) => maximumAttempts),
      'Live-eval planned attempts',
    ),
    calls: safeCalls,
  };
  return { resolvedDataset, semanticCases, endToEndCases, calls, safe };
}

export function createNarrativeQualityLiveEvalPlan(input: {
  readonly config: AiConfig;
  readonly resolvedDataset?: ResolvedNarrativeQualityDataset;
}): NarrativeLiveEvalSafePlan {
  const resolvedDataset =
    input.resolvedDataset ??
    resolveNarrativeQualityDataset(
      loadNarrativeQualityDataset(),
      resolveSyntheticNarrativeQualityFixture,
    );
  return prepareLivePlan(resolvedDataset, input.config).safe;
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

  constructor(
    descriptor: NarrativeLiveEvalCallDescriptor<unknown>,
    logicalCallSequence: number,
    providerCallMayHaveOccurred: boolean,
    underlying: unknown,
  ) {
    super('Live evaluation stopped safely without a partial report.');
    this.name = 'NarrativeLiveEvalExecutionError';
    this.caseId = descriptor.caseId;
    this.taskType = descriptor.request.taskType as 'GENERATE' | 'JUDGE';
    this.logicalCallSequence = logicalCallSequence;
    this.providerCallMayHaveOccurred = providerCallMayHaveOccurred;
    this.underlyingCode = underlyingFailureCode(underlying);
  }
}

export function toSafeNarrativeLiveEvalFailure(error: unknown): SafeNarrativeLiveEvalFailure {
  if (error instanceof NarrativeLiveEvalExecutionError) {
    return {
      status: 'FAILED',
      code: error.code,
      reportProduced: false,
      providerCallMayHaveOccurred: error.providerCallMayHaveOccurred,
      // The current gateway exposes neither attempt count nor usage after a thrown failure.
      attemptAccountingComplete: !error.providerCallMayHaveOccurred,
      caseId: error.caseId,
      taskType: error.taskType,
      logicalCallSequence: error.logicalCallSequence,
      underlyingCode: error.underlyingCode,
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
 * preflight. With the current gateway failure contract, retry must be zero: a thrown failure does
 * not expose its attempt count or usage. The runner therefore stops at that call, never settles an
 * unverifiable reservation, never starts the next call, and never emits a partial report.
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
  const plan = prepareLivePlan(resolvedDataset, input.config);
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
      'Live eval requires zero retries until failed calls expose safe attempt accounting.',
    );
  }
  const preflightSummary: NarrativeLiveEvalPreflightSummary = {
    plan: plan.safe,
    limits: preflight.limits,
    plannedMaximumCostUsdMicros: preflight.plannedMaximumCostUsdMicros,
    priceCatalogVersion: preflight.priceSnapshot.priceCatalogVersion,
  };
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
    try {
      const reservation = guard.authorizeNextCall(actualDescriptor.budget);
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

    const qualityContext = buildQualityContext(
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
