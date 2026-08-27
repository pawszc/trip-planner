import type {
  BudgetBreakdown,
  BudgetCategory,
  BudgetCategoryAmounts,
  LocalCostEstimates,
  PlanningContext,
  TripCandidate,
} from '../domain/candidate.ts';
import {
  SOURCE_SNAPSHOT_CONTRACT_VERSION,
  addMinorUnits,
  createMoney,
  isKnownMoney,
  sumMoney,
  unknownMoney,
  type KnownPriceType,
  type Money,
  type SourceSnapshot,
} from '../domain/money.ts';
import {
  createProviderFingerprint,
  type ProviderJsonValue,
} from '../providers/provider-fingerprint.ts';
import { parseStrictIsoDate } from '../validation/strict-iso-date.ts';

export const INTERNAL_COST_FIXTURE_VERSION = 'internal-cost-estimates-v1';

export const INTERNAL_COST_RATES = {
  localTransportPerPersonDayMinor: 2_000,
  foodPerPersonDayMinor: 8_000,
  attractionsPerPersonDayMinor: 4_000,
  bufferBasisPoints: 1_000,
} as const;

const FIXTURE_TIMESTAMP = '2026-01-01T00:00:00.000Z';

function internalRuleSource(
  category: string,
  context: PlanningContext,
  result: ProviderJsonValue,
): SourceSnapshot {
  const queryFingerprint = createProviderFingerprint({
    ruleVersion: INTERNAL_COST_FIXTURE_VERSION,
    rates: INTERNAL_COST_RATES,
    category,
    currency: context.currency,
    startDate: context.startDate,
    endDate: context.endDate,
    adults: context.adults,
  });
  const resultFingerprint = createProviderFingerprint({
    ruleVersion: INTERNAL_COST_FIXTURE_VERSION,
    category,
    queryFingerprint,
    result,
  });
  return {
    contractVersion: SOURCE_SNAPSHOT_CONTRACT_VERSION,
    id: `${INTERNAL_COST_FIXTURE_VERSION}:${category}:${context.currency}:${resultFingerprint}`,
    sourceType: 'INTERNAL_RULE',
    provider: 'INTERNAL_FIXTURE',
    adapterVersion: 'internal-cost-estimator-v1',
    providerVersion: INTERNAL_COST_FIXTURE_VERSION,
    upstreamApiVersion: null,
    upstreamSchemaFingerprint: null,
    queryFingerprint,
    resultFingerprint,
    externalItemId: category,
    fetchedAt: FIXTURE_TIMESTAMP,
    expiresAt: null,
    sourceUrl: 'INTERNAL_FIXTURE',
    freshnessType: 'INTERNAL_RULE',
    currency: context.currency,
    // Retained as a legacy grounded-context-v1 alias. providerVersion is authoritative in v2.
    fixtureVersion: INTERNAL_COST_FIXTURE_VERSION,
  };
}

function wholeDaysInclusive(startDate: string, endDate: string): number | null {
  const start = parseStrictIsoDate(startDate);
  const end = parseStrictIsoDate(endDate);
  if (start === null || end === null || end < start) {
    return null;
  }
  return Math.floor((end - start) / 86_400_000) + 1;
}

function multiplyMinorUnits(...factors: readonly number[]): number {
  const value = factors.reduce((result, factor) => result * BigInt(factor), 1n);
  const numberValue = Number(value);
  if (!Number.isSafeInteger(numberValue) || numberValue < 0) {
    throw new RangeError('Internal cost estimate exceeds safe integer minor units.');
  }
  return numberValue;
}

/** Dzielenie kwoty zachowuje integer minor units i zaokrągla wyłącznie w górę. */
export function divideMinorUnitsCeil(totalMinor: number, divisor: number): number {
  if (
    !Number.isSafeInteger(totalMinor) ||
    totalMinor < 0 ||
    !Number.isSafeInteger(divisor) ||
    divisor <= 0
  ) {
    throw new RangeError(
      'Minor-unit division requires a safe amount and positive integer divisor.',
    );
  }
  const result = Number((BigInt(totalMinor) + BigInt(divisor) - 1n) / BigInt(divisor));
  if (!Number.isSafeInteger(result)) {
    throw new RangeError('Minor-unit division exceeds safe integer range.');
  }
  return result;
}

