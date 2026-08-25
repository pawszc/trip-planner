import { canonicalizeJson, createInputFingerprint, type JsonObject } from '../ai/contracts.ts';
import { SUPPORTED_CURRENCY_CODES, type SupportedCurrencyCode } from '../domain/currency.ts';
import { DomainError } from '../domain/domain-error.ts';
import { parseStrictIsoDate } from '../validation/strict-iso-date.ts';
import type { GroundedOptionContext } from './grounded-option-context.ts';
import { NARRATIVE_FINALIZATION_VERSION } from './narrative-finalization.ts';
import { NARRATIVE_GENERATION_VIEW_VERSION } from './narrative-generation-view.ts';
import {
  buildNarrativeModelView,
  NARRATIVE_MODEL_VIEW_VERSION,
  type NarrativeModelView,
} from './narrative-model-view.ts';
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
import {
  OPTION_NARRATIVE_PROMPT_VERSION,
  OPTION_NARRATIVE_SCHEMA_VERSION,
  parseOptionNarrativeOutput,
  type OptionNarrativeOutput,
} from './option-narrative.ts';

export {
  NARRATIVE_CONSTRAINT_SNAPSHOT_VERSION,
  NARRATIVE_MODEL_PROFILE_VERSION,
  NARRATIVE_PRICE_CATALOG_VERSION,
  NARRATIVE_QUALITY_CONTEXT_VERSION,
} from './narrative-quality-versions.ts';

export const NARRATIVE_QUALITY_CONTEXT_MAX_BYTES = 64 * 1024;

export type NarrativeConstraintSnapshot = JsonObject & {
  readonly version: typeof NARRATIVE_CONSTRAINT_SNAPSHOT_VERSION;
  readonly startDate: string;
  readonly endDate: string;
  readonly adults: number;
  readonly currency: SupportedCurrencyCode;
  readonly hardBudgetLimit: boolean;
  readonly earliestDepartureTime: string | null;
  readonly latestReturnTime: string | null;
  readonly maxConnections: number;
  readonly maxTravelMinutes: number | null;
  readonly allowFlight: boolean;
  readonly allowTrain: boolean;
  readonly allowBus: boolean;
};

export type NarrativeQualityContractVersions = JsonObject & {
  readonly groundedContextVersion: string;
  readonly modelViewVersion: typeof NARRATIVE_MODEL_VIEW_VERSION;
  readonly generationViewVersion: typeof NARRATIVE_GENERATION_VIEW_VERSION;
  readonly finalizationVersion: typeof NARRATIVE_FINALIZATION_VERSION;
  readonly qualityContextVersion: typeof NARRATIVE_QUALITY_CONTEXT_VERSION;
  readonly constraintSnapshotVersion: typeof NARRATIVE_CONSTRAINT_SNAPSHOT_VERSION;
  readonly generatePromptVersion: typeof OPTION_NARRATIVE_PROMPT_VERSION;
  readonly generateSchemaVersion: typeof OPTION_NARRATIVE_SCHEMA_VERSION;
  readonly judgePromptVersion: typeof NARRATIVE_JUDGE_PROMPT_VERSION;
  readonly judgeSchemaVersion: typeof NARRATIVE_JUDGE_SCHEMA_VERSION;
  readonly rubricVersion: typeof NARRATIVE_QUALITY_RUBRIC_VERSION;
  readonly datasetVersion: typeof NARRATIVE_QUALITY_DATASET_VERSION;
  readonly publicationPolicyVersion: typeof NARRATIVE_PUBLICATION_POLICY_VERSION;
  readonly safetyPrecheckVersion: typeof NARRATIVE_SAFETY_PRECHECK_VERSION;
  readonly modelProfileVersion: typeof NARRATIVE_MODEL_PROFILE_VERSION;
  readonly priceCatalogVersion: typeof NARRATIVE_PRICE_CATALOG_VERSION;
};

