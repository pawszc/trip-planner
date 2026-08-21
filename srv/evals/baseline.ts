import { z } from 'zod';
import { AiProvider, AiTaskType } from '../ai/contracts.ts';
import {
  DATASET_FINGERPRINT_BASIS_VERSION,
  EvalContractError,
  NARRATIVE_QUALITY_DATASET_FINGERPRINT,
  NARRATIVE_QUALITY_DATASET_VERSION,
  NARRATIVE_QUALITY_END_TO_END_CASE_IDS,
  NARRATIVE_QUALITY_PRECHECK_CASE_IDS,
  NARRATIVE_QUALITY_SEMANTIC_CASE_IDS,
  NARRATIVE_QUALITY_SENTINEL_CASE_IDS,
} from './dataset.ts';
import {
  NARRATIVE_EVAL_REPORT_VERSION,
  evalContractVersionsSchema,
  verifyEvalReportFingerprint,
  type NarrativeEvalReport,
} from './report.ts';
import { LIVE_EVAL_HARD_CAPS } from './live-guard.ts';
import { DIMENSION_MACRO_F1_CONVENTION_VERSION } from './metrics.ts';
import { AI_PRICE_ARITHMETIC_VERSION } from './price-snapshot.ts';

export const NARRATIVE_QUALITY_BASELINE_MANIFEST_VERSION = 'narrative-quality-baseline-manifest-v1';

const fingerprint = z.string().regex(/^[0-9a-f]{64}$/);
const safeIdentifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/);
const executionProfileSchema = z
  .object({
    provider: z.enum([AiProvider.OPENAI, AiProvider.ANTHROPIC]),
    configuredModel: safeIdentifier,
    responseModel: safeIdentifier,
    effort: z.enum(['none', 'low', 'medium', 'high', 'xhigh', 'max']),
    maxOutputTokens: z.number().int().min(1).max(1_000_000),
  })
  .strict();

export const narrativeQualityBaselineManifestSchema = z
  .object({
    manifestVersion: z.literal(NARRATIVE_QUALITY_BASELINE_MANIFEST_VERSION),
    baselineId: z.string().regex(/^narrative-quality-baseline-[a-z0-9-]+-v[0-9]+$/),
    accepted: z.literal(true),
    reportVersion: z.literal(NARRATIVE_EVAL_REPORT_VERSION),
    datasetVersion: z.literal(NARRATIVE_QUALITY_DATASET_VERSION),
    datasetFingerprintBasisVersion: z.literal(DATASET_FINGERPRINT_BASIS_VERSION),
    datasetFingerprint: z.literal(NARRATIVE_QUALITY_DATASET_FINGERPRINT),
    dimensionMacroF1ConventionVersion: z.literal(DIMENSION_MACRO_F1_CONVENTION_VERSION),
    priceArithmeticVersion: z.literal(AI_PRICE_ARITHMETIC_VERSION),
    reportFingerprint: fingerprint,
    versions: evalContractVersionsSchema,
    profiles: z
      .object({
        generate: executionProfileSchema,
        judge: executionProfileSchema,
      })
      .strict(),
    allQualityGatesPassed: z.literal(true),
  })
  .strict();

export type NarrativeQualityBaselineManifest = z.infer<
  typeof narrativeQualityBaselineManifestSchema
>;

export const NARRATIVE_LIVE_BASELINE_OPERATION_PLAN = Object.freeze(
  [
    ...NARRATIVE_QUALITY_SEMANTIC_CASE_IDS.filter(
      (caseId) => !NARRATIVE_QUALITY_PRECHECK_CASE_IDS.includes(caseId as 'R09' | 'R20'),
    ).map((caseId) => ({ caseId, taskType: AiTaskType.JUDGE }) as const),
    ...NARRATIVE_QUALITY_SENTINEL_CASE_IDS.map(
      (caseId) => ({ caseId, taskType: AiTaskType.JUDGE }) as const,
    ),
    ...NARRATIVE_QUALITY_END_TO_END_CASE_IDS.flatMap((caseId) => [
      { caseId, taskType: AiTaskType.GENERATE } as const,
      { caseId, taskType: AiTaskType.JUDGE } as const,
    ]),
  ].map((operation, index) => ({
    logicalCallSequence: index + 1,
    ...operation,
  })),
);

export interface ValidateBaselineInput {
  readonly manifest: unknown;
  readonly report: NarrativeEvalReport;
}

