import { z } from 'zod';
import { AiProvider, AiTaskType } from '../ai/contracts.ts';
import { createInputFingerprint, type JsonValue } from '../ai/contracts.ts';
import { AI_VALIDATION_FAILURE_STAGE_VALUES } from '../ai/failure-execution-evidence.ts';
import { GROUNDED_OPTION_CONTEXT_VERSION } from '../narratives/grounded-option-types.ts';
import { NARRATIVE_FINALIZATION_VERSION } from '../narratives/narrative-finalization.ts';
import { NARRATIVE_GENERATION_VIEW_VERSION } from '../narratives/narrative-generation-view.ts';
import { NARRATIVE_MODEL_VIEW_VERSION } from '../narratives/narrative-model-view.ts';
import {
  NARRATIVE_CONSTRAINT_SNAPSHOT_VERSION,
  NARRATIVE_JUDGE_PROMPT_VERSION,
  NARRATIVE_JUDGE_SCHEMA_VERSION,
  NARRATIVE_MODEL_PROFILE_VERSION,
  NARRATIVE_PRICE_CATALOG_VERSION,
  NARRATIVE_PUBLICATION_POLICY_VERSION,
  NARRATIVE_QUALITY_CONTEXT_VERSION,
  NARRATIVE_QUALITY_RUBRIC_VERSION,
  NARRATIVE_SAFETY_PRECHECK_VERSION,
} from '../narratives/narrative-quality-versions.ts';
import {
  OPTION_NARRATIVE_PROMPT_VERSION,
  OPTION_NARRATIVE_SCHEMA_VERSION,
} from '../narratives/option-narrative.ts';
import {
  EvalContractError,
  NARRATIVE_QUALITY_DATASET_FINGERPRINT,
  NARRATIVE_QUALITY_DATASET_VERSION,
  NARRATIVE_QUALITY_SENTINEL_CASE_IDS,
  validateNarrativeQualityDatasetContract,
  type NarrativeQualityDataset,
  type NarrativeQualityDimension,
  type NarrativeQualityReasonCode,
} from './dataset.ts';
import {
  DIMENSION_MACRO_F1_CONVENTION_VERSION,
  calculateEndToEndMetrics,
  calculateSemanticQualityMetrics,
  calculateStabilityMetrics,
  evaluateEndToEndGates,
  evaluateSemanticGates,
  evaluateStabilityGates,
  type EndToEndCaseOutcome,
  type EndToEndGateResult,
  type EndToEndMetrics,
  type SemanticCaseOutcome,
  type SemanticGateResult,
  type SemanticQualityMetrics,
  type StabilityGateResult,
  type StabilityMetrics,
} from './metrics.ts';
import { AI_PRICE_ARITHMETIC_VERSION, sumUsdMicros } from './price-snapshot.ts';
import {
  NARRATIVE_E2E_REQUIRED_PROPERTY_CATALOG_VERSION,
  validateNarrativeE2eRequiredPropertyResults,
  type NarrativeE2eRequiredPropertyResult,
} from './required-properties.ts';

/** Historical identifier retained for readers of already-produced v2 evidence. */
export const NARRATIVE_EVAL_REPORT_VERSION_V2 = 'narrative-quality-eval-report-v2';
export const NARRATIVE_EVAL_REPORT_VERSION = 'narrative-quality-eval-report-v3';
export const LATENCY_PERCENTILE_CONVENTION_VERSION = 'nearest-rank-ms-v1';

