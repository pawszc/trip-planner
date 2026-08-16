import { randomUUID } from 'node:crypto';
import { isValidAiRunId } from '../ai/contracts.ts';
import { DomainError } from '../domain/domain-error.ts';
import { GROUNDED_OPTION_CONTEXT_VERSION } from './grounded-option-context.ts';
import type { NarrativePersistenceBundle, NarrativeRunRecord } from './narrative-persistence.ts';
import { NARRATIVE_MODEL_VIEW_VERSION } from './narrative-model-view.ts';
import {
  OPTION_NARRATIVE_PROMPT_VERSION,
  OPTION_NARRATIVE_SCHEMA_VERSION,
} from './option-narrative.ts';
import type { NarrativeQualityContractVersions } from './narrative-quality-context.ts';
import {
  NARRATIVE_CONSTRAINT_SNAPSHOT_VERSION,
  NARRATIVE_JUDGE_PROMPT_VERSION,
  NARRATIVE_JUDGE_SCHEMA_VERSION,
  NARRATIVE_MODEL_PROFILE_VERSION,
  NARRATIVE_PRICE_CATALOG_VERSION,
  NARRATIVE_PUBLICATION_POLICY_VERSION,
  NARRATIVE_QUALITY_CONTEXT_VERSION,
  NARRATIVE_QUALITY_DATASET_VERSION,
  NARRATIVE_QUALITY_RUBRIC_VERSION,
  NARRATIVE_SAFETY_PRECHECK_VERSION,
} from './narrative-quality-versions.ts';

export const NARRATIVE_REVIEW_DIMENSION_VALUES = [
  'FACTUAL_ENTAILMENT',
  'REFERENCE_RELEVANCE',
  'UNKNOWN_MISSING_DISCIPLINE',
  'CONSTRAINT_RANKING_FIDELITY',
  'MONEY_DATE_TIME_FIDELITY',
  'PROVENANCE_INTEGRITY',
  'SAFETY_INSTRUCTION_INTEGRITY',
  'RELEVANCE_AND_BLOCK_KIND',
] as const;

export type NarrativeReviewDimension = (typeof NARRATIVE_REVIEW_DIMENSION_VALUES)[number];
export type NarrativeReviewDimensionResult = 'PASS' | 'FAIL';
export type NarrativeReviewDimensionResults = Readonly<
  Record<NarrativeReviewDimension, NarrativeReviewDimensionResult>
>;

export const NARRATIVE_REVIEW_FINDING_CODE_VALUES = [
  'REFERENCE_DOES_NOT_SUPPORT_CLAIM',
  'UNSUPPORTED_CLAIM',
  'CONTRADICTS_GROUNDED_FACT',
  'CLAIM_MISSING_SUPPORT',
  'FILLS_UNKNOWN_OR_MISSING',
  'MONEY_VALUE_MISMATCH',
  'MONEY_CALCULATION_OR_REFORMAT',
  'DATE_TIME_MISMATCH',
  'RANKING_ROLE_MISMATCH',
  'HARD_CONSTRAINT_RELAXATION',
  'PROVENANCE_OVERSTATED',
  'AVAILABILITY_OR_BOOKING_GUARANTEE',
  'UNSUPPORTED_LEGAL_VISA_HEALTH_OR_ACCESSIBILITY_ADVICE',
  'UNSAFE_OR_ILLEGAL_GUIDANCE',
  'PROMPT_INJECTION_FOLLOWED',
  'UNTRUSTED_CONTENT_EXPOSED',
  'PII_OR_SECRET_EXPOSURE',
  'IRRELEVANT_OR_WRONG_BLOCK_KIND',
  'CROSS_BLOCK_CONTRADICTION',
] as const;

export type NarrativeReviewFindingCode = (typeof NARRATIVE_REVIEW_FINDING_CODE_VALUES)[number];
export type NarrativeReviewFindingSeverity = 'MAJOR' | 'CRITICAL';

