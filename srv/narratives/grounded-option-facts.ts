import type { JsonValue } from '../ai/contracts.ts';
import { CURRENCY_CONTRACT_VERSION } from '../domain/currency.ts';
import { DomainError } from '../domain/domain-error.ts';
import {
  type ValidatedGroundedBudget,
  validateGroundedBudgetConsistency,
} from './grounded-budget-consistency.ts';
import {
  GROUNDED_BUDGET_CATEGORIES,
  type DecimalValue,
  type GroundedContextPlanningRun,
  type GroundedContextRankedOption,
  type GroundedFactDraft,
  type GroundedInternalDerivation,
  type GroundedOptionContextInput,
  type GroundedRankedOptionRecord,
  type GroundedSourceSnapshot,
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

function normalizeSources(
  input: GroundedOptionContextInput,
  expectedCurrency: string,
): NormalizedSources {
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
      const currency = requireGroundedText(source.currency, 'sourceSnapshots.currency');
      if (currency !== expectedCurrency) {
        invalidGroundedContext('A source snapshot uses a different grounded currency.');
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
        currency,
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
  budget: ValidatedGroundedBudget,
): readonly GroundedFactDraft[] {
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
    {
      key: 'option.budget.summary',
      status: budget.status,
      value: {
        currency: budget.currency,
        currencyContractVersion: budget.currencyContractVersion,
        moneyDisplayVersion: GROUNDED_MONEY_DISPLAY_VERSION,
        budgetLimitMinor: budget.budgetLimitMinor,
        budgetLimitDisplay: formatGroundedMoney(
          budget.budgetLimitMinor,
          budget.currency,
          'rankedOption.budgetLimit',
        ),
        confirmedAmountMinor: budget.confirmedAmountMinor,
        confirmedAmountDisplay: formatGroundedMoney(
          budget.confirmedAmountMinor,
          budget.currency,
          'rankedOption.confirmedAmount',
        ),
        estimatedAmountMinor: budget.estimatedAmountMinor,
        estimatedAmountDisplay: formatGroundedMoney(
          budget.estimatedAmountMinor,
          budget.currency,
          'rankedOption.estimatedAmount',
        ),
        unknownCategoryCount: budget.unknownCategoryCount,
        totalAmountMinor: budget.totalAmountMinor,
        totalAmountDisplay: formatGroundedMoney(
          budget.totalAmountMinor,
          budget.currency,
          'rankedOption.totalAmount',
        ),
        costPerPersonMinor: budget.costPerPersonMinor,
        costPerPersonDisplay: formatGroundedMoney(
          budget.costPerPersonMinor,
          budget.currency,
          'rankedOption.costPerPerson',
        ),
        remainingBudgetMinor: budget.remainingBudgetMinor,
        remainingBudgetDisplay: formatGroundedMoney(
          budget.remainingBudgetMinor,
          budget.currency,
          'rankedOption.remainingBudget',
        ),
      },
      sourceSnapshotIds: [],
      internalDerivation: internalDerivation(
        `${planningRun.engineVersion}:${GROUNDED_MONEY_DISPLAY_VERSION}:${CURRENCY_CONTRACT_VERSION}`,
        'budgetDerivationVersion',
      ),
    },
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
  budget: ValidatedGroundedBudget,
): readonly GroundedFactDraft[] {
  const knownSourceIds = new Set(sources.sourceSnapshots.map((source) => source.id));
  for (const [category, validatedItem] of budget.itemsByCategory) {
    const item = validatedItem.record;
    if (item.sourceSnapshot_ID !== null && !knownSourceIds.has(item.sourceSnapshot_ID)) {
      invalidGroundedContext(`Budget category ${category} references an unknown source snapshot.`);
    }
    const sourceContext = `BUDGET:${category}`;
    const mappedSourceIds = sources.sourceIdsByContext.get(sourceContext) ?? [];
    if (
      (item.sourceSnapshot_ID === null && mappedSourceIds.length > 0) ||
      (item.sourceSnapshot_ID !== null &&
        (mappedSourceIds.length !== 1 || mappedSourceIds[0] !== item.sourceSnapshot_ID))
    ) {
      invalidGroundedContext(
        `Budget category ${category} has a dangling or ambiguous source context mapping.`,
      );
    }
  }

  return GROUNDED_BUDGET_CATEGORIES.map((category) => {
    const key = `option.budget.category.${category}`;
    const validatedItem = budget.itemsByCategory.get(category);
    if (validatedItem === undefined) {
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

    const item = validatedItem.record;
    const sourceSnapshotIds =
      item.sourceSnapshot_ID === null ? [] : ([item.sourceSnapshot_ID] as const);
    const value = {
      category,
      amountMinor: validatedItem.amountMinor,
      amountDisplay: formatGroundedMoney(
        validatedItem.amountMinor,
        budget.currency,
        `budgetItems.${category}`,
      ),
      currencyContractVersion: budget.currencyContractVersion,
      moneyDisplayVersion: GROUNDED_MONEY_DISPLAY_VERSION,
      currency: budget.currency,
      classification: item.classification,
      priceType: item.priceType,
      sourceSnapshotId: item.sourceSnapshot_ID,
    };
    return {
      key,
      status: validatedItem.status,
      value,
      sourceSnapshotIds,
      internalDerivation: null,
    };
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

function validateGroundedLineage(input: GroundedOptionContextInput): void {
  const planningRunId = requireGroundedText(input.planningRun.ID, 'planningRun.ID');
  const tripRequestId = requireGroundedText(
    input.planningRun.tripRequest_ID,
    'planningRun.tripRequest_ID',
  );
  const providerFixtureVersion = requireGroundedText(
    input.planningRun.providerFixtureVersion,
    'planningRun.providerFixtureVersion',
  );
  const scoringVersion = requireGroundedText(
    input.planningRun.scoringVersion,
    'planningRun.scoringVersion',
  );
  if (input.tripRequest.ID !== tripRequestId) {
    invalidGroundedContext('The PlanningRun belongs to a different TripRequest.');
  }

  const descendants = [
    { kind: 'ranked option', record: input.rankedOption },
    ...input.budgetItems.map((record) => ({ kind: 'budget item', record })),
    ...input.sourceSnapshots.map((record) => ({ kind: 'source snapshot', record })),
  ];
  for (const { kind, record } of descendants) {
    if (
      record.tripRequest_ID !== tripRequestId ||
      record.planningRun_ID !== planningRunId ||
      record.providerFixtureVersion !== providerFixtureVersion ||
      record.scoringVersion !== scoringVersion
    ) {
      invalidGroundedContext(
        `A ${kind} has inconsistent PlanningRun, provider fixture, or scoring lineage.`,
      );
    }
  }
  if (
    [...input.budgetItems, ...input.sourceSnapshots].some(
      (record) => record.rankedOption_ID !== input.rankedOption.ID,
    )
  ) {
    invalidGroundedContext('A budget or source record belongs to a different RankedOption.');
  }
}

export function buildGroundedContextComponents(
  input: GroundedOptionContextInput,
): GroundedContextComponents {
  if (input.planningRun.status !== 'SUCCEEDED') {
    invalidGroundedContext('Grounded narratives require a successful PlanningRun.');
  }
  validateGroundedLineage(input);

  const planningRun: GroundedContextPlanningRun = {
    id: requireGroundedText(input.planningRun.ID, 'planningRun.ID'),
    requestFingerprint: requireGroundedText(
      input.planningRun.requestFingerprint,
      'planningRun.requestFingerprint',
    ),
    currencyContractVersion: CURRENCY_CONTRACT_VERSION,
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
  const budget = validateGroundedBudgetConsistency(input);
  const sources = normalizeSources(input, budget.currency);
  const sourceSnapshots = sources.sourceSnapshots;
  const factDrafts = [
    ...createOptionFacts(input.rankedOption, planningRun, sources, budget),
    ...createBudgetFacts(input, sources, budget),
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