const safeModel = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/);
const nonNegativeSafeInteger = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export const evalContractVersionsSchema = z
  .object({
    groundedContextVersion: z.literal(GROUNDED_OPTION_CONTEXT_VERSION),
    modelViewVersion: z.literal(NARRATIVE_MODEL_VIEW_VERSION),
    generationViewVersion: z.literal(NARRATIVE_GENERATION_VIEW_VERSION),
    finalizationVersion: z.literal(NARRATIVE_FINALIZATION_VERSION),
    qualityContextVersion: z.literal(NARRATIVE_QUALITY_CONTEXT_VERSION),
    constraintSnapshotVersion: z.literal(NARRATIVE_CONSTRAINT_SNAPSHOT_VERSION),
    generatePromptVersion: z.literal(OPTION_NARRATIVE_PROMPT_VERSION),
    generateSchemaVersion: z.literal(OPTION_NARRATIVE_SCHEMA_VERSION),
    judgePromptVersion: z.literal(NARRATIVE_JUDGE_PROMPT_VERSION),
    judgeSchemaVersion: z.literal(NARRATIVE_JUDGE_SCHEMA_VERSION),
    rubricVersion: z.literal(NARRATIVE_QUALITY_RUBRIC_VERSION),
    publicationPolicyVersion: z.literal(NARRATIVE_PUBLICATION_POLICY_VERSION),
    datasetVersion: z.literal(NARRATIVE_QUALITY_DATASET_VERSION),
    safetyPrecheckVersion: z.literal(NARRATIVE_SAFETY_PRECHECK_VERSION),
    modelProfileVersion: z.literal(NARRATIVE_MODEL_PROFILE_VERSION),
    priceCatalogVersion: z.literal(NARRATIVE_PRICE_CATALOG_VERSION),
  })
  .strict();

export type EvalContractVersions = z.infer<typeof evalContractVersionsSchema>;

export const NARRATIVE_EVAL_CONTRACT_VERSIONS = Object.freeze({
  groundedContextVersion: GROUNDED_OPTION_CONTEXT_VERSION,
  modelViewVersion: NARRATIVE_MODEL_VIEW_VERSION,
  generationViewVersion: NARRATIVE_GENERATION_VIEW_VERSION,
  finalizationVersion: NARRATIVE_FINALIZATION_VERSION,
  qualityContextVersion: NARRATIVE_QUALITY_CONTEXT_VERSION,
  constraintSnapshotVersion: NARRATIVE_CONSTRAINT_SNAPSHOT_VERSION,
  generatePromptVersion: OPTION_NARRATIVE_PROMPT_VERSION,
  generateSchemaVersion: OPTION_NARRATIVE_SCHEMA_VERSION,
  judgePromptVersion: NARRATIVE_JUDGE_PROMPT_VERSION,
  judgeSchemaVersion: NARRATIVE_JUDGE_SCHEMA_VERSION,
  rubricVersion: NARRATIVE_QUALITY_RUBRIC_VERSION,
  publicationPolicyVersion: NARRATIVE_PUBLICATION_POLICY_VERSION,
  datasetVersion: NARRATIVE_QUALITY_DATASET_VERSION,
  safetyPrecheckVersion: NARRATIVE_SAFETY_PRECHECK_VERSION,
  modelProfileVersion: NARRATIVE_MODEL_PROFILE_VERSION,
  priceCatalogVersion: NARRATIVE_PRICE_CATALOG_VERSION,
}) satisfies EvalContractVersions;

