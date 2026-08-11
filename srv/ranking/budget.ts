import type {
  BudgetBreakdown,
  BudgetCategory,
  LocalCostEstimates,
  PlanningContext,
  TripCandidate,
} from '../domain/candidate.ts';
import {
  addMinorUnits,
  createMoney,
  isKnownMoney,
  sumMoney,
  unknownMoney,
  type KnownPriceType,
  type Money,
  type SourceSnapshot,
} from '../domain/money.ts';

export const INTERNAL_COST_FIXTURE_VERSION = 'internal-cost-estimates-v1';

export const INTERNAL_COST_RATES = {
  localTransportPerPersonDayMinor: 2_000,
  foodPerPersonDayMinor: 8_000,
  attractionsPerPersonDayMinor: 4_000,
  bufferBasisPoints: 1_000,
} as const;

const FIXTURE_TIMESTAMP = '2026-01-01T00:00:00.000Z';

function fixtureSource(category: string, currency: string): SourceSnapshot {
  return {
    id: `${INTERNAL_COST_FIXTURE_VERSION}:${category}:${currency}`,
    provider: 'INTERNAL_FIXTURE',
    externalItemId: category,
    fetchedAt: FIXTURE_TIMESTAMP,
    sourceUrl: 'INTERNAL_FIXTURE',
    freshnessType: 'INTERNAL_RULE',
    currency,
    fixtureVersion: INTERNAL_COST_FIXTURE_VERSION,
  };
}

function wholeDaysInclusive(startDate: string, endDate: string): number | null {
  const start = Date.parse(`${startDate}T00:00:00.000Z`);
  const end = Date.parse(`${endDate}T00:00:00.000Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
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

function estimatedMoney(amountMinor: number, currency: string, category: string): Money {
  return createMoney(amountMinor, currency, 'ESTIMATE', fixtureSource(category, currency));
}

export function estimateLocalCosts(context: PlanningContext): LocalCostEstimates {
  const days = wholeDaysInclusive(context.startDate, context.endDate);
  if (days === null || !Number.isSafeInteger(context.adults) || context.adults <= 0) {
    return {
      localTransport: unknownMoney(
        context.currency,
        fixtureSource('local-transport', context.currency),
      ),
      food: unknownMoney(context.currency, fixtureSource('food', context.currency)),
      attractions: unknownMoney(context.currency, fixtureSource('attractions', context.currency)),
    };
  }

  return {
    localTransport: estimatedMoney(
      multiplyMinorUnits(INTERNAL_COST_RATES.localTransportPerPersonDayMinor, context.adults, days),
      context.currency,
      'local-transport',
    ),
    food: estimatedMoney(
      multiplyMinorUnits(INTERNAL_COST_RATES.foodPerPersonDayMinor, context.adults, days),
      context.currency,
      'food',
    ),
    attractions: estimatedMoney(
      multiplyMinorUnits(INTERNAL_COST_RATES.attractionsPerPersonDayMinor, context.adults, days),
      context.currency,
      'attractions',
    ),
  };
}

function combinedAdditionalFees(
  candidate: Pick<TripCandidate, 'transport' | 'stay'>,
  currency: string,
): Money {
  const fees = [candidate.transport.additionalFees, candidate.stay.additionalFees];
  if (fees.some((fee) => !isKnownMoney(fee) || fee.currency !== currency)) {
    return unknownMoney(currency, fixtureSource('additional-fees', currency));
  }

  const priceType: KnownPriceType = fees.some((fee) => fee.priceType === 'ESTIMATE')
    ? 'ESTIMATE'
    : 'FIXED_PRICE';
  const amountMinor = fees.reduce(
    (total, fee) => addMinorUnits(total, isKnownMoney(fee) ? fee.amountMinor : 0),
    0,
  );
  return createMoney(amountMinor, currency, priceType, fixtureSource('additional-fees', currency));
}

function bufferFor(items: readonly Money[], currency: string): Money {
  if (items.some((item) => !isKnownMoney(item) || item.currency !== currency)) {
    return unknownMoney(currency, fixtureSource('buffer', currency));
  }
  const subtotal = sumMoney(items, currency).knownAmountMinor;
  const numerator = BigInt(subtotal) * BigInt(INTERNAL_COST_RATES.bufferBasisPoints);
  const amountMinor = Number((numerator + 9_999n) / 10_000n);
  return estimatedMoney(amountMinor, currency, 'buffer');
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

export function calculateBudgetBreakdown(
  context: PlanningContext,
  input: Pick<TripCandidate, 'transport' | 'stay' | 'localCostEstimates'>,
): BudgetBreakdown {
  const additionalFees = combinedAdditionalFees(input, context.currency);
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
    buffer: bufferFor(beforeBuffer, context.currency),
  };
  // Podsumowanie zachowuje klasyfikację każdej źródłowej opłaty. Zagregowana kategoria
  // może być ESTIMATE/UNKNOWN, ale nie może przepisać znanej części na inną klasę.
  const summaryItems = [
    input.transport.price,
    input.stay.price,
    input.localCostEstimates.localTransport,
    input.localCostEstimates.food,
    input.localCostEstimates.attractions,
    ...additionalFeeItems,
    budgetItems.buffer,
  ];
  const unknownCategories = CATEGORIES.filter(([, key]) => {
    const money = budgetItems[key];
    return !isKnownMoney(money) || money.currency !== context.currency;
  }).map(([category]) => category);

  if (unknownCategories.length > 0) {
    const usable = summaryItems.filter(
      (money): money is Money => isKnownMoney(money) && money.currency === context.currency,
    );
    const partial = sumMoney(usable, context.currency);
    return {
      ...budgetItems,
      budgetLimitMinor: context.totalBudgetMinor,
      confirmedAmountMinor: partial.confirmedAmountMinor,
      estimatedAmountMinor: partial.estimatedAmountMinor,
      unknownCategories,
      totalAmountMinor: null,
      costPerPersonMinor: null,
      remainingBudgetMinor: null,
    };
  }

  const summary = sumMoney(summaryItems, context.currency);
  const total = summary.totalAmountMinor;
  return {
    ...budgetItems,
    budgetLimitMinor: context.totalBudgetMinor,
    confirmedAmountMinor: summary.confirmedAmountMinor,
    estimatedAmountMinor: summary.estimatedAmountMinor,
    unknownCategories,
    totalAmountMinor: total,
    costPerPersonMinor: total === null ? null : divideMinorUnitsCeil(total, context.adults),
    remainingBudgetMinor: total === null ? null : context.totalBudgetMinor - total,
  };
}
