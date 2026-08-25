import { z, type ZodType } from 'zod';
import {
  canonicalizeJson,
  createInputFingerprint,
  type JsonObject,
  type JsonValue,
} from '../ai/contracts.ts';
import { DomainError } from '../domain/domain-error.ts';
import {
  GROUNDED_BUDGET_CATEGORIES,
  type GroundedBudgetCategory,
  type GroundedOptionContext,
} from './grounded-option-types.ts';
import {
  buildNarrativeModelView,
  type NarrativeModelFact,
  type NarrativeModelView,
} from './narrative-model-view.ts';

export const NARRATIVE_GENERATION_VIEW_VERSION = 'narrative-generation-view-v1';
export const NARRATIVE_GENERATION_VIEW_MAX_BYTES = 48 * 1024;

const PROVENANCE_FACT_KEY_PREFIX = 'provenance.';
const BUDGET_CATEGORY_FACT_KEY_PREFIX = 'option.budget.category.';

const nonEmptyStringSchema = z.string().min(1);
const nonNegativeIntegerSchema = z.number().int().nonnegative();

const fixedFactValueSchemas = {
  'option.selection': z
    .object({
      rank: nonNegativeIntegerSchema,
      role: z.enum(['BEST_OVERALL', 'MOST_CONVENIENT', 'BEST_VALUE']),
    })
    .strict(),
  'option.destination': z
    .object({
      code: nonEmptyStringSchema,
      city: nonEmptyStringSchema,
      countryCode: nonEmptyStringSchema,
    })
    .strict(),
  'option.transport': z
    .object({
      mode: z.enum(['FLIGHT', 'TRAIN', 'BUS']),
      outboundDepartureAt: nonEmptyStringSchema,
      outboundArrivalAt: nonEmptyStringSchema,
      returnDepartureAt: nonEmptyStringSchema,
      returnArrivalAt: nonEmptyStringSchema,
      outboundTravelMinutes: nonNegativeIntegerSchema,
      returnTravelMinutes: nonNegativeIntegerSchema,
      maximumConnections: nonNegativeIntegerSchema,
      effectiveTimeAtDestinationMinutes: nonNegativeIntegerSchema,
    })
    .strict(),
  'option.accommodation': z
    .object({
      name: nonEmptyStringSchema,
      checkInDate: nonEmptyStringSchema,
      checkOutDate: nonEmptyStringSchema,
      nights: nonNegativeIntegerSchema,
      centralityScore: nonEmptyStringSchema,
    })
    .strict(),
  'option.budget.summary': z
    .object({
      currency: nonEmptyStringSchema,
      currencyContractVersion: nonEmptyStringSchema,
      moneyDisplayVersion: nonEmptyStringSchema,
      budgetLimitMinor: nonEmptyStringSchema,
      budgetLimitDisplay: nonEmptyStringSchema,
      confirmedAmountMinor: nonEmptyStringSchema,
      confirmedAmountDisplay: nonEmptyStringSchema,
      estimatedAmountMinor: nonEmptyStringSchema,
      estimatedAmountDisplay: nonEmptyStringSchema,
      unknownCategoryCount: z.literal(0),
      totalAmountMinor: nonEmptyStringSchema,
      totalAmountDisplay: nonEmptyStringSchema,
      costPerPersonMinor: nonEmptyStringSchema,
      costPerPersonDisplay: nonEmptyStringSchema,
      remainingBudgetMinor: nonEmptyStringSchema,
      remainingBudgetDisplay: nonEmptyStringSchema,
    })
    .strict(),
  'option.score': z
    .object({
      total: nonEmptyStringSchema,
      budgetFit: nonEmptyStringSchema,
      travelTime: nonEmptyStringSchema,
      effectiveTime: nonEmptyStringSchema,
      accommodationLocation: nonEmptyStringSchema,
      dataCompleteness: nonEmptyStringSchema,
      priceConfidence: nonEmptyStringSchema,
      preferenceFit: nonEmptyStringSchema,
    })
    .strict(),
} as const satisfies Readonly<Record<string, ZodType>>;

const budgetCategoryFactValueSchema = z
  .object({
    category: z.enum(GROUNDED_BUDGET_CATEGORIES),
    amountMinor: nonEmptyStringSchema,
    amountDisplay: nonEmptyStringSchema,
    confirmedAmountMinor: nonEmptyStringSchema,
    confirmedAmountDisplay: nonEmptyStringSchema,
    estimatedAmountMinor: nonEmptyStringSchema,
    estimatedAmountDisplay: nonEmptyStringSchema,
    currencyContractVersion: nonEmptyStringSchema,
    moneyDisplayVersion: nonEmptyStringSchema,
    currency: nonEmptyStringSchema,
    classification: z.enum(['CONFIRMED', 'ESTIMATED']),
    priceType: z.enum(['LIVE_PRICE', 'FIXED_PRICE', 'ESTIMATE']),
    sourceSnapshotId: nonEmptyStringSchema.nullable(),
  })
  .strict();

export type NarrativeGenerationFact = JsonObject & {
  readonly factId: string;
  readonly key: string;
  readonly status: 'KNOWN';
  readonly value: JsonValue;
};

export type NarrativeGenerationView = JsonObject & {
  readonly version: typeof NARRATIVE_GENERATION_VIEW_VERSION;
  readonly fingerprint: string;
  readonly groundedContextVersion: string;
  readonly groundedContextFingerprint: string;
  readonly rankedOption: JsonObject & {
    readonly rank: number;
    readonly role: string;
  };
  readonly facts: readonly NarrativeGenerationFact[];
};