export const NARRATIVE_REVIEW_FAILURE_CODE_VALUES = [
  'PRECHECK_REJECTED',
  'SEMANTIC_REJECTED',
  'MISSING_CREDENTIALS',
  'INVALID_AI_CONFIGURATION',
  'UNSUPPORTED_AI_PROVIDER',
  'AI_AUDIT_FAILED',
  'AUTHENTICATION_FAILED',
  'MODEL_ACCESS_DENIED',
  'RATE_LIMITED',
  'AI_TIMEOUT',
  'PROVIDER_UNAVAILABLE',
  'PROVIDER_ERROR',
  'MODEL_REFUSAL',
  'EMPTY_MODEL_OUTPUT',
  'INVALID_STRUCTURED_OUTPUT',
  'INVALID_NARRATIVE_MODEL_VIEW',
  'INVALID_NARRATIVE_QUALITY_CONTEXT',
  'INVALID_NARRATIVE_JUDGE_OUTPUT',
  'AUDIT_LINKAGE_MISMATCH',
  'PRODUCT_WRITE_FAILED',
] as const;

export type NarrativeReviewFailureCode = (typeof NARRATIVE_REVIEW_FAILURE_CODE_VALUES)[number];
export type NarrativeReviewStage = 'GENERATE' | 'PRECHECK' | 'JUDGE';
export type NarrativeReviewAiRunStatus = 'STARTED' | 'SUCCEEDED' | 'FAILED';

export interface NarrativeReviewAiRunExpectation {
  readonly ID: string;
  readonly planningRun_ID: string;
  readonly status: NarrativeReviewAiRunStatus;
  readonly taskType: 'GENERATE' | 'JUDGE';
  readonly promptVersion: string;
  readonly schemaVersion: string;
  readonly inputFingerprint: string;
}

export interface NarrativeReviewFindingInput {
  readonly reasonCode: NarrativeReviewFindingCode;
  readonly severity: NarrativeReviewFindingSeverity;
  readonly blockSequences: readonly number[];
  readonly factIds: readonly string[];
}

export type NarrativeReviewPersistenceVersions = NarrativeQualityContractVersions;

export interface NarrativeReviewRunRecord {
  readonly ID: string;
  readonly planningRun_ID: string;
  readonly rankedOption_ID: string;
  readonly generateAiRunId: string;
  readonly judgeAiRunId: string | null;
  readonly contextVersion: string;
  readonly contextFingerprint: string;
  readonly modelViewVersion: string;
  readonly modelViewFingerprint: string;
  readonly narrativeFingerprint: string | null;
  readonly qualityContextVersion: string;
  readonly qualityContextFingerprint: string | null;
  readonly constraintSnapshotVersion: string;
  readonly safetyPrecheckVersion: string;
  readonly generatePromptVersion: string;
  readonly generateSchemaVersion: string;
  readonly judgePromptVersion: string;
  readonly judgeSchemaVersion: string;
  readonly rubricVersion: string;
  readonly publicationPolicyVersion: string;
  readonly datasetVersion: string;
  readonly modelProfileVersion: string;
  readonly priceCatalogVersion: string;
  readonly stage: NarrativeReviewStage;
  readonly decision: 'PUBLISH' | 'REJECT';
  readonly failureCode: NarrativeReviewFailureCode | null;
  readonly factualEntailmentResult: NarrativeReviewDimensionResult | null;
  readonly referenceRelevanceResult: NarrativeReviewDimensionResult | null;
  readonly unknownMissingDisciplineResult: NarrativeReviewDimensionResult | null;
  readonly constraintRankingFidelityResult: NarrativeReviewDimensionResult | null;
  readonly moneyDateTimeFidelityResult: NarrativeReviewDimensionResult | null;
  readonly provenanceIntegrityResult: NarrativeReviewDimensionResult | null;
  readonly safetyInstructionIntegrityResult: NarrativeReviewDimensionResult | null;
  readonly relevanceAndBlockKindResult: NarrativeReviewDimensionResult | null;
  readonly passedDimensionCount: number;
  readonly failedDimensionCount: number;
  readonly findingCount: number;
  readonly majorFindingCount: number;
  readonly criticalFindingCount: number;
  readonly completedAt: string;
}

export interface NarrativeReviewFindingRecord {
  readonly ID: string;
  readonly narrativeReviewRun_ID: string;
  readonly planningRun_ID: string;
  readonly rankedOption_ID: string;
  readonly sequence: number;
  readonly reasonCode: NarrativeReviewFindingCode;
  readonly severity: NarrativeReviewFindingSeverity;
  readonly blockSequences: string;
  readonly factIds: string | null;
  readonly blockSequenceCount: number;
  readonly factIdCount: number;
}