function estimatedMoney(amountMinor: number, context: PlanningContext, category: string): Money {
  return createMoney(
    amountMinor,
    context.currency,
    'ESTIMATE',
    internalRuleSource(category, context, { amountMinor, priceType: 'ESTIMATE' }),
  );
}

export function estimateLocalCosts(context: PlanningContext): LocalCostEstimates {
  const days = wholeDaysInclusive(context.startDate, context.endDate);
  if (days === null || !Number.isSafeInteger(context.adults) || context.adults <= 0) {
    return {
      localTransport: unknownMoney(
        context.currency,
        internalRuleSource('local-transport', context, {
          amountMinor: null,
          priceType: 'UNKNOWN',
        }),
      ),
      food: unknownMoney(
        context.currency,
        internalRuleSource('food', context, { amountMinor: null, priceType: 'UNKNOWN' }),
      ),
      attractions: unknownMoney(
        context.currency,
        internalRuleSource('attractions', context, {
          amountMinor: null,
          priceType: 'UNKNOWN',
        }),
      ),
    };
  }

  return {
    localTransport: estimatedMoney(
      multiplyMinorUnits(INTERNAL_COST_RATES.localTransportPerPersonDayMinor, context.adults, days),
      context,
      'local-transport',
    ),
    food: estimatedMoney(
      multiplyMinorUnits(INTERNAL_COST_RATES.foodPerPersonDayMinor, context.adults, days),
      context,
      'food',
    ),
    attractions: estimatedMoney(
      multiplyMinorUnits(INTERNAL_COST_RATES.attractionsPerPersonDayMinor, context.adults, days),
      context,
      'attractions',
    ),
  };
}

function combinedAdditionalFees(
  candidate: Pick<TripCandidate, 'transport' | 'stay'>,
  context: PlanningContext,
): Money {
  const currency = context.currency;
  const fees = [candidate.transport.additionalFees, candidate.stay.additionalFees];
  if (fees.some((fee) => !isKnownMoney(fee) || fee.currency !== currency)) {
    return unknownMoney(
      currency,
      internalRuleSource('additional-fees', context, {
        amountMinor: null,
        priceType: 'UNKNOWN',
      }),
    );
  }

  const priceType: KnownPriceType = fees.some((fee) => fee.priceType === 'ESTIMATE')
    ? 'ESTIMATE'
    : 'FIXED_PRICE';
  const amountMinor = fees.reduce(
    (total, fee) => addMinorUnits(total, isKnownMoney(fee) ? fee.amountMinor : 0),
    0,
  );
  return createMoney(
    amountMinor,
    currency,
    priceType,
    internalRuleSource('additional-fees', context, { amountMinor, priceType }),
  );
}

function bufferFor(items: readonly Money[], context: PlanningContext): Money {
  const currency = context.currency;
  if (items.some((item) => !isKnownMoney(item) || item.currency !== currency)) {
    return unknownMoney(
      currency,
      internalRuleSource('buffer', context, { amountMinor: null, priceType: 'UNKNOWN' }),
    );
  }
  const subtotal = sumMoney(items, currency).knownAmountMinor;
  const numerator = BigInt(subtotal) * BigInt(INTERNAL_COST_RATES.bufferBasisPoints);
  const amountMinor = Number((numerator + 9_999n) / 10_000n);
  return estimatedMoney(amountMinor, context, 'buffer');
}

const CATEGORIES = [
  ['TRANSPORT', 'transport'],
  ['ACCOMMODATION', 'accommodation'],
  ['LOCAL_TRANSPORT', 'localTransport'],
  ['FOOD', 'food'],
  ['ATTRACTIONS', 'attractions'],
  ['ADDITIONAL_FEES', 'additionalFees'],
  ['BUFFER', 'buffer'],
] as const satisfies readonly (readonly [BudgetCategory, keyof BudgetBreakdown])[];

