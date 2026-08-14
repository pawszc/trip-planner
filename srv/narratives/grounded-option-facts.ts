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
  type GroundedInternalDerivation,
  type GroundedOptionContextInput,
  type GroundedRankedOptionRecord,
  type GroundedSourceSnapshot,
  type IntegerValue,
} from './grounded-option-types.ts';
import { formatGroundedMoney, GROUNDED_MONEY_DISPLAY_VERSION } from './grounded-money-display.ts';

export interface GroundedContextComponents {
  planningRun: GroundedContextPlanningRun;
  rankedOption: GroundedContextRankedOption;
  sourceSnapshots: readonly GroundedSourceSnapshot[];
  factDrafts: readonly GroundedFactDraft[];
}

interface NormalizedSources {
  sourceSnapshots: readonly GroundedSourceSnapshot[];
  sourceIdsByContext: ReadonlyMap<string, readonly string[]>;
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
  options: {
    sourceSnapshotIds?: readonly string[];
    internalDerivation?: GroundedInternalDerivation;
  } = {},
): GroundedFactDraft {
  return {
    key,
    status: 'KNOWN',
    value,
    sourceSnapshotIds: options.sourceSnapshotIds ?? [],
    internalDerivation: options.internalDerivation ?? null,
  };
}

function normalizeSourceContexts(value: string, field: string): readonly string[] {
  const contexts = value
    .split(',')
    .map((context) => context.trim())
    .filter((context) => context.length > 0)
    .sort((left, right) => left.localeCompare(right, 'en'));
  if (contexts.length === 0 || new Set(contexts).size !== contexts.length) {
    invalidGroundedContext(`Grounded context field ${field} has invalid source contexts.`);
  }
  return contexts;
}

function normalizeSources(input: GroundedOptionContextInput): NormalizedSources {
  const seenIds = new Set<string>();
  const seenKeys = new Set<string>();
  const sourceContexts = new Map<string, string[]>();
  const sourceSnapshots = [...input.sourceSnapshots]
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
      const contexts = normalizeSourceContexts(
        requireGroundedText(source.contexts, 'sourceSnapshots.contexts'),
        `sourceSnapshots.${sourceKey}.contexts`,
      );
      for (const context of contexts) {
        const sourceIds = sourceContexts.get(context) ?? [];
        sourceIds.push(id);
        sourceContexts.set(context, sourceIds);
      }
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
        contexts: contexts.join(', '),
        demonstrationData: source.demonstrationData,
      } satisfies GroundedSourceSnapshot;
    });
  const sourceIdsByContext = new Map(
    [...sourceContexts.entries()].map(([context, sourceIds]) => [
      context,
      [...sourceIds].sort((left, right) => left.localeCompare(right, 'en')),
    ]),
  );
  return { sourceSnapshots, sourceIdsByContext };
}

function internalDerivation(version: string, field: string): GroundedInternalDerivation {
  return {
    kind: 'INTERNAL_DETERMINISTIC',
    version: requireGroundedText(version, field),
  };
}

function requireSingleExternalSource(
  sources: NormalizedSources,
  context: 'TRANSPORT_FACT' | 'ACCOMMODATION_FACT',
): string {
  const sourceIds = sources.sourceIdsByContext.get(context) ?? [];
  if (sourceIds.length !== 1) {
    invalidGroundedContext(
      sourceIds.length === 0
        ? `Grounded context has no source snapshot for ${context}.`
        : `Grounded context has ambiguous source snapshots for ${context}.`,
    );
  }
  const sourceId = sourceIds[0]!;
  const source = sources.sourceSnapshots.find((candidate) => candidate.id === sourceId);
  if (source === undefined || source.freshnessType === 'INTERNAL_RULE') {
    invalidGroundedContext(`Grounded context has no external source snapshot for ${context}.`);
  }
  return sourceId;
}