const operationSchema = z
  .object({
    logicalCallSequence: z.number().int().min(1),
    caseId: z.string().regex(/^(?:[PR][0-9]{2}|E[0-9]{2})$/),
    taskType: z.enum([AiTaskType.GENERATE, AiTaskType.JUDGE]),
    provider: z.enum([AiProvider.OPENAI, AiProvider.ANTHROPIC]),
    configuredModel: safeModel,
    responseModel: safeModel,
    configuredEffort: z.enum(['none', 'low', 'medium', 'high', 'xhigh', 'max']),
    configuredMaxOutputTokens: z.number().int().min(1).max(1_000_000),
    inputTokens: nonNegativeSafeInteger,
    outputTokens: nonNegativeSafeInteger,
    cacheReadTokens: nonNegativeSafeInteger,
    cacheWriteTokens: nonNegativeSafeInteger,
    reasoningTokens: nonNegativeSafeInteger,
    latencyMs: nonNegativeSafeInteger,
    attempts: z.number().int().min(1).max(56),
    refused: z.boolean(),
    refusalCategory: z.enum(['SAFETY', 'POLICY', 'UNKNOWN']).nullable(),
    terminalAuditStatus: z.enum(['SUCCEEDED', 'FAILED']),
    structuredOutputValid: z.boolean(),
    validationFailureStage: z.enum(AI_VALIDATION_FAILURE_STAGE_VALUES).nullable(),
    exactAuditLinkageValid: z.boolean(),
    estimatedCostUsdMicros: nonNegativeSafeInteger,
  })
  .strict()
  .superRefine((operation, refinement) => {
    if (operation.cacheReadTokens + operation.cacheWriteTokens > operation.inputTokens) {
      refinement.addIssue({
        code: 'custom',
        path: ['cacheReadTokens'],
        message: 'Cache token classes cannot exceed input tokens.',
      });
    }
    if (operation.reasoningTokens > operation.outputTokens) {
      refinement.addIssue({
        code: 'custom',
        path: ['reasoningTokens'],
        message: 'Reasoning tokens cannot exceed output tokens.',
      });
    }
    if (operation.refused !== (operation.refusalCategory !== null)) {
      refinement.addIssue({
        code: 'custom',
        path: ['refusalCategory'],
        message: 'Refusal category must agree with the normalized refusal state.',
      });
    }
    if (
      operation.terminalAuditStatus === 'SUCCEEDED' &&
      (!operation.structuredOutputValid ||
        operation.validationFailureStage !== null ||
        !operation.exactAuditLinkageValid)
    ) {
      refinement.addIssue({
        code: 'custom',
        path: ['terminalAuditStatus'],
        message: 'A successful operation requires valid output and exact audit linkage.',
      });
    }
    if (
      operation.terminalAuditStatus === 'FAILED' &&
      (operation.structuredOutputValid ||
        operation.validationFailureStage === null ||
        operation.validationFailureStage === 'SCHEMA_CONSTRUCTION' ||
        operation.validationFailureStage === 'NARRATIVE_FINALIZATION' ||
        !operation.exactAuditLinkageValid ||
        operation.refused ||
        operation.taskType !== AiTaskType.JUDGE)
    ) {
      refinement.addIssue({
        code: 'custom',
        path: ['terminalAuditStatus'],
        message:
          'A reportable failed operation must be an exactly linked post-response validation failure.',
      });
    }
  });

export type EvalOperationEvidence = z.infer<typeof operationSchema>;

export interface BuildEvalReportInput {
  readonly dataset: NarrativeQualityDataset;
  readonly versions: EvalContractVersions;
  readonly outcomes: readonly SemanticCaseOutcome[];
  readonly repeatedSentinelOutcomes: readonly SemanticCaseOutcome[];
  readonly endToEndOutcomes: readonly EndToEndCaseOutcome[];
  readonly operations: readonly EvalOperationEvidence[];
}

export interface EvalCaseReportRow {
  readonly caseId: string;
  readonly expectedDecision: 'PUBLISH' | 'REJECT';
  readonly actualDecision: 'PUBLISH' | 'REJECT';
  readonly expectedStage: 'PRECHECK' | 'JUDGE';
  readonly actualStage: 'PRECHECK' | 'JUDGE';
  readonly critical: boolean;
  readonly sentinel: boolean;
  readonly expectedFailedDimensions: readonly NarrativeQualityDimension[];
  readonly actualFailedDimensions: readonly NarrativeQualityDimension[];
  readonly expectedReasonCodes: readonly NarrativeQualityReasonCode[];
  readonly actualReasonCodes: readonly NarrativeQualityReasonCode[];
  readonly strictJudgeOutputValid: boolean | null;
}

export interface EvalStabilityCaseReportRow {
  readonly caseId: string;
  readonly actualDecision: 'PUBLISH' | 'REJECT';
  readonly actualFailedDimensions: readonly NarrativeQualityDimension[];
  readonly actualReasonCodes: readonly NarrativeQualityReasonCode[];
  readonly strictJudgeOutputValid: boolean;
}

export interface EvalOperationalSummary {
  readonly latencyPercentileConventionVersion: typeof LATENCY_PERCENTILE_CONVENTION_VERSION;
  readonly logicalCalls: number;
  readonly providerAttempts: number;
  readonly refusals: number;
  readonly latencyP50Ms: number;
  readonly latencyP95Ms: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly reasoningTokens: number;
  readonly estimatedCostUsdMicros: number;
}