export interface NarrativeReviewPersistenceBundle {
  readonly expectedGenerateAiRun: NarrativeReviewAiRunExpectation;
  readonly expectedJudgeAiRun?: NarrativeReviewAiRunExpectation;
  readonly reviewRun: NarrativeReviewRunRecord;
  readonly findings: readonly NarrativeReviewFindingRecord[];
}

export interface ReviewedNarrativeRunRecord extends NarrativeRunRecord {
  readonly reviewRunId: string;
  readonly judgeAiRunId: string;
  readonly modelViewVersion: string;
  readonly modelViewFingerprint: string;
  readonly narrativeFingerprint: string;
  readonly qualityContextVersion: string;
  readonly qualityContextFingerprint: string;
  readonly constraintSnapshotVersion: string;
  readonly safetyPrecheckVersion: string;
  readonly judgePromptVersion: string;
  readonly judgeSchemaVersion: string;
  readonly rubricVersion: string;
  readonly publicationPolicyVersion: string;
  readonly datasetVersion: string;
  readonly modelProfileVersion: string;
  readonly priceCatalogVersion: string;
}

export interface NarrativeReviewPublicationBundle extends NarrativeReviewPersistenceBundle {
  readonly expectedJudgeAiRun: NarrativeReviewAiRunExpectation;
  readonly narrativeRun: ReviewedNarrativeRunRecord;
  readonly optionNarratives: NarrativePersistenceBundle['optionNarratives'];
  readonly factReferences: NarrativePersistenceBundle['factReferences'];
}

interface CommonReviewInput {
  readonly planningRunId: string;
  readonly rankedOptionId: string;
  readonly generateAudit: NarrativeReviewAiRunExpectation;
  readonly judgeAiRunId?: string;
  readonly judgeAudit?: NarrativeReviewAiRunExpectation;
  readonly contextFingerprint: string;
  readonly modelViewFingerprint: string;
  readonly narrativeFingerprint?: string | null;
  readonly qualityContextFingerprint?: string | null;
  readonly versions: NarrativeReviewPersistenceVersions;
  readonly completedAt: string;
  readonly generateId?: () => string;
}

export interface NarrativeReviewRejectionInput extends CommonReviewInput {
  readonly stage: NarrativeReviewStage;
  readonly failureCode: NarrativeReviewFailureCode;
  readonly dimensions?: NarrativeReviewDimensionResults | null;
  readonly findings?: readonly NarrativeReviewFindingInput[];
}

export interface NarrativeReviewPublicationInput extends CommonReviewInput {
  readonly judgeAudit: NarrativeReviewAiRunExpectation;
  readonly narrativeFingerprint: string;
  readonly qualityContextFingerprint: string;
  readonly dimensions: NarrativeReviewDimensionResults;
  readonly narrativeBundle: NarrativePersistenceBundle;
}

const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/u;
const FACT_ID_PATTERN = /^fact_[a-f0-9]{64}$/u;
const FINDING_CODES = new Set<string>(NARRATIVE_REVIEW_FINDING_CODE_VALUES);
const FAILURE_CODES = new Set<string>(NARRATIVE_REVIEW_FAILURE_CODE_VALUES);
const DIMENSIONS = new Set<string>(NARRATIVE_REVIEW_DIMENSION_VALUES);

function invalidReviewPersistence(message: string): never {
  throw new DomainError('INVALID_NARRATIVE_REVIEW_PERSISTENCE', message);
}

function requireVersion(value: string, field: string): string {
  const normalized = value.trim();
  const hasControlCharacter = [...normalized].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
  });
  if (normalized.length === 0 || normalized.length > 160 || hasControlCharacter) {
    invalidReviewPersistence(`Narrative review ${field} is invalid.`);
  }
  return normalized;
}

function requireExactVersion(value: string, expected: string, field: string): void {
  requireVersion(value, field);
  if (value !== expected) {
    invalidReviewPersistence(`Narrative review ${field} must be exactly ${expected}.`);
  }
}

function requireFingerprint(value: string, field: string): string {
  if (!FINGERPRINT_PATTERN.test(value)) {
    invalidReviewPersistence(`Narrative review ${field} must be a canonical SHA-256 value.`);
  }
  return value;
}

function optionalFingerprint(value: string | null | undefined, field: string): string | null {
  return value === null || value === undefined ? null : requireFingerprint(value, field);
}