function invalidGenerationView(message: string): never {
  throw new DomainError('INVALID_NARRATIVE_GENERATION_VIEW', message);
}

function parseFactValue(fact: NarrativeModelFact, schema: ZodType): JsonObject {
  const parsed = schema.safeParse(fact.value);
  if (!parsed.success) {
    invalidGenerationView(`Generation fact ${fact.key} has an unsupported value shape.`);
  }
  return parsed.data as JsonObject;
}

function isFixedFactKey(key: string): key is keyof typeof fixedFactValueSchemas {
  return Object.hasOwn(fixedFactValueSchemas, key);
}

function parseBudgetCategoryFactKey(key: string): GroundedBudgetCategory | null {
  if (!key.startsWith(BUDGET_CATEGORY_FACT_KEY_PREFIX)) return null;
  const category = key.slice(BUDGET_CATEGORY_FACT_KEY_PREFIX.length);
  return GROUNDED_BUDGET_CATEGORIES.find((candidate) => candidate === category) ?? null;
}

function projectBudgetCategoryValue(
  fact: NarrativeModelFact,
  expectedCategory: GroundedBudgetCategory,
): JsonObject {
  const parsed = budgetCategoryFactValueSchema.safeParse(fact.value);
  if (!parsed.success) {
    invalidGenerationView(`Generation fact ${fact.key} has an unsupported value shape.`);
  }
  const value = parsed.data;
  if (value.category !== expectedCategory) {
    invalidGenerationView(`Generation fact ${fact.key} has a mismatched budget category.`);
  }
  return {
    category: value.category,
    amountMinor: value.amountMinor,
    amountDisplay: value.amountDisplay,
    confirmedAmountMinor: value.confirmedAmountMinor,
    confirmedAmountDisplay: value.confirmedAmountDisplay,
    estimatedAmountMinor: value.estimatedAmountMinor,
    estimatedAmountDisplay: value.estimatedAmountDisplay,
    currencyContractVersion: value.currencyContractVersion,
    moneyDisplayVersion: value.moneyDisplayVersion,
    currency: value.currency,
    classification: value.classification,
    priceType: value.priceType,
  };
}

function projectFactValue(fact: NarrativeModelFact): JsonObject {
  if (isFixedFactKey(fact.key)) {
    return parseFactValue(fact, fixedFactValueSchemas[fact.key]);
  }
  const category = parseBudgetCategoryFactKey(fact.key);
  if (category !== null) return projectBudgetCategoryValue(fact, category);
  invalidGenerationView(`Generation fact key ${fact.key} is outside the closed provider catalog.`);
}

function projectKnownFact(fact: NarrativeModelFact): NarrativeGenerationFact | null {
  if (fact.key.startsWith(PROVENANCE_FACT_KEY_PREFIX)) return null;
  const supported = isFixedFactKey(fact.key) || parseBudgetCategoryFactKey(fact.key) !== null;
  if (!supported) {
    invalidGenerationView(
      `Generation fact key ${fact.key} is outside the closed provider catalog.`,
    );
  }
  if (fact.status !== 'KNOWN') return null;
  return {
    factId: fact.factId,
    key: fact.key,
    status: 'KNOWN',
    value: projectFactValue(fact),
  };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function assertSize(value: JsonValue): void {
  if (Buffer.byteLength(canonicalizeJson(value), 'utf8') > NARRATIVE_GENERATION_VIEW_MAX_BYTES) {
    invalidGenerationView(
      `Narrative generation view exceeds the ${NARRATIVE_GENERATION_VIEW_MAX_BYTES}-byte v1 limit.`,
    );
  }
}

/**
 * Builds the only GENERATE-provider projection. The full model view remains available locally and
 * to JUDGE, while provenance and non-KNOWN facts stay exclusively in deterministic code.
 */
export function buildNarrativeGenerationView(
  context: GroundedOptionContext,
  modelView: NarrativeModelView = buildNarrativeModelView(context),
): NarrativeGenerationView {
  const expectedModelView = buildNarrativeModelView(context);
  if (canonicalizeJson(modelView) !== canonicalizeJson(expectedModelView)) {
    invalidGenerationView(
      'The narrative model view does not belong to the exact grounded context.',
    );
  }

  const seenFactKeys = new Set<string>();
  const facts = modelView.facts.flatMap((fact) => {
    if (!fact.key.startsWith(PROVENANCE_FACT_KEY_PREFIX)) {
      if (seenFactKeys.has(fact.key)) {
        invalidGenerationView(`Generation fact key ${fact.key} is duplicated.`);
      }
      seenFactKeys.add(fact.key);
    }
    const projected = projectKnownFact(fact);
    return projected === null ? [] : [projected];
  });
  if (facts.length === 0) {
    invalidGenerationView('The narrative generation view contains no narratable KNOWN facts.');
  }

  const fingerprintBasis: JsonObject = {
    version: NARRATIVE_GENERATION_VIEW_VERSION,
    groundedContextVersion: context.version,
    groundedContextFingerprint: context.fingerprint,
    rankedOption: {
      rank: context.rankedOption.rank,
      role: context.rankedOption.role,
    },
    facts,
  };
  assertSize(fingerprintBasis);
  const result: NarrativeGenerationView = {
    ...fingerprintBasis,
    version: NARRATIVE_GENERATION_VIEW_VERSION,
    fingerprint: createInputFingerprint(fingerprintBasis),
  } as NarrativeGenerationView;
  assertSize(result);

  return deepFreeze(result);
}