function createOptionFacts(
  option: GroundedRankedOptionRecord,
  planningRun: GroundedContextPlanningRun,
  sources: NormalizedSources,
): readonly GroundedFactDraft[] {
  const currency = requireGroundedText(option.currency, 'rankedOption.currency');
  const budgetLimitMinor = normalizeInteger(
    option.budgetLimitMinor,
    'rankedOption.budgetLimitMinor',
  );
  const confirmedAmountMinor = normalizeInteger(
    option.confirmedAmountMinor,
    'rankedOption.confirmedAmountMinor',
  );
  const estimatedAmountMinor = normalizeInteger(
    option.estimatedAmountMinor,
    'rankedOption.estimatedAmountMinor',
  );
  const totalAmountMinor = normalizeInteger(
    option.totalAmountMinor,
    'rankedOption.totalAmountMinor',
  );
  const costPerPersonMinor = normalizeInteger(
    option.costPerPersonMinor,
    'rankedOption.costPerPersonMinor',
  );
  const remainingBudgetMinor = normalizeInteger(
    option.remainingBudgetMinor,
    'rankedOption.remainingBudgetMinor',
  );
  const transportSourceId = requireSingleExternalSource(sources, 'TRANSPORT_FACT');
  const accommodationSourceId = requireSingleExternalSource(sources, 'ACCOMMODATION_FACT');

  return [
    knownFact(
      'option.selection',
      {
        rank: requireNonNegativeInteger(option.rank, 'rankedOption.rank'),
        role: option.role,
      },
      { internalDerivation: internalDerivation(planningRun.scoringVersion, 'scoringVersion') },
    ),
    knownFact('option.destination', {
      code: requireGroundedText(option.destinationCode, 'rankedOption.destinationCode'),
      city: requireGroundedText(option.destinationCity, 'rankedOption.destinationCity'),
      countryCode: requireGroundedText(
        option.destinationCountryCode,
        'rankedOption.destinationCountryCode',
      ),
    }),
    knownFact(
      'option.transport',
      {
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
        returnArrivalAt: requireGroundedText(
          option.returnArrivalAt,
          'rankedOption.returnArrivalAt',
        ),
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
      },
      { sourceSnapshotIds: [transportSourceId] },
    ),
    knownFact(
      'option.accommodation',
      {
        name: requireGroundedText(option.stayName, 'rankedOption.stayName'),
        checkInDate: requireGroundedText(option.checkInDate, 'rankedOption.checkInDate'),
        checkOutDate: requireGroundedText(option.checkOutDate, 'rankedOption.checkOutDate'),
        nights: requireNonNegativeInteger(option.nights, 'rankedOption.nights'),
        centralityScore: normalizeDecimal(
          option.accommodationCentralityScore,
          'rankedOption.accommodationCentralityScore',
        ),
      },
      { sourceSnapshotIds: [accommodationSourceId] },
    ),
    knownFact(
      'option.budget.summary',
      {
        currency,
        moneyDisplayVersion: GROUNDED_MONEY_DISPLAY_VERSION,
        budgetLimitMinor,
        budgetLimitDisplay: formatGroundedMoney(
          budgetLimitMinor,
          currency,
          'rankedOption.budgetLimit',
        ),
        confirmedAmountMinor,
        confirmedAmountDisplay: formatGroundedMoney(
          confirmedAmountMinor,
          currency,
          'rankedOption.confirmedAmount',
        ),
        estimatedAmountMinor,
        estimatedAmountDisplay: formatGroundedMoney(
          estimatedAmountMinor,
          currency,
          'rankedOption.estimatedAmount',
        ),
        unknownCategoryCount: requireNonNegativeInteger(
          option.unknownCategoryCount,
          'rankedOption.unknownCategoryCount',
        ),
        totalAmountMinor,
        totalAmountDisplay: formatGroundedMoney(
          totalAmountMinor,
          currency,
          'rankedOption.totalAmount',
        ),
        costPerPersonMinor,
        costPerPersonDisplay: formatGroundedMoney(
          costPerPersonMinor,
          currency,
          'rankedOption.costPerPerson',
        ),
        remainingBudgetMinor,
        remainingBudgetDisplay: formatGroundedMoney(
          remainingBudgetMinor,
          currency,
          'rankedOption.remainingBudget',
        ),
      },
      {
        internalDerivation: internalDerivation(
          `${planningRun.engineVersion}:${GROUNDED_MONEY_DISPLAY_VERSION}`,
          'budgetDerivationVersion',
        ),
      },
    ),
    knownFact(
      'option.score',
      {
        total: normalizeDecimal(option.totalScore, 'rankedOption.totalScore'),
        budgetFit: normalizeDecimal(option.budgetFitScore, 'rankedOption.budgetFitScore'),
        travelTime: normalizeDecimal(option.travelTimeScore, 'rankedOption.travelTimeScore'),
        effectiveTime: normalizeDecimal(
          option.effectiveTimeScore,
          'rankedOption.effectiveTimeScore',
        ),
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
        preferenceFit: normalizeDecimal(
          option.preferenceFitScore,
          'rankedOption.preferenceFitScore',
        ),
      },
      { internalDerivation: internalDerivation(planningRun.scoringVersion, 'scoringVersion') },
    ),
  ];
}