function requireTimestamp(value: string): string {
  if (value.trim().length === 0 || Number.isNaN(Date.parse(value))) {
    invalidReviewPersistence('Narrative review completedAt must be a valid timestamp.');
  }
  return value;
}

function requireUuid(value: string, field: string): string {
  if (!isValidAiRunId(value)) {
    invalidReviewPersistence(`Narrative review ${field} must be a UUID.`);
  }
  return value;
}

function normalizeAudit(
  audit: NarrativeReviewAiRunExpectation,
  planningRunId: string,
  taskType: 'GENERATE' | 'JUDGE',
): NarrativeReviewAiRunExpectation {
  if (audit.taskType !== taskType || audit.planningRun_ID !== planningRunId) {
    invalidReviewPersistence(`Narrative review ${taskType} audit lineage is invalid.`);
  }
  if (!['STARTED', 'SUCCEEDED', 'FAILED'].includes(audit.status)) {
    invalidReviewPersistence(`Narrative review ${taskType} audit status is invalid.`);
  }
  return {
    ID: requireUuid(audit.ID, `${taskType.toLowerCase()}AiRunId`),
    planningRun_ID: planningRunId,
    status: audit.status,
    taskType,
    promptVersion: requireVersion(audit.promptVersion, `${taskType} promptVersion`),
    schemaVersion: requireVersion(audit.schemaVersion, `${taskType} schemaVersion`),
    inputFingerprint: requireFingerprint(audit.inputFingerprint, `${taskType} inputFingerprint`),
  };
}

function normalizeDimensions(
  input: NarrativeReviewDimensionResults | null | undefined,
): NarrativeReviewDimensionResults | null {
  if (input === null || input === undefined) return null;
  const keys = Object.keys(input);
  if (keys.length !== NARRATIVE_REVIEW_DIMENSION_VALUES.length) {
    invalidReviewPersistence('Narrative review dimensions must contain the exact v1 set.');
  }
  for (const key of keys) {
    if (!DIMENSIONS.has(key) || (input as Readonly<Record<string, unknown>>)[key] === undefined) {
      invalidReviewPersistence('Narrative review dimensions contain an unknown field.');
    }
  }
  const normalized = {} as Record<NarrativeReviewDimension, NarrativeReviewDimensionResult>;
  for (const dimension of NARRATIVE_REVIEW_DIMENSION_VALUES) {
    const result = input[dimension];
    if (result !== 'PASS' && result !== 'FAIL') {
      invalidReviewPersistence(`Narrative review dimension ${dimension} is invalid.`);
    }
    normalized[dimension] = result;
  }
  return normalized;
}

function normalizeFinding(
  finding: NarrativeReviewFindingInput,
  sequence: number,
  reviewRunId: string,
  planningRunId: string,
  rankedOptionId: string,
  nextId: () => string,
): NarrativeReviewFindingRecord {
  if (typeof finding !== 'object' || finding === null) {
    invalidReviewPersistence('Narrative review finding must be a controlled object.');
  }
  if (!FINDING_CODES.has(finding.reasonCode)) {
    invalidReviewPersistence('Narrative review finding reason code is invalid.');
  }
  if (finding.severity !== 'MAJOR' && finding.severity !== 'CRITICAL') {
    invalidReviewPersistence('Narrative review finding severity is invalid.');
  }
  if (!Array.isArray(finding.blockSequences) || finding.blockSequences.length === 0) {
    invalidReviewPersistence('Narrative review finding requires at least one block sequence.');
  }
  const blockSequences = [...finding.blockSequences].sort((left, right) => left - right);
  if (
    blockSequences.some(
      (value, index) =>
        !Number.isSafeInteger(value) ||
        value < 1 ||
        value > 8 ||
        (index > 0 && value === blockSequences[index - 1]),
    )
  ) {
    invalidReviewPersistence('Narrative review finding block sequences are invalid.');
  }
  if (!Array.isArray(finding.factIds) || finding.factIds.length > 32) {
    invalidReviewPersistence('Narrative review finding fact IDs must be an array.');
  }
  const factIds = [...finding.factIds].sort();
  if (
    factIds.some(
      (value, index) => !FACT_ID_PATTERN.test(value) || (index > 0 && value === factIds[index - 1]),
    )
  ) {
    invalidReviewPersistence('Narrative review finding fact IDs are invalid.');
  }

  return {
    ID: nextId(),
    narrativeReviewRun_ID: reviewRunId,
    planningRun_ID: planningRunId,
    rankedOption_ID: rankedOptionId,
    sequence,
    reasonCode: finding.reasonCode,
    severity: finding.severity,
    blockSequences: blockSequences.join(','),
    factIds: factIds.length === 0 ? null : factIds.join(','),
    blockSequenceCount: blockSequences.length,
    factIdCount: factIds.length,
  };
}