export type NarrativeQualityContext = JsonObject & {
  readonly version: typeof NARRATIVE_QUALITY_CONTEXT_VERSION;
  readonly fingerprint: string;
  readonly groundedContextFingerprint: string;
  readonly modelViewFingerprint: string;
  readonly narrativeFingerprint: string;
  readonly modelView: NarrativeModelView;
  readonly narrative: OptionNarrativeOutput;
  readonly constraints: NarrativeConstraintSnapshot;
  readonly versions: NarrativeQualityContractVersions;
};

export interface NarrativeConstraintSnapshotInput {
  readonly version?: typeof NARRATIVE_CONSTRAINT_SNAPSHOT_VERSION;
  readonly startDate: string;
  readonly endDate: string;
  readonly adults: number;
  readonly currency: SupportedCurrencyCode;
  readonly hardBudgetLimit: boolean;
  readonly earliestDepartureTime: string | null;
  readonly latestReturnTime: string | null;
  readonly maxConnections: number;
  readonly maxTravelMinutes: number | null;
  readonly allowFlight: boolean;
  readonly allowTrain: boolean;
  readonly allowBus: boolean;
}

export interface BuildNarrativeQualityContextInput {
  readonly context: GroundedOptionContext;
  readonly modelView: NarrativeModelView;
  readonly narrativeOutput: unknown;
  readonly constraints: NarrativeConstraintSnapshotInput;
  readonly versions: NarrativeQualityContractVersions;
}

function invalidQualityContext(message: string): never {
  throw new DomainError('INVALID_NARRATIVE_QUALITY_CONTEXT', message);
}

function requireExactKeys(value: object, allowedKeys: readonly string[], field: string): void {
  const actual = Object.keys(value).sort((left, right) => left.localeCompare(right, 'en'));
  const expected = [...allowedKeys].sort((left, right) => left.localeCompare(right, 'en'));
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    invalidQualityContext(`Narrative quality field ${field} has an unknown or missing field.`);
  }
}

function requireVersion(value: string, expected: string, field: string): void {
  if (value !== expected) {
    invalidQualityContext(`Narrative quality version ${field} must be exactly ${expected}.`);
  }
}

function requireOptionalTime(value: string | null, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(value)) {
    invalidQualityContext(`Narrative constraint ${field} must be null or an exact HH:mm time.`);
  }
  return value;
}

