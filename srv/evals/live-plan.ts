import { z } from 'zod';
import type { AiConfig } from '../ai/config.ts';
import {
  AiTaskType,
  canonicalizeJson,
  resolveStructuredAiProviderOutputSchema,
  type AiExecutionProfile,
  type StructuredAiRequest,
} from '../ai/contracts.ts';
import type { GroundedOptionContext } from '../narratives/grounded-option-context.ts';
import { finalizeNarrativeOutput } from '../narratives/narrative-finalization.ts';
import {
  buildNarrativeGenerationView,
  type NarrativeGenerationView,
} from '../narratives/narrative-generation-view.ts';
import {
  createNarrativeJudgeRequest,
  type NarrativeJudgeOutput,
} from '../narratives/narrative-judge.ts';
import {
  buildNarrativeModelView,
  type NarrativeModelView,
} from '../narratives/narrative-model-view.ts';
import {
  buildNarrativeQualityContext,
  NARRATIVE_QUALITY_CONTEXT_MAX_BYTES,
  type NarrativeConstraintSnapshot,
  type NarrativeQualityContext,
} from '../narratives/narrative-quality-context.ts';
import { runAuthoredNarrativeSafetyPrecheck } from '../narratives/narrative-safety-precheck.ts';
import {
  createOptionNarrativeRequest,
  type OptionNarrativeOutput,
} from '../narratives/option-narrative.ts';
import {
  EvalContractError,
  NARRATIVE_QUALITY_PRECHECK_CASE_IDS,
  NARRATIVE_QUALITY_SENTINEL_CASE_IDS,
  loadNarrativeQualityDataset,
  resolveNarrativeQualityDataset,
  type NarrativeQualityAuthoringContext,
  type ResolvedNarrativeQualityCase,
  type ResolvedNarrativeQualityDataset,
  type ResolvedNarrativeQualityEndToEndCase,
} from './dataset.ts';
import type { LogicalCallBudget } from './live-guard.ts';
import { NARRATIVE_EVAL_CONTRACT_VERSIONS } from './report.ts';
import {
  buildSyntheticNarrativeConstraintSnapshot,
  resolveSyntheticNarrativeQualityFixture,
} from './synthetic-fixtures-v2.ts';

export const NARRATIVE_LIVE_EVAL_PLAN_VERSION = 'narrative-quality-live-plan-v2';
export const NARRATIVE_LIVE_EVAL_EXECUTION_CONTRACT_VERSION = 'narrative-quality-live-execution-v3';
export const NARRATIVE_LIVE_EVAL_FAILURE_ACCOUNTING_VERSION = 'post-response-failure-accounting-v3';
export const NARRATIVE_LIVE_EVAL_TOKEN_CEILING_VERSION =
  'utf8-wire-bytes-plus-4096-protocol-tokens-v1';
export const NARRATIVE_LIVE_EVAL_COST_CEILING_VERSION = 'full-ceiling-each-token-class-v1';
export const NARRATIVE_LIVE_EVAL_RETRY_POLICY_VERSION =
  'zero-retry-with-terminal-failure-accounting-v2';

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
  readonly executionContractVersion: typeof NARRATIVE_LIVE_EVAL_EXECUTION_CONTRACT_VERSION;
  readonly failureAccountingVersion: typeof NARRATIVE_LIVE_EVAL_FAILURE_ACCOUNTING_VERSION;
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

export interface PreparedSemanticCase {
  readonly qualityCase: ResolvedNarrativeQualityCase;
  readonly modelView: NarrativeModelView;
  readonly precheck: ReturnType<typeof runAuthoredNarrativeSafetyPrecheck>;
  readonly constraints: NarrativeConstraintSnapshot;
  readonly qualityContext?: NarrativeQualityContext;
  readonly judgeRequest?: StructuredAiRequest<NarrativeJudgeOutput>;
}

export interface PreparedEndToEndCase {
  readonly qualityCase: ResolvedNarrativeQualityEndToEndCase;
  readonly modelView: NarrativeModelView;
  readonly generationView: NarrativeGenerationView;
  readonly constraints: NarrativeConstraintSnapshot;
  readonly generateRequest: StructuredAiRequest<OptionNarrativeOutput>;
  readonly maximumJudgeRequest: StructuredAiRequest<NarrativeJudgeOutput>;
}