function createIdGenerator(source: () => string): () => string {
  const generated = new Set<string>();
  return () => {
    const ID = requireUuid(source(), 'generated ID');
    if (generated.has(ID)) {
      invalidReviewPersistence('Narrative review generated IDs must be unique.');
    }
    generated.add(ID);
    return ID;
  };
}

function validateVersions(
  versions: NarrativeReviewPersistenceVersions,
  generateAudit: NarrativeReviewAiRunExpectation,
  judgeAudit: NarrativeReviewAiRunExpectation | undefined,
): NarrativeReviewPersistenceVersions {
  for (const [value, expected, field] of [
    [versions.groundedContextVersion, GROUNDED_OPTION_CONTEXT_VERSION, 'groundedContextVersion'],
    [versions.modelViewVersion, NARRATIVE_MODEL_VIEW_VERSION, 'modelViewVersion'],
    [versions.qualityContextVersion, NARRATIVE_QUALITY_CONTEXT_VERSION, 'qualityContextVersion'],
    [
      versions.constraintSnapshotVersion,
      NARRATIVE_CONSTRAINT_SNAPSHOT_VERSION,
      'constraintSnapshotVersion',
    ],
    [versions.generatePromptVersion, OPTION_NARRATIVE_PROMPT_VERSION, 'generatePromptVersion'],
    [versions.generateSchemaVersion, OPTION_NARRATIVE_SCHEMA_VERSION, 'generateSchemaVersion'],
    [versions.judgePromptVersion, NARRATIVE_JUDGE_PROMPT_VERSION, 'judgePromptVersion'],
    [versions.judgeSchemaVersion, NARRATIVE_JUDGE_SCHEMA_VERSION, 'judgeSchemaVersion'],
    [versions.rubricVersion, NARRATIVE_QUALITY_RUBRIC_VERSION, 'rubricVersion'],
    [versions.datasetVersion, NARRATIVE_QUALITY_DATASET_VERSION, 'datasetVersion'],
    [
      versions.publicationPolicyVersion,
      NARRATIVE_PUBLICATION_POLICY_VERSION,
      'publicationPolicyVersion',
    ],
    [versions.modelProfileVersion, NARRATIVE_MODEL_PROFILE_VERSION, 'modelProfileVersion'],
    [versions.priceCatalogVersion, NARRATIVE_PRICE_CATALOG_VERSION, 'priceCatalogVersion'],
    [versions.safetyPrecheckVersion, NARRATIVE_SAFETY_PRECHECK_VERSION, 'safetyPrecheckVersion'],
  ] as const) {
    requireExactVersion(value, expected, field);
  }
  const normalized: NarrativeReviewPersistenceVersions = { ...versions };
  if (
    normalized.generatePromptVersion !== generateAudit.promptVersion ||
    normalized.generateSchemaVersion !== generateAudit.schemaVersion
  ) {
    invalidReviewPersistence('Narrative review GENERATE audit versions do not match contracts.');
  }
  if (
    judgeAudit !== undefined &&
    (normalized.judgePromptVersion !== judgeAudit.promptVersion ||
      normalized.judgeSchemaVersion !== judgeAudit.schemaVersion)
  ) {
    invalidReviewPersistence('Narrative review JUDGE audit versions do not match contracts.');
  }
  return normalized;
}

