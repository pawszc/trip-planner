import type { JsonValue } from '../ai/contracts.ts';
import { DomainError } from '../domain/domain-error.ts';
import {
  GROUNDED_BUDGET_CATEGORIES,
  type DecimalValue,
  type GroundedBudgetCategory,
  type GroundedBudgetItemRecord,
  type GroundedContextPlanningRun,
  type GroundedContextRankedOption,
  type GroundedFactDraft,
  type GroundedFactStatus,
  type GroundedOptionContextInput,
  type GroundedRankedOptionRecord,
  type GroundedSourceSnapshot,
  type IntegerValue,
} from './grounded-option-types.ts';

export interface GroundedContextComponents {
  planningRun: GroundedContextPlanningRun;
  rankedOption: GroundedContextRankedOption;
  sourceSnapshots: readonly GroundedSourceSnapshot[];
  factDrafts: readonly GroundedFactDraft[];
}

export function invalidGroundedContext(message: string): never {
  throw new DomainError('INVALID_GROUNDED_OPTION_CONTEXT', message);
}

export function requireGroundedText(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    invalidGroundedContext(`Grounded context field ${field} is empty.`);
  }
  return normalized;
}

function normalizeInteger(value: IntegerValue, field: string): string {
  const normalized = typeof value === 'number' ? String(value) : value.trim();
  if (!/^-?\d+$/.test(normalized)) {
    invalidGroundedContext(`Grounded context field ${field} is not an integer.`);
  }
  return normalized;
}

function normalizeDecimal(value: DecimalValue, field: string): string {
  const normalized = typeof value === 'number' ? String(value) : value.trim();
  if (!/^-?\d+(?:\.\d+)?$/.test(normalized)) {
    invalidGroundedContext(`Grounded context field ${field} is not a decimal.`);
  }
  return normalized;
}

function requireNonNegativeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    invalidGroundedContext(`Grounded context field ${field} is not a non-negative safe integer.`);
  }
  return value;
}

function knownFact(
  key: string,
  value: JsonValue,
  sourceSnapshotIds: readonly string[] = [],
): GroundedFactDraft {
  return { key, status: 'KNOWN', value, sourceSnapshotIds };
}

function normalizeSources(input: GroundedOptionContextInput): readonly GroundedSourceSnapshot[] {
  const seenIds = new Set<string>();
  const seenKeys = new Set<string>();
  return [...input.sourceSnapshots]
    .sort(
      (left, right) =>
        left.sourceKey.localeCompare(right.sourceKey, 'en') ||
        left.ID.localeCompare(right.ID, 'en'),
    )
    .map((source) => {
      if (
        source.planningRun_ID !== input.planningRun.ID ||
        source.rankedOption_ID !== input.rankedOption.ID
      ) {
        invalidGroundedContext('A source snapshot belongs to a different planning context.');
      }
      const id = requireGroundedText(source.ID, 'sourceSnapshots.ID');
      const sourceKey = requireGroundedText(source.sourceKey, 'sourceSnapshots.sourceKey');
      if (seenIds.has(id) || seenKeys.has(sourceKey)) {
        invalidGroundedContext(
          'Grounded context source snapshots must have unique IDs and source keys.',
        );
      }
      seenIds.add(id);
      seenKeys.add(sourceKey);
      return {
        id,
        sourceKey,
        provider: requireGroundedText(source.provider, 'sourceSnapshots.provider'),
        externalItemId: requireGroundedText(
          source.externalItemId,
          'sourceSnapshots.externalItemId',
        ),
        fetchedAt: requireGroundedText(source.fetchedAt, 'sourceSnapshots.fetchedAt'),
        sourceUrl: requireGroundedText(source.sourceUrl, 'sourceSnapshots.sourceUrl'),
        freshnessType: source.freshnessType,
        currency: requireGroundedText(source.currency, 'sourceSnapshots.currency'),
        fixtureVersion: requireGroundedText(
          source.fixtureVersion,
          'sourceSnapshots.fixtureVersion',
        ),
        contexts: requireGroundedText(source.contexts, 'sourceSnapshots.contexts'),
        demonstrationData: source.demonstrationData,
      } satisfies GroundedSourceSnapshot;
    });
}