function knownCategoryAmounts(items: readonly Money[], currency: string): BudgetCategoryAmounts {
  const knownInCurrency = items.filter(
    (item): item is Money => isKnownMoney(item) && item.currency === currency,
  );
  const summary = sumMoney(knownInCurrency, currency);
  return {
    confirmedAmountMinor: summary.confirmedAmountMinor,
    estimatedAmountMinor: summary.estimatedAmountMinor,
  };
}

function sumCategoryAmounts(
  categoryAmounts: Readonly<Record<BudgetCategory, BudgetCategoryAmounts>>,
): BudgetCategoryAmounts {
  return Object.values(categoryAmounts).reduce<BudgetCategoryAmounts>(
    (total, amounts) => ({
      confirmedAmountMinor: addMinorUnits(total.confirmedAmountMinor, amounts.confirmedAmountMinor),
      estimatedAmountMinor: addMinorUnits(total.estimatedAmountMinor, amounts.estimatedAmountMinor),
    }),
    { confirmedAmountMinor: 0, estimatedAmountMinor: 0 },
  );
}

export function calculateBudgetBreakdown(
  context: PlanningContext,
  input: Pick<TripCandidate, 'transport' | 'stay' | 'localCostEstimates'>,
): BudgetBreakdown {
  const additionalFees = combinedAdditionalFees(input, context);
  const additionalFeeItems = [input.transport.additionalFees, input.stay.additionalFees];
  const beforeBuffer = [
    input.transport.price,
    input.stay.price,
    input.localCostEstimates.localTransport,
    input.localCostEstimates.food,
    input.localCostEstimates.attractions,
    ...additionalFeeItems,
  ];
  const budgetItems = {
    transport: input.transport.price,
    accommodation: input.stay.price,
    localTransport: input.localCostEstimates.localTransport,
    food: input.localCostEstimates.food,
    attractions: input.localCostEstimates.attractions,
    additionalFees,
    buffer: bufferFor(beforeBuffer, context),
  };
  // Części kategorii są częścią wyniku kalkulatora. Zagregowane additional fees mogą mieć
  // jednocześnie część confirmed i estimated, również gdy inna składowa jest UNKNOWN.
  const categoryAmounts: Readonly<Record<BudgetCategory, BudgetCategoryAmounts>> = {
    TRANSPORT: knownCategoryAmounts([budgetItems.transport], context.currency),
    ACCOMMODATION: knownCategoryAmounts([budgetItems.accommodation], context.currency),
    LOCAL_TRANSPORT: knownCategoryAmounts([budgetItems.localTransport], context.currency),
    FOOD: knownCategoryAmounts([budgetItems.food], context.currency),
    ATTRACTIONS: knownCategoryAmounts([budgetItems.attractions], context.currency),
    ADDITIONAL_FEES: knownCategoryAmounts(additionalFeeItems, context.currency),
    BUFFER: knownCategoryAmounts([budgetItems.buffer], context.currency),
  };
  const categoryTotals = sumCategoryAmounts(categoryAmounts);
  const unknownCategories = CATEGORIES.filter(([, key]) => {
    const money = budgetItems[key];
    return !isKnownMoney(money) || money.currency !== context.currency;
  }).map(([category]) => category);

  if (unknownCategories.length > 0) {
    return {
      ...budgetItems,
      categoryAmounts,
      budgetLimitMinor: context.totalBudgetMinor,
      confirmedAmountMinor: categoryTotals.confirmedAmountMinor,
      estimatedAmountMinor: categoryTotals.estimatedAmountMinor,
      unknownCategories,
      totalAmountMinor: null,
      costPerPersonMinor: null,
      remainingBudgetMinor: null,
    };
  }

  const total = addMinorUnits(
    categoryTotals.confirmedAmountMinor,
    categoryTotals.estimatedAmountMinor,
  );
  return {
    ...budgetItems,
    categoryAmounts,
    budgetLimitMinor: context.totalBudgetMinor,
    confirmedAmountMinor: categoryTotals.confirmedAmountMinor,
    estimatedAmountMinor: categoryTotals.estimatedAmountMinor,
    unknownCategories,
    totalAmountMinor: total,
    costPerPersonMinor: total === null ? null : divideMinorUnitsCeil(total, context.adults),
    remainingBudgetMinor: total === null ? null : context.totalBudgetMinor - total,
  };
}