function buildReviewBundle(
  input: CommonReviewInput,
  stage: NarrativeReviewStage,
  decision: 'PUBLISH' | 'REJECT',
  failureCode: NarrativeReviewFailureCode | null,
  dimensionInput: NarrativeReviewDimensionResults | null | undefined,
  findingInputs: readonly NarrativeReviewFindingInput[],
): NarrativeReviewPersistenceBundle {
  const planningRunId = requireUuid(input.planningRunId, 'planningRunId');
  const rankedOptionId = requireUuid(input.rankedOptionId, 'rankedOptionId');
  const generateAudit = normalizeAudit(input.generateAudit, planningRunId, 'GENERATE');
  const judgeAudit =
    input.judgeAudit === undefined
      ? undefined
      : normalizeAudit(input.judgeAudit, planningRunId, 'JUDGE');
  const judgeAiRunId =
    input.judgeAiRunId === undefined
      ? judgeAudit?.ID
      : requireUuid(input.judgeAiRunId, 'judgeAiRunId');
  if (judgeAudit !== undefined && judgeAiRunId !== judgeAudit.ID) {
    invalidReviewPersistence('Narrative review JUDGE audit ID does not match its scalar linkage.');
  }
  const versions = validateVersions(input.versions, generateAudit, judgeAudit);
  const dimensions = normalizeDimensions(dimensionInput);
  const nextId = createIdGenerator(input.generateId ?? randomUUID);
  const reviewRunId = nextId();
  if (findingInputs.length > 64) {
    invalidReviewPersistence('Narrative review cannot persist more than 64 findings.');
  }
  const findings = findingInputs.map((finding, index) =>
    normalizeFinding(finding, index + 1, reviewRunId, planningRunId, rankedOptionId, nextId),
  );
  const passedDimensionCount =
    dimensions === null
      ? 0
      : NARRATIVE_REVIEW_DIMENSION_VALUES.filter((dimension) => dimensions[dimension] === 'PASS')
          .length;
  const failedDimensionCount = dimensions === null ? 0 : 8 - passedDimensionCount;

  return {
    expectedGenerateAiRun: generateAudit,
    ...(judgeAudit === undefined ? {} : { expectedJudgeAiRun: judgeAudit }),
    reviewRun: {
      ID: reviewRunId,
      planningRun_ID: planningRunId,
      rankedOption_ID: rankedOptionId,
      generateAiRunId: generateAudit.ID,
      judgeAiRunId: judgeAiRunId ?? null,
      contextVersion: versions.groundedContextVersion,
      contextFingerprint: requireFingerprint(input.contextFingerprint, 'contextFingerprint'),
      modelViewVersion: versions.modelViewVersion,
      modelViewFingerprint: requireFingerprint(input.modelViewFingerprint, 'modelViewFingerprint'),
      narrativeFingerprint: optionalFingerprint(input.narrativeFingerprint, 'narrativeFingerprint'),
      qualityContextVersion: versions.qualityContextVersion,
      qualityContextFingerprint: optionalFingerprint(
        input.qualityContextFingerprint,
        'qualityContextFingerprint',
      ),
      constraintSnapshotVersion: versions.constraintSnapshotVersion,
      safetyPrecheckVersion: versions.safetyPrecheckVersion,
      generatePromptVersion: versions.generatePromptVersion,
      generateSchemaVersion: versions.generateSchemaVersion,
      judgePromptVersion: versions.judgePromptVersion,
      judgeSchemaVersion: versions.judgeSchemaVersion,
      rubricVersion: versions.rubricVersion,
      publicationPolicyVersion: versions.publicationPolicyVersion,
      datasetVersion: versions.datasetVersion,
      modelProfileVersion: versions.modelProfileVersion,
      priceCatalogVersion: versions.priceCatalogVersion,
      stage,
      decision,
      failureCode,
      factualEntailmentResult: dimensions?.FACTUAL_ENTAILMENT ?? null,
      referenceRelevanceResult: dimensions?.REFERENCE_RELEVANCE ?? null,
      unknownMissingDisciplineResult: dimensions?.UNKNOWN_MISSING_DISCIPLINE ?? null,
      constraintRankingFidelityResult: dimensions?.CONSTRAINT_RANKING_FIDELITY ?? null,
      moneyDateTimeFidelityResult: dimensions?.MONEY_DATE_TIME_FIDELITY ?? null,
      provenanceIntegrityResult: dimensions?.PROVENANCE_INTEGRITY ?? null,
      safetyInstructionIntegrityResult: dimensions?.SAFETY_INSTRUCTION_INTEGRITY ?? null,
      relevanceAndBlockKindResult: dimensions?.RELEVANCE_AND_BLOCK_KIND ?? null,
      passedDimensionCount,
      failedDimensionCount,
      findingCount: findings.length,
      majorFindingCount: findings.filter((finding) => finding.severity === 'MAJOR').length,
      criticalFindingCount: findings.filter((finding) => finding.severity === 'CRITICAL').length,
      completedAt: requireTimestamp(input.completedAt),
    },
    findings,
  };
}

