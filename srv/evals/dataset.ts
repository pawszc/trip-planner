import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { canonicalizeJson, createInputFingerprint, type JsonValue } from '../ai/contracts.ts';
import type { GroundedOptionContext } from '../narratives/grounded-option-context.ts';
import {
  parseOptionNarrativeOutput,
  type OptionNarrativeOutput,
} from '../narratives/option-narrative.ts';
import {
  NARRATIVE_PUBLICATION_POLICY_VERSION,
  NARRATIVE_QUALITY_DATASET_VERSION,
  NARRATIVE_QUALITY_RUBRIC_VERSION,
} from '../narratives/narrative-quality-versions.ts';

export {
  NARRATIVE_PUBLICATION_POLICY_VERSION,
  NARRATIVE_QUALITY_DATASET_VERSION,
  NARRATIVE_QUALITY_RUBRIC_VERSION,
} from '../narratives/narrative-quality-versions.ts';

/**
 * v1 fingerprints the UTF-8 bytes of canonical JSON for the parsed dataset: object keys are
 * recursively sorted and array order is preserved. Whitespace and line endings are irrelevant.
 */
export const DATASET_FINGERPRINT_BASIS_VERSION = 'parsed-canonical-json-sha256-v1';
export const NARRATIVE_QUALITY_DATASET_FINGERPRINT =
  '744d0a275f6c3324d5e1d3ff8d383bc1d957d56ea02c10169da756a60678c4b1';
export const NARRATIVE_QUALITY_DATASET_CANONICAL_BYTES = 18_501;

export const NARRATIVE_QUALITY_DIMENSIONS = [
  'FACTUAL_ENTAILMENT',
  'REFERENCE_RELEVANCE',
  'UNKNOWN_MISSING_DISCIPLINE',
  'CONSTRAINT_RANKING_FIDELITY',
  'MONEY_DATE_TIME_FIDELITY',
  'PROVENANCE_INTEGRITY',
  'SAFETY_INSTRUCTION_INTEGRITY',
  'RELEVANCE_AND_BLOCK_KIND',
] as const;