function createBudgetFacts(
  input: GroundedOptionContextInput,
  sources: NormalizedSources,
): readonly GroundedFactDraft[] {
  const knownSourceIds = new Set(sources.sourceSnapshots.map((source) => source.id));
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
    const sourceContext = `BUDGET:${item.category}`;
    const mappedSourceIds = sources.sourceIdsByContext.get(sourceContext) ?? [];
    if (
      (item.sourceSnapshot_ID === null && mappedSourceIds.length > 0) ||
      (item.sourceSnapshot_ID !== null &&
        (mappedSourceIds.length !== 1 || mappedSourceIds[0] !== item.sourceSnapshot_ID))
    ) {
      invalidGroundedContext(
        `Budget category ${item.category} has a dangling or ambiguous source context mapping.`,
      );
    }
    itemsByCategory.set(item.category, item);
  }

  return GROUNDED_BUDGET_CATEGORIES.map((category) => {
    const key = `option.budget.category.${category}`;
    const item = itemsByCategory.get(category);
    if (item === undefined) {
      if ((sources.sourceIdsByContext.get(`BUDGET:${category}`) ?? []).length > 0) {
        invalidGroundedContext(
          `Budget category ${category} has source provenance but no persisted budget item.`,
        );
      }
      return {
        key,
        status: 'MISSING',
        value: null,
        sourceSnapshotIds: [],
        internalDerivation: null,
      };
    }

    const sourceSnapshotIds =
      item.sourceSnapshot_ID === null ? [] : ([item.sourceSnapshot_ID] as const);
    const currency = requireGroundedText(item.currency, `budgetItems.${category}.currency`);
    const amountMinor =
      item.amountMinor === null
        ? null
        : normalizeInteger(item.amountMinor, `budgetItems.${category}.amountMinor`);
    const value = {
      category,
      amountMinor,
      amountDisplay: formatGroundedMoney(amountMinor, currency, `budgetItems.${category}`),
      moneyDisplayVersion: GROUNDED_MONEY_DISPLAY_VERSION,
      currency,
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
    return { key, status, value, sourceSnapshotIds, internalDerivation: null };
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
      { sourceSnapshotIds: [source.id] },
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
  const sources = normalizeSources(input);
  const sourceSnapshots = sources.sourceSnapshots;
  const factDrafts = [
    ...createOptionFacts(input.rankedOption, planningRun, sources),
    ...createBudgetFacts(input, sources),
    ...createSourceFacts(sourceSnapshots),
  ].sort((left, right) => left.key.localeCompare(right.key, 'en'));

  const factKeys = new Set<string>();
  for (const fact of factDrafts) {
    if (factKeys.has(fact.key)) {
      invalidGroundedContext(`Duplicate grounded fact key ${fact.key}.`);
    }
    factKeys.add(fact.key);
    if (
      new Set(fact.sourceSnapshotIds).size !== fact.sourceSnapshotIds.length ||
      fact.sourceSnapshotIds.some((sourceId) => !sourceSnapshots.some(({ id }) => id === sourceId))
    ) {
      invalidGroundedContext(`Grounded fact ${fact.key} has invalid source provenance.`);
    }
  }

  return { planningRun, rankedOption, sourceSnapshots, factDrafts };
}