function buildConstraintSnapshot(
  input: BuildNarrativeQualityContextInput['constraints'],
): NarrativeConstraintSnapshot {
  requireExactKeys(
    input,
    [
      ...(input.version === undefined ? [] : ['version']),
      'startDate',
      'endDate',
      'adults',
      'currency',
      'hardBudgetLimit',
      'earliestDepartureTime',
      'latestReturnTime',
      'maxConnections',
      'maxTravelMinutes',
      'allowFlight',
      'allowTrain',
      'allowBus',
    ],
    'constraints',
  );
  const version = input.version ?? NARRATIVE_CONSTRAINT_SNAPSHOT_VERSION;
  requireVersion(version, NARRATIVE_CONSTRAINT_SNAPSHOT_VERSION, 'constraintSnapshotVersion');
  if (
    typeof input.startDate !== 'string' ||
    typeof input.endDate !== 'string' ||
    parseStrictIsoDate(input.startDate) === null ||
    parseStrictIsoDate(input.endDate) === null
  ) {
    invalidQualityContext('Narrative constraints require exact calendar dates.');
  }
  if (input.startDate >= input.endDate) {
    invalidQualityContext('Narrative constraint endDate must be after startDate.');
  }
  if (!Number.isSafeInteger(input.adults) || input.adults < 1) {
    invalidQualityContext('Narrative constraint adults must be a positive safe integer.');
  }
  if (!SUPPORTED_CURRENCY_CODES.includes(input.currency)) {
    invalidQualityContext('Narrative constraint currency is not supported by v1.');
  }
  if (!Number.isSafeInteger(input.maxConnections) || input.maxConnections < 0) {
    invalidQualityContext('Narrative constraint maxConnections must be non-negative.');
  }
  if (
    input.maxTravelMinutes !== null &&
    (!Number.isSafeInteger(input.maxTravelMinutes) || input.maxTravelMinutes < 1)
  ) {
    invalidQualityContext('Narrative constraint maxTravelMinutes must be null or positive.');
  }
  if (
    typeof input.hardBudgetLimit !== 'boolean' ||
    typeof input.allowFlight !== 'boolean' ||
    typeof input.allowTrain !== 'boolean' ||
    typeof input.allowBus !== 'boolean'
  ) {
    invalidQualityContext('Narrative constraint flags must be exact booleans.');
  }
  if (!input.allowFlight && !input.allowTrain && !input.allowBus) {
    invalidQualityContext('Narrative constraints must allow at least one transport mode.');
  }
  return {
    version,
    startDate: input.startDate,
    endDate: input.endDate,
    adults: input.adults,
    currency: input.currency,
    hardBudgetLimit: input.hardBudgetLimit,
    earliestDepartureTime: requireOptionalTime(
      input.earliestDepartureTime,
      'earliestDepartureTime',
    ),
    latestReturnTime: requireOptionalTime(input.latestReturnTime, 'latestReturnTime'),
    maxConnections: input.maxConnections,
    maxTravelMinutes: input.maxTravelMinutes,
    allowFlight: input.allowFlight,
    allowTrain: input.allowTrain,
    allowBus: input.allowBus,
  };
}