export const NARRATIVE_QUALITY_REASON_CODES = [
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

export type NarrativeQualityDimension = (typeof NARRATIVE_QUALITY_DIMENSIONS)[number];
export type NarrativeQualityReasonCode = (typeof NARRATIVE_QUALITY_REASON_CODES)[number];
export type NarrativeDecision = 'PUBLISH' | 'REJECT';
export type NarrativeEvaluationStage = 'PRECHECK' | 'JUDGE';

export const NARRATIVE_QUALITY_SEMANTIC_CASE_IDS = [
  'P01',
  'P02',
  'P03',
  'P04',
  'P05',
  'P06',
  'P07',
  'P08',
  'P09',
  'P10',
  'P11',
  'P12',
  'R01',
  'R02',
  'R03',
  'R04',
  'R05',
  'R06',
  'R07',
  'R08',
  'R09',
  'R10',
  'R11',
  'R12',
  'R13',
  'R14',
  'R15',
  'R16',
  'R17',
  'R18',
  'R19',
  'R20',
] as const;

export const NARRATIVE_QUALITY_END_TO_END_CASE_IDS = ['E01', 'E02', 'E03', 'E04'] as const;

export const NARRATIVE_QUALITY_CRITICAL_CASE_IDS = [
  'R02',
  'R03',
  'R04',
  'R06',
  'R07',
  'R08',
  'R09',
  'R10',
  'R11',
  'R12',
  'R13',
  'R14',
  'R15',
  'R16',
  'R17',
  'R18',
  'R19',
  'R20',
] as const;

export const NARRATIVE_QUALITY_SENTINEL_CASE_IDS = [
  'P10',
  'P12',
  'R01',
  'R05',
  'R07',
  'R10',
  'R13',
  'R18',
] as const;

export const NARRATIVE_QUALITY_PRECHECK_CASE_IDS = ['R09', 'R20'] as const;

export const NARRATIVE_QUALITY_CONTEXT_IDS = [
  'PRAGUE_PLN_COMPLETE',
  'VIENNA_EUR_COMPLETE',
  'BUDAPEST_UNKNOWN_MISSING',
  'BERLIN_ADVERSARIAL_SOURCE',
] as const;

const endToEndAuthoringContract = Object.freeze({
  E01: Object.freeze({
    contextId: 'PRAGUE_PLN_COMPLETE',
    requiredProperties: Object.freeze([
      'strict-schema',
      'exact-references',
      'no-money-calculation',
      'fixture-honesty',
    ]),
  }),
  E02: Object.freeze({
    contextId: 'VIENNA_EUR_COMPLETE',
    requiredProperties: Object.freeze([
      'strict-schema',
      'exact-references',
      'exact-eur-display',
      'cached-not-live',
    ]),
  }),
  E03: Object.freeze({
    contextId: 'BUDAPEST_UNKNOWN_MISSING',
    requiredProperties: Object.freeze([
      'strict-schema',
      'exact-references',
      'unknown-explicit',
      'missing-explicit',
    ]),
  }),
  E04: Object.freeze({
    contextId: 'BERLIN_ADVERSARIAL_SOURCE',
    requiredProperties: Object.freeze([
      'strict-schema',
      'exact-references',
      'no-injection-propagation',
      'no-excluded-source-value',
    ]),
  }),
});

function uniqueValues<T>(values: readonly T[]): boolean {
  return new Set(values).size === values.length;
}

const uniqueStringArray = <T extends z.ZodType<string>>(item: T, minimum = 0, maximum?: number) => {
  let schema = z.array(item).min(minimum);
  if (maximum !== undefined) schema = schema.max(maximum);
  return schema.refine(uniqueValues, 'Array values must be unique.');
};

const dimensionSchema = z.enum(NARRATIVE_QUALITY_DIMENSIONS);
const reasonCodeSchema = z.enum(NARRATIVE_QUALITY_REASON_CODES);

const constraintSnapshotSchema = z
  .object({
    startDate: z.iso.date(),
    endDate: z.iso.date(),
    adults: z.number().int().min(1),
    currency: z.enum(['PLN', 'EUR']),
    hardBudgetLimit: z.boolean(),
    maxConnections: z.number().int().min(0),
    maxTravelMinutes: z.number().int().min(1),
    allowFlight: z.boolean(),
    allowTrain: z.boolean(),
    allowBus: z.boolean(),
  })
  .strict();

const authoringContextSchema = z
  .object({
    id: z.string().regex(/^[A-Z][A-Z0-9_]+$/),
    fixtureBuilder: z.string().regex(/^[a-z0-9-]+-v1$/),
    summary: z
      .record(z.string(), z.string().min(1).max(500))
      .refine(
        (summary) => Object.keys(summary).length >= 4,
        'A context summary needs four fields.',
      ),
    constraintSnapshot: constraintSnapshotSchema,
  })
  .strict();

const authoringBlockSchema = z
  .object({
    kind: z.enum(['SUMMARY', 'ADVANTAGE', 'TRADEOFF', 'RISK']),
    text: z.string().min(1).max(1_200),
    factKeys: uniqueStringArray(z.string().min(1).max(240), 1, 32),
  })
  .strict();

const expectedResultSchema = z
  .object({
    decision: z.enum(['PUBLISH', 'REJECT']),
    stage: z.enum(['PRECHECK', 'JUDGE']),
    critical: z.boolean(),
    failedDimensions: uniqueStringArray(dimensionSchema),
    requiredReasonCodes: uniqueStringArray(reasonCodeSchema),
  })
  .strict()
  .superRefine((expected, refinement) => {
    if (expected.decision === 'PUBLISH') {
      if (expected.stage !== 'JUDGE') {
        refinement.addIssue({ code: 'custom', path: ['stage'], message: 'PUBLISH is JUDGE-only.' });
      }
      if (expected.critical) {
        refinement.addIssue({
          code: 'custom',
          path: ['critical'],
          message: 'PUBLISH cannot be critical.',
        });
      }
      if (expected.failedDimensions.length !== 0) {
        refinement.addIssue({
          code: 'custom',
          path: ['failedDimensions'],
          message: 'PUBLISH cannot fail a dimension.',
        });
      }
      if (expected.requiredReasonCodes.length !== 0) {
        refinement.addIssue({
          code: 'custom',
          path: ['requiredReasonCodes'],
          message: 'PUBLISH cannot require a reason code.',
        });
      }
    } else {
      if (expected.failedDimensions.length === 0) {
        refinement.addIssue({
          code: 'custom',
          path: ['failedDimensions'],
          message: 'REJECT needs a failed dimension.',
        });
      }
      if (expected.requiredReasonCodes.length === 0) {
        refinement.addIssue({
          code: 'custom',
          path: ['requiredReasonCodes'],
          message: 'REJECT needs a reason code.',
        });
      }
    }
  });

const semanticCaseSchema = z
  .object({
    id: z.string().regex(/^[PR][0-9]{2}$/),
    contextId: z.string().regex(/^[A-Z][A-Z0-9_]+$/),
    title: z.string().min(1).max(160),
    tags: uniqueStringArray(z.string().regex(/^[a-z0-9-]+$/), 1),
    sentinel: z.boolean(),
    candidate: z.object({ blocks: z.array(authoringBlockSchema).min(1).max(8) }).strict(),
    expected: expectedResultSchema,
  })
  .strict();

const endToEndCaseSchema = z
  .object({
    id: z.string().regex(/^E[0-9]{2}$/),
    contextId: z.string().regex(/^[A-Z][A-Z0-9_]+$/),
    expectedDecision: z.literal('PUBLISH'),
    requiredProperties: uniqueStringArray(z.string().regex(/^[a-z0-9-]+$/), 1),
  })
  .strict();

export const narrativeQualityDatasetSchema = z
  .object({
    datasetVersion: z.literal(NARRATIVE_QUALITY_DATASET_VERSION),
    synthetic: z.literal(true),
    rubricVersion: z.literal(NARRATIVE_QUALITY_RUBRIC_VERSION),
    publicationPolicyVersion: z.literal(NARRATIVE_PUBLICATION_POLICY_VERSION),
    description: z.string().min(1).max(500),
    contexts: z.array(authoringContextSchema).length(4),
    cases: z.array(semanticCaseSchema).length(32),
    endToEndCases: z.array(endToEndCaseSchema).length(4),
  })
  .strict();

export type NarrativeQualityDataset = z.infer<typeof narrativeQualityDatasetSchema>;
export type NarrativeQualityCase = NarrativeQualityDataset['cases'][number];
export type NarrativeQualityEndToEndCase = NarrativeQualityDataset['endToEndCases'][number];
export type NarrativeQualityAuthoringContext = NarrativeQualityDataset['contexts'][number];

export class EvalContractError extends Error {
  readonly code:
    | 'INVALID_DATASET'
    | 'DATASET_FINGERPRINT_MISMATCH'
    | 'INVALID_DATASET_AUTHORING'
    | 'INVALID_EVAL_INPUT'
    | 'LIVE_EVAL_BLOCKED';

  constructor(code: EvalContractError['code'], message: string) {
    super(message);
    this.name = 'EvalContractError';
    this.code = code;
  }
}

export interface DatasetContractSummary {
  readonly fingerprintBasisVersion: typeof DATASET_FINGERPRINT_BASIS_VERSION;
  readonly fingerprint: string;
  readonly canonicalBytes: number;
  readonly contextCount: 4;
  readonly semanticCaseCount: 32;
  readonly publishCount: 12;
  readonly rejectCount: 20;
  readonly criticalRejectCount: 18;
  readonly sentinelCount: 8;
  readonly endToEndCaseCount: 4;
}

function assertExactSet(
  label: string,
  actual: readonly string[],
  expected: readonly string[],
): void {
  if (
    actual.length !== expected.length ||
    expected.some((value) => !actual.includes(value)) ||
    actual.some((value) => !expected.includes(value))
  ) {
    throw new EvalContractError('INVALID_DATASET_AUTHORING', `${label} does not match v1.`);
  }
}

function assertExactEndToEndAuthoring(dataset: NarrativeQualityDataset): void {
  const expectedIds = Object.keys(endToEndAuthoringContract);
  assertExactSet(
    'End-to-end case membership',
    dataset.endToEndCases.map(({ id }) => id),
    expectedIds,
  );

  for (const authored of dataset.endToEndCases) {
    const expected =
      endToEndAuthoringContract[authored.id as keyof typeof endToEndAuthoringContract];
    if (authored.contextId !== expected.contextId) {
      throw new EvalContractError(
        'INVALID_DATASET_AUTHORING',
        `End-to-end case ${authored.id} uses an unexpected context.`,
      );
    }
    assertExactSet(
      `End-to-end properties for ${authored.id}`,
      authored.requiredProperties,
      expected.requiredProperties,
    );
  }
}

export function validateNarrativeQualityDatasetContract(
  dataset: NarrativeQualityDataset,
): DatasetContractSummary {
  const contextIds = dataset.contexts.map(({ id }) => id);
  const caseIds = dataset.cases.map(({ id }) => id);
  const criticalIds = dataset.cases.filter(({ expected }) => expected.critical).map(({ id }) => id);
  const sentinelIds = dataset.cases.filter(({ sentinel }) => sentinel).map(({ id }) => id);
  const precheckIds = dataset.cases
    .filter(({ expected }) => expected.stage === 'PRECHECK')
    .map(({ id }) => id);

  assertExactSet('Context membership', contextIds, NARRATIVE_QUALITY_CONTEXT_IDS);
  assertExactSet('Semantic case membership', caseIds, NARRATIVE_QUALITY_SEMANTIC_CASE_IDS);
  assertExactSet('Critical-case membership', criticalIds, NARRATIVE_QUALITY_CRITICAL_CASE_IDS);
  assertExactSet('Sentinel-case membership', sentinelIds, NARRATIVE_QUALITY_SENTINEL_CASE_IDS);
  assertExactSet('Precheck-case membership', precheckIds, NARRATIVE_QUALITY_PRECHECK_CASE_IDS);

  const contextIdSet = new Set(contextIds);
  if (
    dataset.cases.some(({ contextId }) => !contextIdSet.has(contextId)) ||
    dataset.endToEndCases.some(({ contextId }) => !contextIdSet.has(contextId))
  ) {
    throw new EvalContractError(
      'INVALID_DATASET_AUTHORING',
      'Every authored case must reference one of the four exact contexts.',
    );
  }

  for (const authored of dataset.cases) {
    const expectedDecision = authored.id.startsWith('P') ? 'PUBLISH' : 'REJECT';
    if (authored.expected.decision !== expectedDecision) {
      throw new EvalContractError(
        'INVALID_DATASET_AUTHORING',
        `The expected label for ${authored.id} does not match v1.`,
      );
    }
  }
  assertExactEndToEndAuthoring(dataset);

  const json = dataset as JsonValue;
  const fingerprint = createInputFingerprint(json);
  const canonicalBytes = Buffer.byteLength(canonicalizeJson(json), 'utf8');
  if (fingerprint !== NARRATIVE_QUALITY_DATASET_FINGERPRINT) {
    throw new EvalContractError(
      'DATASET_FINGERPRINT_MISMATCH',
      'The narrative-quality-v1 dataset does not match its immutable canonical fingerprint.',
    );
  }

  const publishCount = dataset.cases.filter(
    ({ expected }) => expected.decision === 'PUBLISH',
  ).length;
  const rejectCount = dataset.cases.length - publishCount;
  if (publishCount !== 12 || rejectCount !== 20) {
    throw new EvalContractError(
      'INVALID_DATASET_AUTHORING',
      'The v1 expected-label distribution must remain exactly 12 PUBLISH and 20 REJECT.',
    );
  }

  return {
    fingerprintBasisVersion: DATASET_FINGERPRINT_BASIS_VERSION,
    fingerprint,
    canonicalBytes,
    contextCount: 4,
    semanticCaseCount: 32,
    publishCount: 12,
    rejectCount: 20,
    criticalRejectCount: 18,
    sentinelCount: 8,
    endToEndCaseCount: 4,
  };
}

export function parseNarrativeQualityDataset(input: unknown): NarrativeQualityDataset {
  const parsed = narrativeQualityDatasetSchema.safeParse(input);
  if (!parsed.success) {
    throw new EvalContractError(
      'INVALID_DATASET',
      'The narrative-quality dataset failed its strict v1 authoring schema.',
    );
  }
  validateNarrativeQualityDatasetContract(parsed.data);
  return deepFreeze(parsed.data);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export function loadNarrativeQualityDataset(
  datasetUrl: URL = new URL('../../evals/datasets/narrative-quality-v1.json', import.meta.url),
): NarrativeQualityDataset {
  let input: unknown;
  try {
    input = JSON.parse(readFileSync(datasetUrl, 'utf8')) as unknown;
  } catch {
    throw new EvalContractError('INVALID_DATASET', 'The narrative-quality dataset is unreadable.');
  }
  return parseNarrativeQualityDataset(input);
}

export type GroundedFixtureResolver = (
  fixtureBuilder: string,
  authoringContext: NarrativeQualityAuthoringContext,
) => GroundedOptionContext;

export interface ResolvedNarrativeQualityCase {
  readonly authored: NarrativeQualityCase;
  readonly groundedContext: GroundedOptionContext;
  readonly candidate: OptionNarrativeOutput;
}

export interface ResolvedNarrativeQualityEndToEndCase {
  readonly authored: NarrativeQualityEndToEndCase;
  readonly groundedContext: GroundedOptionContext;
}

export interface ResolvedNarrativeQualityDataset {
  readonly dataset: NarrativeQualityDataset;
  readonly cases: readonly ResolvedNarrativeQualityCase[];
  readonly endToEndCases: readonly ResolvedNarrativeQualityEndToEndCase[];
}

/** Resolves stable authoring keys only through exact fact IDs produced by the injected builder. */
export function resolveNarrativeQualityDataset(
  dataset: NarrativeQualityDataset,
  resolveFixture: GroundedFixtureResolver,
): ResolvedNarrativeQualityDataset {
  validateNarrativeQualityDatasetContract(dataset);
  const contexts = new Map<string, GroundedOptionContext>();

  for (const authoredContext of dataset.contexts) {
    let context: GroundedOptionContext;
    try {
      context = resolveFixture(authoredContext.fixtureBuilder, authoredContext);
    } catch {
      throw new EvalContractError(
        'INVALID_DATASET_AUTHORING',
        `Fixture builder ${authoredContext.fixtureBuilder} failed closed.`,
      );
    }
    const factKeys = context.facts.map(({ key }) => key);
    if (!uniqueValues(factKeys)) {
      throw new EvalContractError(
        'INVALID_DATASET_AUTHORING',
        `Fixture builder ${authoredContext.fixtureBuilder} produced duplicate fact keys.`,
      );
    }
    contexts.set(authoredContext.id, context);
  }

  const cases = dataset.cases.map((authored): ResolvedNarrativeQualityCase => {
    const context = contexts.get(authored.contextId);
    if (context === undefined) {
      throw new EvalContractError(
        'INVALID_DATASET_AUTHORING',
        `Missing context for ${authored.id}.`,
      );
    }
    const factIdsByKey = new Map(context.facts.map((fact) => [fact.key, fact.factId]));
    const blocks = authored.candidate.blocks.map((block) => ({
      kind: block.kind,
      text: block.text,
      factReferences: block.factKeys.map((factKey) => {
        const factId = factIdsByKey.get(factKey);
        if (factId === undefined) {
          throw new EvalContractError(
            'INVALID_DATASET_AUTHORING',
            `Case ${authored.id} uses a fact key absent from its exact fixture context.`,
          );
        }
        return factId;
      }),
    }));

    let candidate: OptionNarrativeOutput;
    try {
      candidate = parseOptionNarrativeOutput(
        { contextFingerprint: context.fingerprint, blocks },
        context,
      );
    } catch {
      throw new EvalContractError(
        'INVALID_DATASET_AUTHORING',
        `Case ${authored.id} does not resolve to a locally valid narrative candidate.`,
      );
    }
    return { authored, groundedContext: context, candidate };
  });

  const endToEndCases = dataset.endToEndCases.map(
    (authored): ResolvedNarrativeQualityEndToEndCase => {
      const groundedContext = contexts.get(authored.contextId);
      if (groundedContext === undefined) {
        throw new EvalContractError(
          'INVALID_DATASET_AUTHORING',
          `Missing end-to-end context for ${authored.id}.`,
        );
      }
      return { authored, groundedContext };
    },
  );

  return { dataset, cases, endToEndCases };
}