function createOptionFacts(option: GroundedRankedOptionRecord): readonly GroundedFactDraft[] {
  return [
    knownFact('option.selection', {
      rank: requireNonNegativeInteger(option.rank, 'rankedOption.rank'),
      role: option.role,
    }),
    knownFact('option.destination', {
      code: requireGroundedText(option.destinationCode, 'rankedOption.destinationCode'),
      city: requireGroundedText(option.destinationCity, 'rankedOption.destinationCity'),
      countryCode: requireGroundedText(
        option.destinationCountryCode,
        'rankedOption.destinationCountryCode',
      ),
    }),
    knownFact('option.transport', {
      mode: option.transportMode,
      outboundDepartureAt: requireGroundedText(
        option.outboundDepartureAt,
        'rankedOption.outboundDepartureAt',
      ),
      outboundArrivalAt: requireGroundedText(
        option.outboundArrivalAt,
        'rankedOption.outboundArrivalAt',
      ),
      returnDepartureAt: requireGroundedText(
        option.returnDepartureAt,
        'rankedOption.returnDepartureAt',
      ),
      returnArrivalAt: requireGroundedText(option.returnArrivalAt, 'rankedOption.returnArrivalAt'),
      outboundTravelMinutes: requireNonNegativeInteger(
        option.outboundTravelMinutes,
        'rankedOption.outboundTravelMinutes',
      ),
      returnTravelMinutes: requireNonNegativeInteger(
        option.returnTravelMinutes,
        'rankedOption.returnTravelMinutes',
      ),
      maximumConnections: requireNonNegativeInteger(
        option.maximumConnections,
        'rankedOption.maximumConnections',
      ),
      effectiveTimeAtDestinationMinutes: requireNonNegativeInteger(
        option.effectiveTimeAtDestinationMinutes,
        'rankedOption.effectiveTimeAtDestinationMinutes',
      ),
    }),
    knownFact('option.accommodation', {
      name: requireGroundedText(option.stayName, 'rankedOption.stayName'),
      checkInDate: requireGroundedText(option.checkInDate, 'rankedOption.checkInDate'),
      checkOutDate: requireGroundedText(option.checkOutDate, 'rankedOption.checkOutDate'),
      nights: requireNonNegativeInteger(option.nights, 'rankedOption.nights'),
      centralityScore: normalizeDecimal(
        option.accommodationCentralityScore,
        'rankedOption.accommodationCentralityScore',
      ),
    }),
    knownFact('option.budget.summary', {
      currency: requireGroundedText(option.currency, 'rankedOption.currency'),
      budgetLimitMinor: normalizeInteger(option.budgetLimitMinor, 'rankedOption.budgetLimitMinor'),
      confirmedAmountMinor: normalizeInteger(
        option.confirmedAmountMinor,
        'rankedOption.confirmedAmountMinor',
      ),
      estimatedAmountMinor: normalizeInteger(
        option.estimatedAmountMinor,
        'rankedOption.estimatedAmountMinor',
      ),
      unknownCategoryCount: requireNonNegativeInteger(
        option.unknownCategoryCount,
        'rankedOption.unknownCategoryCount',
      ),
      totalAmountMinor: normalizeInteger(option.totalAmountMinor, 'rankedOption.totalAmountMinor'),
      costPerPersonMinor: normalizeInteger(
        option.costPerPersonMinor,
        'rankedOption.costPerPersonMinor',
      ),
      remainingBudgetMinor: normalizeInteger(
        option.remainingBudgetMinor,
        'rankedOption.remainingBudgetMinor',
      ),
    }),
    knownFact('option.score', {
      total: normalizeDecimal(option.totalScore, 'rankedOption.totalScore'),
      budgetFit: normalizeDecimal(option.budgetFitScore, 'rankedOption.budgetFitScore'),
      travelTime: normalizeDecimal(option.travelTimeScore, 'rankedOption.travelTimeScore'),
      effectiveTime: normalizeDecimal(option.effectiveTimeScore, 'rankedOption.effectiveTimeScore'),
      accommodationLocation: normalizeDecimal(
        option.accommodationLocationScore,
        'rankedOption.accommodationLocationScore',
      ),
      dataCompleteness: normalizeDecimal(
        option.dataCompletenessScore,
        'rankedOption.dataCompletenessScore',
      ),
      priceConfidence: normalizeDecimal(
        option.priceConfidenceScore,
        'rankedOption.priceConfidenceScore',
      ),
      preferenceFit: normalizeDecimal(option.preferenceFitScore, 'rankedOption.preferenceFitScore'),
    }),
  ];
}