function sameVersions(
  left: NarrativeQualityBaselineManifest['versions'],
  right: NarrativeEvalReport['versions'],
): boolean {
  return Object.keys(left).every(
    (key) =>
      left[key as keyof NarrativeQualityBaselineManifest['versions']] ===
      right[key as keyof NarrativeEvalReport['versions']],
  );
}

function hasExactLiveBaselineEvidence(report: NarrativeEvalReport): boolean {
  if (
    report.operations.length !== NARRATIVE_LIVE_BASELINE_OPERATION_PLAN.length ||
    report.operationalSummary.logicalCalls !== NARRATIVE_LIVE_BASELINE_OPERATION_PLAN.length ||
    report.operationalSummary.providerAttempts !== NARRATIVE_LIVE_BASELINE_OPERATION_PLAN.length ||
    report.operationalSummary.refusals !== 0
  ) {
    return false;
  }
  if (
    NARRATIVE_LIVE_BASELINE_OPERATION_PLAN.some((expected, index) => {
      const actual = report.operations[index];
      return (
        actual === undefined ||
        actual.logicalCallSequence !== expected.logicalCallSequence ||
        actual.caseId !== expected.caseId ||
        actual.taskType !== expected.taskType ||
        actual.attempts !== 1 ||
        actual.refused
      );
    })
  ) {
    return false;
  }
  return (
    report.cases.length === NARRATIVE_QUALITY_SEMANTIC_CASE_IDS.length &&
    NARRATIVE_QUALITY_SEMANTIC_CASE_IDS.every((caseId, index) => {
      const row = report.cases[index];
      const expectedStage = NARRATIVE_QUALITY_PRECHECK_CASE_IDS.includes(caseId as 'R09' | 'R20')
        ? 'PRECHECK'
        : 'JUDGE';
      return (
        row?.caseId === caseId &&
        row.expectedStage === expectedStage &&
        row.actualStage === expectedStage
      );
    })
  );
}

/** Validates a pinned, passing, model-exact rollback baseline without alias substitution. */
export function validateNarrativeQualityBaseline(
  input: ValidateBaselineInput,
): NarrativeQualityBaselineManifest {
  const parsed = narrativeQualityBaselineManifestSchema.safeParse(input.manifest);
  if (!parsed.success) {
    throw new EvalContractError(
      'INVALID_EVAL_INPUT',
      'The narrative-quality baseline manifest failed its strict schema.',
    );
  }
  verifyEvalReportFingerprint(input.report);
  const manifest = parsed.data;
  if (
    manifest.reportFingerprint !== input.report.reportFingerprint ||
    manifest.datasetFingerprint !== input.report.datasetFingerprint ||
    !sameVersions(manifest.versions, input.report.versions) ||
    !input.report.semantic.gates.passed ||
    !input.report.stability.gates.passed ||
    !input.report.endToEnd.gates.passed ||
    !hasExactLiveBaselineEvidence(input.report) ||
    input.report.operationalSummary.logicalCalls > LIVE_EVAL_HARD_CAPS.logicalCalls ||
    input.report.operationalSummary.providerAttempts > LIVE_EVAL_HARD_CAPS.providerAttempts ||
    input.report.operationalSummary.estimatedCostUsdMicros >
      LIVE_EVAL_HARD_CAPS.estimatedCostUsdMicros
  ) {
    throw new EvalContractError(
      'INVALID_EVAL_INPUT',
      'The baseline is not bound to this exact passing eval report.',
    );
  }

  const taskBindings = new Map([
    [AiTaskType.GENERATE, manifest.profiles.generate] as const,
    [AiTaskType.JUDGE, manifest.profiles.judge] as const,
  ]);
  for (const [taskType, profile] of taskBindings) {
    const operations = input.report.operations.filter(
      (operation) => operation.taskType === taskType,
    );
    if (
      operations.length === 0 ||
      operations.some(
        (operation) =>
          operation.provider !== profile.provider ||
          operation.configuredModel !== profile.configuredModel ||
          operation.responseModel !== profile.responseModel ||
          operation.configuredEffort !== profile.effort ||
          operation.configuredMaxOutputTokens !== profile.maxOutputTokens,
      )
    ) {
      throw new EvalContractError(
        'INVALID_EVAL_INPUT',
        `The report does not preserve the exact ${taskType} provider/model baseline binding.`,
      );
    }
  }
  return manifest;
}