function validateVersions(
  versions: NarrativeQualityContractVersions,
  context: GroundedOptionContext,
): NarrativeQualityContractVersions {
  requireExactKeys(
    versions,
    [
      'groundedContextVersion',
      'modelViewVersion',
      'generationViewVersion',
      'finalizationVersion',
      'qualityContextVersion',
      'constraintSnapshotVersion',
      'generatePromptVersion',
      'generateSchemaVersion',
      'judgePromptVersion',
      'judgeSchemaVersion',
      'rubricVersion',
      'datasetVersion',
      'publicationPolicyVersion',
      'safetyPrecheckVersion',
      'modelProfileVersion',
      'priceCatalogVersion',
    ],
    'versions',
  );
  requireVersion(versions.groundedContextVersion, context.version, 'groundedContextVersion');
  requireVersion(versions.modelViewVersion, NARRATIVE_MODEL_VIEW_VERSION, 'modelViewVersion');
  requireVersion(
    versions.generationViewVersion,
    NARRATIVE_GENERATION_VIEW_VERSION,
    'generationViewVersion',
  );
  requireVersion(
    versions.finalizationVersion,
    NARRATIVE_FINALIZATION_VERSION,
    'finalizationVersion',
  );
  requireVersion(
    versions.qualityContextVersion,
    NARRATIVE_QUALITY_CONTEXT_VERSION,
    'qualityContextVersion',
  );
  requireVersion(
    versions.constraintSnapshotVersion,
    NARRATIVE_CONSTRAINT_SNAPSHOT_VERSION,
    'constraintSnapshotVersion',
  );
  requireVersion(
    versions.generatePromptVersion,
    OPTION_NARRATIVE_PROMPT_VERSION,
    'generatePromptVersion',
  );
  requireVersion(
    versions.generateSchemaVersion,
    OPTION_NARRATIVE_SCHEMA_VERSION,
    'generateSchemaVersion',
  );
  requireVersion(versions.judgePromptVersion, NARRATIVE_JUDGE_PROMPT_VERSION, 'judgePromptVersion');
  requireVersion(versions.judgeSchemaVersion, NARRATIVE_JUDGE_SCHEMA_VERSION, 'judgeSchemaVersion');
  requireVersion(versions.rubricVersion, NARRATIVE_QUALITY_RUBRIC_VERSION, 'rubricVersion');
  requireVersion(versions.datasetVersion, NARRATIVE_QUALITY_DATASET_VERSION, 'datasetVersion');
  requireVersion(
    versions.publicationPolicyVersion,
    NARRATIVE_PUBLICATION_POLICY_VERSION,
    'publicationPolicyVersion',
  );
  requireVersion(
    versions.safetyPrecheckVersion,
    NARRATIVE_SAFETY_PRECHECK_VERSION,
    'safetyPrecheckVersion',
  );
  requireVersion(
    versions.modelProfileVersion,
    NARRATIVE_MODEL_PROFILE_VERSION,
    'modelProfileVersion',
  );
  requireVersion(
    versions.priceCatalogVersion,
    NARRATIVE_PRICE_CATALOG_VERSION,
    'priceCatalogVersion',
  );
  return {
    groundedContextVersion: versions.groundedContextVersion,
    modelViewVersion: versions.modelViewVersion,
    generationViewVersion: versions.generationViewVersion,
    finalizationVersion: versions.finalizationVersion,
    qualityContextVersion: versions.qualityContextVersion,
    constraintSnapshotVersion: versions.constraintSnapshotVersion,
    generatePromptVersion: versions.generatePromptVersion,
    generateSchemaVersion: versions.generateSchemaVersion,
    judgePromptVersion: versions.judgePromptVersion,
    judgeSchemaVersion: versions.judgeSchemaVersion,
    rubricVersion: versions.rubricVersion,
    datasetVersion: versions.datasetVersion,
    publicationPolicyVersion: versions.publicationPolicyVersion,
    safetyPrecheckVersion: versions.safetyPrecheckVersion,
    modelProfileVersion: versions.modelProfileVersion,
    priceCatalogVersion: versions.priceCatalogVersion,
  };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function assertQualitySize(value: JsonObject): void {
  if (Buffer.byteLength(canonicalizeJson(value), 'utf8') > NARRATIVE_QUALITY_CONTEXT_MAX_BYTES) {
    invalidQualityContext(
      `Narrative quality context exceeds the ${NARRATIVE_QUALITY_CONTEXT_MAX_BYTES}-byte v2 limit.`,
    );
  }
}

export function createNarrativeFingerprint(output: OptionNarrativeOutput): string {
  return createInputFingerprint(output);
}

export function buildNarrativeQualityContext(
  input: BuildNarrativeQualityContextInput,
): NarrativeQualityContext {
  const expectedModelView = buildNarrativeModelView(input.context);
  if (
    input.modelView.groundedContextFingerprint !== input.context.fingerprint ||
    input.modelView.fingerprint !== expectedModelView.fingerprint ||
    canonicalizeJson(input.modelView) !== canonicalizeJson(expectedModelView)
  ) {
    invalidQualityContext('Narrative model view does not match the exact grounded context.');
  }
  const narrative = parseOptionNarrativeOutput(input.narrativeOutput, input.context);
  const constraints = buildConstraintSnapshot(input.constraints);
  const versions = validateVersions(input.versions, input.context);
  const narrativeFingerprint = createNarrativeFingerprint(narrative);
  const fingerprintBasis: JsonObject = {
    version: NARRATIVE_QUALITY_CONTEXT_VERSION,
    groundedContextFingerprint: input.context.fingerprint,
    modelViewFingerprint: input.modelView.fingerprint,
    narrativeFingerprint,
    modelView: input.modelView,
    narrative,
    constraints,
    versions,
  };
  assertQualitySize(fingerprintBasis);
  const result: NarrativeQualityContext = {
    ...fingerprintBasis,
    version: NARRATIVE_QUALITY_CONTEXT_VERSION,
    fingerprint: createInputFingerprint(fingerprintBasis),
  } as NarrativeQualityContext;
  assertQualitySize(result);
  return deepFreeze(result);
}