export interface EvalEndToEndCaseReportRow {
  readonly caseId: string;
  readonly expectedDecision: 'PUBLISH';
  readonly generateLogicalCalls: number;
  readonly judgeLogicalCalls: number;
  readonly generatedSchemaValid: boolean;
  readonly exactReferencesValid: boolean;
  readonly actualDecision: 'PUBLISH' | 'REJECT';
  readonly actualFailedDimensions: readonly NarrativeQualityDimension[];
  readonly actualReasonCodes: readonly NarrativeQualityReasonCode[];
  readonly judgeStructuredOutputValid: boolean | null;
  readonly requiredPropertyResults: readonly NarrativeE2eRequiredPropertyResult[];
  readonly generateAuditSucceeded: boolean;
  readonly judgeAuditSucceeded: boolean;
  /** In-memory bundle construction/linkage evidence only; this is not a persistence result. */
  readonly publicationBundleLinkageValidInMemory: boolean;
  readonly deterministicStateUnchanged: boolean;
}

export interface NarrativeEvalReport {
  readonly reportVersion: typeof NARRATIVE_EVAL_REPORT_VERSION;
  readonly datasetVersion: typeof NARRATIVE_QUALITY_DATASET_VERSION;
  readonly datasetFingerprint: typeof NARRATIVE_QUALITY_DATASET_FINGERPRINT;
  readonly dimensionMacroF1ConventionVersion: typeof DIMENSION_MACRO_F1_CONVENTION_VERSION;
  readonly priceArithmeticVersion: typeof AI_PRICE_ARITHMETIC_VERSION;
  readonly versions: EvalContractVersions;
  readonly cases: readonly EvalCaseReportRow[];
  readonly semantic: {
    readonly metrics: SemanticQualityMetrics;
    readonly gates: SemanticGateResult;
  };
  readonly stability: {
    readonly cases: readonly EvalStabilityCaseReportRow[];
    readonly metrics: StabilityMetrics;
    readonly gates: StabilityGateResult;
  };
  readonly endToEnd: {
    readonly requiredPropertyCatalogVersion: typeof NARRATIVE_E2E_REQUIRED_PROPERTY_CATALOG_VERSION;
    readonly cases: readonly EvalEndToEndCaseReportRow[];
    readonly metrics: EndToEndMetrics;
    readonly gates: EndToEndGateResult;
  };
  readonly operations: readonly EvalOperationEvidence[];
  readonly operationalSummary: EvalOperationalSummary;
  readonly reportFingerprint: string;
}

function nearestRank(values: readonly number[], percentileNumerator: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const oneBasedRank = Math.ceil((percentileNumerator * sorted.length) / 100);
  return sorted[Math.max(0, oneBasedRank - 1)]!;
}

function safeIntegerSum(values: readonly number[], label: string): number {
  const total = values.reduce((sum, value) => sum + BigInt(value), 0n);
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new EvalContractError('INVALID_EVAL_INPUT', `${label} total is too large.`);
  }
  return Number(total);
}

function buildOperationalSummary(
  operations: readonly EvalOperationEvidence[],
): EvalOperationalSummary {
  return {
    latencyPercentileConventionVersion: LATENCY_PERCENTILE_CONVENTION_VERSION,
    logicalCalls: operations.length,
    providerAttempts: safeIntegerSum(
      operations.map(({ attempts }) => attempts),
      'Provider attempts',
    ),
    refusals: operations.filter(({ refused }) => refused).length,
    latencyP50Ms: nearestRank(
      operations.map(({ latencyMs }) => latencyMs),
      50,
    ),
    latencyP95Ms: nearestRank(
      operations.map(({ latencyMs }) => latencyMs),
      95,
    ),
    inputTokens: safeIntegerSum(
      operations.map(({ inputTokens }) => inputTokens),
      'Input tokens',
    ),
    outputTokens: safeIntegerSum(
      operations.map(({ outputTokens }) => outputTokens),
      'Output tokens',
    ),
    cacheReadTokens: safeIntegerSum(
      operations.map(({ cacheReadTokens }) => cacheReadTokens),
      'Cache-read tokens',
    ),
    cacheWriteTokens: safeIntegerSum(
      operations.map(({ cacheWriteTokens }) => cacheWriteTokens),
      'Cache-write tokens',
    ),
    reasoningTokens: safeIntegerSum(
      operations.map(({ reasoningTokens }) => reasoningTokens),
      'Reasoning tokens',
    ),
    estimatedCostUsdMicros: sumUsdMicros(
      operations.map(({ estimatedCostUsdMicros }) => estimatedCostUsdMicros),
    ),
  };
}