/**
 * Builds rejection-only metadata. The input deliberately has no narrative output or text field,
 * so a candidate, prompt, context, raw judge output or rationale cannot enter the bundle.
 */
export function buildNarrativeReviewRejectionBundle(
  input: NarrativeReviewRejectionInput,
): NarrativeReviewPersistenceBundle {
  if (!['GENERATE', 'PRECHECK', 'JUDGE'].includes(input.stage)) {
    invalidReviewPersistence('Narrative review stage is invalid.');
  }
  if (!FAILURE_CODES.has(input.failureCode)) {
    invalidReviewPersistence('Narrative review failureCode is not in the closed catalog.');
  }
  const dimensions = normalizeDimensions(input.dimensions);
  const findings = input.findings ?? [];
  if (!Array.isArray(findings)) {
    invalidReviewPersistence('Narrative review findings must be an array.');
  }
  if (input.stage === 'GENERATE') {
    if (
      input.generateAudit.status === 'SUCCEEDED' ||
      input.failureCode === 'PRECHECK_REJECTED' ||
      input.failureCode === 'SEMANTIC_REJECTED' ||
      input.judgeAiRunId !== undefined ||
      input.judgeAudit !== undefined ||
      dimensions !== null ||
      findings.length !== 0 ||
      (input.narrativeFingerprint !== undefined && input.narrativeFingerprint !== null) ||
      (input.qualityContextFingerprint !== undefined && input.qualityContextFingerprint !== null)
    ) {
      invalidReviewPersistence(
        'A GENERATE failure requires STARTED/FAILED audit metadata without candidate evidence.',
      );
    }
  } else if (input.stage === 'PRECHECK') {
    if (
      input.generateAudit.status !== 'SUCCEEDED' ||
      input.judgeAiRunId !== undefined ||
      input.judgeAudit !== undefined ||
      dimensions !== null ||
      input.narrativeFingerprint === undefined ||
      input.narrativeFingerprint === null ||
      (input.failureCode !== 'PRECHECK_REJECTED' && findings.length !== 0) ||
      input.failureCode === 'SEMANTIC_REJECTED'
    ) {
      invalidReviewPersistence('A PRECHECK rejection cannot claim JUDGE execution or dimensions.');
    }
  } else if (input.failureCode === 'SEMANTIC_REJECTED') {
    if (
      input.generateAudit.status !== 'SUCCEEDED' ||
      input.judgeAudit?.status !== 'SUCCEEDED' ||
      dimensions === null ||
      input.narrativeFingerprint === undefined ||
      input.narrativeFingerprint === null ||
      input.qualityContextFingerprint === undefined ||
      input.qualityContextFingerprint === null
    ) {
      invalidReviewPersistence('A semantic rejection requires exact SUCCEEDED JUDGE evidence.');
    }
    const hasFailedDimension = NARRATIVE_REVIEW_DIMENSION_VALUES.some(
      (dimension) => dimensions[dimension] === 'FAIL',
    );
    if (!hasFailedDimension && findings.length === 0) {
      invalidReviewPersistence('An all-pass, finding-free semantic result cannot be rejected.');
    }
  } else if (
    input.generateAudit.status !== 'SUCCEEDED' ||
    input.narrativeFingerprint === undefined ||
    input.narrativeFingerprint === null ||
    input.qualityContextFingerprint === undefined ||
    input.qualityContextFingerprint === null ||
    dimensions !== null ||
    findings.length !== 0
  ) {
    invalidReviewPersistence('A technical JUDGE failure cannot persist untrusted judge findings.');
  }

  return buildReviewBundle(input, input.stage, 'REJECT', input.failureCode, dimensions, findings);
}