function createBudgetFacts(
  input: GroundedOptionContextInput,
  knownSourceIds: ReadonlySet<string>,
): readonly GroundedFactDraft[] {
  const itemsByCategory = new Map<GroundedBudgetCategory, GroundedBudgetItemRecord>();
  for (const item of input.budgetItems) {
    if (
      item.planningRun_ID !== input.planningRun.ID ||
      item.rankedOption_ID !== input.rankedOption.ID
    ) {
      invalidGroundedContext('A budget item belongs to a different planning context.');
    }
    if (itemsByCategory.has(item.category)) {
      invalidGroundedContext(`Grounded context has duplicate budget category ${item.category}.`);
    }
    if (item.sourceSnapshot_ID !== null && !knownSourceIds.has(item.sourceSnapshot_ID)) {
      invalidGroundedContext(
        `Budget category ${item.category} references an unknown source snapshot.`,
      );
    }
    itemsByCategory.set(item.category, item);
  }

  return GROUNDED_BUDGET_CATEGORIES.map((category) => {
    const key = `option.budget.category.${category}`;
    const item = itemsByCategory.get(category);
    if (item === undefined) {
      return { key, status: 'MISSING', value: null, sourceSnapshotIds: [] };
    }

    const sourceSnapshotIds =
      item.sourceSnapshot_ID === null ? [] : ([item.sourceSnapshot_ID] as const);
    const value = {
      category,
      amountMinor:
        item.amountMinor === null
          ? null
          : normalizeInteger(item.amountMinor, `budgetItems.${category}.amountMinor`),
      currency: requireGroundedText(item.currency, `budgetItems.${category}.currency`),
      classification: item.classification,
      priceType: item.priceType,
      sourceSnapshotId: item.sourceSnapshot_ID,
    };
    const status: GroundedFactStatus =
      item.classification === 'UNKNOWN'
        ? 'UNKNOWN'
        : item.amountMinor === null
          ? 'MISSING'
          : 'KNOWN';
    return { key, status, value, sourceSnapshotIds };
  });
}

function createSourceFacts(
  sources: readonly GroundedSourceSnapshot[],
): readonly GroundedFactDraft[] {
  return sources.map((source) =>
    knownFact(
      `provenance.${source.sourceKey}`,
      {
        sourceSnapshotId: source.id,
        provider: source.provider,
        externalItemId: source.externalItemId,
        fetchedAt: source.fetchedAt,
        sourceUrl: source.sourceUrl,
        freshnessType: source.freshnessType,
        currency: source.currency,
        fixtureVersion: source.fixtureVersion,
        contexts: source.contexts,
        demonstrationData: source.demonstrationData,
      },
      [source.id],
    ),
  );
}

export function buildGroundedContextComponents(
  input: GroundedOptionContextInput,
): GroundedContextComponents {
  if (input.planningRun.status !== 'SUCCEEDED') {
    invalidGroundedContext('Grounded narratives require a successful PlanningRun.');
  }
  if (input.rankedOption.planningRun_ID !== input.planningRun.ID) {
    invalidGroundedContext('The ranked option belongs to a different PlanningRun.');
  }

  const planningRun: GroundedContextPlanningRun = {
    id: requireGroundedText(input.planningRun.ID, 'planningRun.ID'),
    requestFingerprint: requireGroundedText(
      input.planningRun.requestFingerprint,
      'planningRun.requestFingerprint',
    ),
    providerFixtureVersion: requireGroundedText(
      input.planningRun.providerFixtureVersion,
      'planningRun.providerFixtureVersion',
    ),
    engineVersion: requireGroundedText(
      input.planningRun.engineVersion,
      'planningRun.engineVersion',
    ),
    scoringVersion: requireGroundedText(
      input.planningRun.scoringVersion,
      'planningRun.scoringVersion',
    ),
  };
  const rankedOption: GroundedContextRankedOption = {
    id: requireGroundedText(input.rankedOption.ID, 'rankedOption.ID'),
    rank: requireNonNegativeInteger(input.rankedOption.rank, 'rankedOption.rank'),
    role: input.rankedOption.role,
  };
  const sourceSnapshots = normalizeSources(input);
  const knownSourceIds = new Set(sourceSnapshots.map((source) => source.id));
  const factDrafts = [
    ...createOptionFacts(input.rankedOption),
    ...createBudgetFacts(input, knownSourceIds),
    ...createSourceFacts(sourceSnapshots),
  ].sort((left, right) => left.key.localeCompare(right.key, 'en'));

  const factKeys = new Set<string>();
  for (const fact of factDrafts) {
    if (factKeys.has(fact.key)) {
      invalidGroundedContext(`Duplicate grounded fact key ${fact.key}.`);
    }
    factKeys.add(fact.key);
  }

  return { planningRun, rankedOption, sourceSnapshots, factDrafts };
}