/** Reconstructs an allow-listed report; candidate text, prompts, contexts and payloads have no slot. */
export function buildPrivacySafeEvalReport(input: BuildEvalReportInput): NarrativeEvalReport {
  validateNarrativeQualityDatasetContract(input.dataset);
  const versions = evalContractVersionsSchema.safeParse(input.versions);
  if (!versions.success) {
    throw new EvalContractError('INVALID_EVAL_INPUT', 'Eval report versions are invalid.');
  }
  const parsedOperations = input.operations.map((operation) => {
    const parsed = operationSchema.safeParse(operation);
    if (!parsed.success) {
      throw new EvalContractError(
        'INVALID_EVAL_INPUT',
        'Operational evidence contains a non-safe or invalid field.',
      );
    }
    return parsed.data;
  });
  const sequences = parsedOperations.map(({ logicalCallSequence }) => logicalCallSequence);
  if (new Set(sequences).size !== sequences.length) {
    throw new EvalContractError(
      'INVALID_EVAL_INPUT',
      'Operational logical-call sequences must be unique.',
    );
  }
  const outcomeById = new Map(input.outcomes.map((outcome) => [outcome.caseId, outcome]));
  if (outcomeById.size !== 32) {
    throw new EvalContractError('INVALID_EVAL_INPUT', 'The report requires all semantic outcomes.');
  }
  const cases = input.dataset.cases.map((authored): EvalCaseReportRow => {
    const actual = outcomeById.get(authored.id);
    if (actual === undefined) {
      throw new EvalContractError('INVALID_EVAL_INPUT', 'The report is missing a semantic case.');
    }
    return {
      caseId: authored.id,
      expectedDecision: authored.expected.decision,
      actualDecision: actual.actualDecision,
      expectedStage: authored.expected.stage,
      actualStage: actual.actualStage,
      critical: authored.expected.critical,
      sentinel: authored.sentinel,
      expectedFailedDimensions: [...authored.expected.failedDimensions].sort(),
      actualFailedDimensions: [...actual.failedDimensions].sort(),
      expectedReasonCodes: [...authored.expected.requiredReasonCodes].sort(),
      actualReasonCodes: [...actual.reasonCodes].sort(),
      strictJudgeOutputValid: actual.strictJudgeOutputValid,
    };
  });
  const operations = [...parsedOperations].sort(
    (left, right) => left.logicalCallSequence - right.logicalCallSequence,
  );
  const semanticMetrics = calculateSemanticQualityMetrics(input.dataset, input.outcomes);
  const semanticGates = evaluateSemanticGates(semanticMetrics);
  const stabilityMetrics = calculateStabilityMetrics(
    input.dataset,
    input.outcomes,
    input.repeatedSentinelOutcomes,
  );
  const stabilityGates = evaluateStabilityGates(stabilityMetrics);
  const repeatedSentinelOutcomeById = new Map(
    input.repeatedSentinelOutcomes.map((outcome) => [outcome.caseId, outcome]),
  );
  const stabilityCases = NARRATIVE_QUALITY_SENTINEL_CASE_IDS.map(
    (caseId): EvalStabilityCaseReportRow => {
      const outcome = repeatedSentinelOutcomeById.get(caseId);
      if (outcome === undefined || outcome.strictJudgeOutputValid === null) {
        throw new EvalContractError(
          'INVALID_EVAL_INPUT',
          'The report is missing an exact repeated sentinel outcome.',
        );
      }
      return {
        caseId,
        actualDecision: outcome.actualDecision,
        actualFailedDimensions: [...outcome.failedDimensions].sort(),
        actualReasonCodes: [...outcome.reasonCodes].sort(),
        strictJudgeOutputValid: outcome.strictJudgeOutputValid,
      };
    },
  );
  const endToEndOutcomeById = new Map(
    input.endToEndOutcomes.map((outcome) => [outcome.caseId, outcome]),
  );
  // Validate the closed E2E outcome schema and cross-field semantics before copying any row.
  const endToEndMetrics = calculateEndToEndMetrics(input.dataset, input.endToEndOutcomes);
  const endToEndCases = input.dataset.endToEndCases.map((authored): EvalEndToEndCaseReportRow => {
    const outcome = endToEndOutcomeById.get(authored.id);
    if (outcome === undefined) {
      throw new EvalContractError(
        'INVALID_EVAL_INPUT',
        'The report is missing an end-to-end outcome.',
      );
    }
    const requiredPropertyResults = validateNarrativeE2eRequiredPropertyResults({
      catalogVersion: outcome.requiredPropertyCatalogVersion,
      requiredPropertyIds: authored.requiredProperties,
      results: outcome.requiredPropertyResults,
    });
    return {
      caseId: authored.id,
      expectedDecision: authored.expectedDecision,
      generateLogicalCalls: outcome.generateLogicalCalls,
      judgeLogicalCalls: outcome.judgeLogicalCalls,
      generatedSchemaValid: outcome.generatedSchemaValid,
      exactReferencesValid: outcome.exactReferencesValid,
      actualDecision: outcome.actualDecision,
      actualFailedDimensions: [...outcome.actualFailedDimensions].sort(),
      actualReasonCodes: [...outcome.actualReasonCodes].sort(),
      judgeStructuredOutputValid: outcome.judgeStructuredOutputValid,
      requiredPropertyResults,
      generateAuditSucceeded: outcome.generateAuditSucceeded,
      judgeAuditSucceeded: outcome.judgeAuditSucceeded,
      publicationBundleLinkageValidInMemory: outcome.publicationBundleLinkageValidInMemory,
      deterministicStateUnchanged: outcome.deterministicStateUnchanged,
    };
  });
  const endToEndGates = evaluateEndToEndGates(endToEndMetrics);
  const basis: Omit<NarrativeEvalReport, 'reportFingerprint'> = {
    reportVersion: NARRATIVE_EVAL_REPORT_VERSION,
    datasetVersion: NARRATIVE_QUALITY_DATASET_VERSION,
    datasetFingerprint: NARRATIVE_QUALITY_DATASET_FINGERPRINT,
    dimensionMacroF1ConventionVersion: DIMENSION_MACRO_F1_CONVENTION_VERSION,
    priceArithmeticVersion: AI_PRICE_ARITHMETIC_VERSION,
    versions: versions.data,
    cases,
    semantic: { metrics: semanticMetrics, gates: semanticGates },
    stability: { cases: stabilityCases, metrics: stabilityMetrics, gates: stabilityGates },
    endToEnd: {
      requiredPropertyCatalogVersion: NARRATIVE_E2E_REQUIRED_PROPERTY_CATALOG_VERSION,
      cases: endToEndCases,
      metrics: endToEndMetrics,
      gates: endToEndGates,
    },
    operations,
    operationalSummary: buildOperationalSummary(operations),
  };
  const reportFingerprint = createInputFingerprint(basis as unknown as JsonValue);
  return { ...basis, reportFingerprint };
}

export function verifyEvalReportFingerprint(report: NarrativeEvalReport): void {
  const { reportFingerprint, ...basis } = report;
  if (createInputFingerprint(basis as unknown as JsonValue) !== reportFingerprint) {
    throw new EvalContractError(
      'INVALID_EVAL_INPUT',
      'The eval report does not match its canonical fingerprint.',
    );
  }
}