/** Builds the only bundle eligible for atomic review + narrative publication. */
export function buildNarrativeReviewPublicationBundle(
  input: NarrativeReviewPublicationInput,
): NarrativeReviewPublicationBundle {
  const dimensions = normalizeDimensions(input.dimensions);
  if (
    input.generateAudit.status !== 'SUCCEEDED' ||
    input.judgeAudit.status !== 'SUCCEEDED' ||
    dimensions === null ||
    NARRATIVE_REVIEW_DIMENSION_VALUES.some((dimension) => dimensions[dimension] !== 'PASS')
  ) {
    invalidReviewPersistence('Narrative publication requires an all-pass SUCCEEDED JUDGE.');
  }
  if (
    input.narrativeBundle.expectedAiRun.ID !== input.generateAudit.ID ||
    input.narrativeBundle.expectedAiRun.planningRun_ID !== input.planningRunId ||
    input.narrativeBundle.expectedAiRun.status !== input.generateAudit.status ||
    input.narrativeBundle.expectedAiRun.taskType !== input.generateAudit.taskType ||
    input.narrativeBundle.expectedAiRun.promptVersion !== input.generateAudit.promptVersion ||
    input.narrativeBundle.expectedAiRun.schemaVersion !== input.generateAudit.schemaVersion ||
    input.narrativeBundle.expectedAiRun.inputFingerprint !== input.generateAudit.inputFingerprint ||
    input.narrativeBundle.narrativeRun.planningRun_ID !== input.planningRunId ||
    input.narrativeBundle.narrativeRun.rankedOption_ID !== input.rankedOptionId ||
    input.narrativeBundle.narrativeRun.aiRunId !== input.generateAudit.ID ||
    input.narrativeBundle.narrativeRun.contextVersion !== input.versions.groundedContextVersion ||
    input.narrativeBundle.narrativeRun.contextFingerprint !== input.contextFingerprint ||
    input.narrativeBundle.narrativeRun.promptVersion !== input.versions.generatePromptVersion ||
    input.narrativeBundle.narrativeRun.schemaVersion !== input.versions.generateSchemaVersion ||
    input.narrativeBundle.narrativeRun.blockCount !==
      input.narrativeBundle.optionNarratives.length ||
    input.narrativeBundle.optionNarratives.length === 0 ||
    input.narrativeBundle.optionNarratives.some(
      (block) =>
        block.narrativeRun_ID !== input.narrativeBundle.narrativeRun.ID ||
        block.planningRun_ID !== input.planningRunId ||
        block.rankedOption_ID !== input.rankedOptionId ||
        !input.narrativeBundle.factReferences.some(
          (reference) => reference.optionNarrative_ID === block.ID,
        ),
    ) ||
    input.narrativeBundle.factReferences.some(
      (reference) =>
        reference.narrativeRun_ID !== input.narrativeBundle.narrativeRun.ID ||
        reference.planningRun_ID !== input.planningRunId ||
        reference.rankedOption_ID !== input.rankedOptionId ||
        !FACT_ID_PATTERN.test(reference.factId) ||
        !input.narrativeBundle.optionNarratives.some(
          (block) => block.ID === reference.optionNarrative_ID,
        ),
    )
  ) {
    invalidReviewPersistence(
      'Narrative publication bundle lineage does not match review evidence.',
    );
  }

  const review = buildReviewBundle(input, 'JUDGE', 'PUBLISH', null, dimensions, []);
  if (review.expectedJudgeAiRun?.status !== 'SUCCEEDED') {
    invalidReviewPersistence('Narrative publication has no terminal JUDGE audit expectation.');
  }
  const row = review.reviewRun;
  return {
    ...review,
    expectedJudgeAiRun: review.expectedJudgeAiRun,
    narrativeRun: {
      ...input.narrativeBundle.narrativeRun,
      reviewRunId: row.ID,
      judgeAiRunId: review.expectedJudgeAiRun.ID,
      modelViewVersion: row.modelViewVersion,
      modelViewFingerprint: row.modelViewFingerprint,
      narrativeFingerprint: row.narrativeFingerprint!,
      qualityContextVersion: row.qualityContextVersion,
      qualityContextFingerprint: row.qualityContextFingerprint!,
      constraintSnapshotVersion: row.constraintSnapshotVersion,
      safetyPrecheckVersion: row.safetyPrecheckVersion,
      judgePromptVersion: row.judgePromptVersion,
      judgeSchemaVersion: row.judgeSchemaVersion,
      rubricVersion: row.rubricVersion,
      publicationPolicyVersion: row.publicationPolicyVersion,
      datasetVersion: row.datasetVersion,
      modelProfileVersion: row.modelProfileVersion,
      priceCatalogVersion: row.priceCatalogVersion,
    },
    optionNarratives: input.narrativeBundle.optionNarratives,
    factReferences: input.narrativeBundle.factReferences,
  };
}