export interface PreparedLivePlan {
  readonly resolvedDataset: ResolvedNarrativeQualityDataset;
  readonly semanticCases: readonly PreparedSemanticCase[];
  readonly endToEndCases: readonly PreparedEndToEndCase[];
  readonly calls: readonly NarrativeLiveEvalCallDescriptor<unknown>[];
  readonly safe: NarrativeLiveEvalSafePlan;
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
    schema = z.toJSONSchema(resolveStructuredAiProviderOutputSchema(request));
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
): LogicalCallBudget['maximumUsagePerAttempt'] {
  // Reserve every independently priced token class at its full request ceiling. This is more
  // conservative than assuming any cache or reasoning mix before a provider response exists.
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

export function buildNarrativeLiveEvalQualityContext(
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
  const precheck = runAuthoredNarrativeSafetyPrecheck({
    context: qualityCase.groundedContext,
    modelView,
    narrativeOutput: qualityCase.candidate,
  });
  if (!precheck.passed) return { qualityCase, modelView, precheck, constraints };
  const qualityContext = buildNarrativeLiveEvalQualityContext(
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

function maximumLocallyValidCandidate(
  context: GroundedOptionContext,
  modelView: NarrativeModelView,
  generationView: NarrativeGenerationView,
): OptionNarrativeOutput {
  const factReferences = generationView.facts.slice(0, 32).map(({ factId }) => factId);
  if (factReferences.length === 0) {
    throw new EvalContractError(
      'INVALID_EVAL_INPUT',
      'An E2E planning context has no grounded fact reference.',
    );
  }
  return finalizeNarrativeOutput({
    context,
    modelView,
    generationView,
    providerBlocks: Array.from({ length: 6 }, () => ({
      kind: 'ADVANTAGE' as const,
      text: '界'.repeat(1_200),
      factReferences,
    })),
  });
}

function prepareEndToEndCase(
  qualityCase: ResolvedNarrativeQualityEndToEndCase,
  authoredContext: NarrativeQualityAuthoringContext,
): PreparedEndToEndCase {
  const modelView = buildNarrativeModelView(qualityCase.groundedContext);
  const generationView = buildNarrativeGenerationView(qualityCase.groundedContext, modelView);
  const constraints = buildSyntheticNarrativeConstraintSnapshot(authoredContext);
  const generateRequest = createOptionNarrativeRequest(
    qualityCase.groundedContext,
    modelView,
    generationView,
  );
  const maximumQualityContext = buildNarrativeLiveEvalQualityContext(
    qualityCase.groundedContext,
    modelView,
    maximumLocallyValidCandidate(qualityCase.groundedContext, modelView, generationView),
    constraints,
  );
  return {
    qualityCase,
    modelView,
    generationView,
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

export function prepareNarrativeQualityLiveEvalPlan(
  resolvedDataset: ResolvedNarrativeQualityDataset,
  config: AiConfig,
): PreparedLivePlan {
  if (!resolvedDataset.dataset.synthetic) {
    throw new EvalContractError('INVALID_EVAL_INPUT', 'Live eval accepts synthetic data only.');
  }
  const authoredContexts = new Map(
    resolvedDataset.dataset.contexts.map((context) => [context.id, context]),
  );
  const semanticCases = resolvedDataset.cases.map((qualityCase) =>
    prepareSemanticCase(qualityCase, authoredContexts.get(qualityCase.authored.contextId)!),
  );
  assertExactPrecheckMembership(semanticCases);
  const endToEndCases = resolvedDataset.endToEndCases.map((qualityCase) =>
    prepareEndToEndCase(qualityCase, authoredContexts.get(qualityCase.authored.contextId)!),
  );
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
    executionContractVersion: NARRATIVE_LIVE_EVAL_EXECUTION_CONTRACT_VERSION,
    failureAccountingVersion: NARRATIVE_LIVE_EVAL_FAILURE_ACCOUNTING_VERSION,
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
  return prepareNarrativeQualityLiveEvalPlan(resolvedDataset, input.config).safe;
}
