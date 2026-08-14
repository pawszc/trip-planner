import {
  getSupportedCurrencyDefinitionForContract,
  isSupportedCurrencyContractVersion,
} from '../domain/currency.ts';
import { DomainError } from '../domain/domain-error.ts';
import { majorUnitsToMinorUnits } from '../orchestration/planning-request.ts';
import {
  GROUNDED_BUDGET_CATEGORIES,
  type GroundedBudgetCategory,
  type GroundedBudgetItemRecord,
  type GroundedFactStatus,
  type GroundedOptionContextInput,
} from './grounded-option-types.ts';

const MAX_SAFE_MINOR = BigInt(Number.MAX_SAFE_INTEGER);

export interface ValidatedGroundedBudgetItem {
  readonly record: GroundedBudgetItemRecord;
  readonly amountMinor: string | null;
  readonly confirmedAmountMinor: string;
  readonly estimatedAmountMinor: string;
  readonly status: 'KNOWN' | 'UNKNOWN';
}

export interface ValidatedGroundedBudget {
  readonly currency: string;
  readonly currencyContractVersion: string;
  readonly budgetLimitMinor: string;
  readonly confirmedAmountMinor: string;
  readonly estimatedAmountMinor: string;
  readonly unknownCategoryCount: number;
  readonly totalAmountMinor: string | null;
  readonly costPerPersonMinor: string | null;
  readonly remainingBudgetMinor: string | null;
  readonly status: GroundedFactStatus;
  readonly itemsByCategory: ReadonlyMap<GroundedBudgetCategory, ValidatedGroundedBudgetItem>;
}

function invalidBudget(message: string): never {
  throw new DomainError('INVALID_GROUNDED_OPTION_CONTEXT', message);
}

function normalizeInteger(
  value: unknown,
  field: string,
  allowNegative = false,
): { text: string; integer: bigint } {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) {
    invalidBudget(`Grounded context field ${field} is not a safe integer.`);
  }
  if (typeof value !== 'number' && typeof value !== 'string') {
    invalidBudget(`Grounded context field ${field} is not a minor-unit integer.`);
  }
  const raw = typeof value === 'number' ? String(value) : value.trim();
  const pattern = allowNegative ? /^-?\d+$/ : /^\d+$/;
  if (!pattern.test(raw)) {
    invalidBudget(`Grounded context field ${field} is not a valid minor-unit integer.`);
  }
  const integer = BigInt(raw);
  if ((!allowNegative && integer < 0n) || integer > MAX_SAFE_MINOR || integer < -MAX_SAFE_MINOR) {
    invalidBudget(`Grounded context field ${field} is outside the safe minor-unit range.`);
  }
  return { text: integer.toString(), integer };
}

function normalizeOptionalInteger(
  value: unknown,
  field: string,
  allowNegative = false,
): { text: string; integer: bigint } | null {
  return value === null ? null : normalizeInteger(value, field, allowNegative);
}

function requireEqual(actual: bigint, expected: bigint, field: string): void {
  if (actual !== expected) {
    invalidBudget(`Grounded budget aggregate ${field} contradicts its category facts.`);
  }
}

function requiredClassification(
  priceType: GroundedBudgetItemRecord['priceType'],
): GroundedBudgetItemRecord['classification'] | null {
  if (priceType === 'LIVE_PRICE' || priceType === 'FIXED_PRICE') return 'CONFIRMED';
  if (priceType === 'ESTIMATE') return 'ESTIMATED';
  if (priceType === 'UNKNOWN') return 'UNKNOWN';
  return null;
}

/**
 * Validates every financial field before facts are exposed to the model. Partial budgets keep
 * their known subtotals, but complete aggregates are null and the summary is not KNOWN.
 */
export function validateGroundedBudgetConsistency(
  input: GroundedOptionContextInput,
): ValidatedGroundedBudget {
  const { rankedOption: option, tripRequest } = input;
  const persistedCurrencyContractVersion = input.planningRun.currencyContractVersion;
  if (!isSupportedCurrencyContractVersion(persistedCurrencyContractVersion)) {
    invalidBudget('Grounded budget has a missing or unsupported currency contract version.');
  }
  const currencyContractVersion = persistedCurrencyContractVersion;
  const currency = getSupportedCurrencyDefinitionForContract(
    currencyContractVersion,
    option.currency,
  );
  if (currency === null || tripRequest.currency !== currency.code) {
    invalidBudget(
      'Grounded budget uses a missing/unsupported currency contract version or inconsistent currency.',
    );
  }

  if (!Number.isSafeInteger(tripRequest.adults) || tripRequest.adults <= 0) {
    invalidBudget('Grounded budget has no valid traveler count for per-person arithmetic.');
  }

  let requestedBudgetMinor: number;
  try {
    requestedBudgetMinor = majorUnitsToMinorUnits(
      tripRequest.totalBudget,
      tripRequest.currency,
      currencyContractVersion,
    );
  } catch {
    invalidBudget('Grounded budget cannot derive the persisted TripRequest budget safely.');
  }

  const budgetLimit = normalizeInteger(option.budgetLimitMinor, 'rankedOption.budgetLimitMinor');
  if (budgetLimit.integer !== BigInt(requestedBudgetMinor)) {
    invalidBudget('Grounded budget limit contradicts the persisted TripRequest budget.');
  }

  const itemsByCategory = new Map<GroundedBudgetCategory, ValidatedGroundedBudgetItem>();
  let confirmed = 0n;
  let estimated = 0n;
  let unknownCount = 0;

  for (const item of input.budgetItems) {
    if (!GROUNDED_BUDGET_CATEGORIES.some((category) => category === item.category)) {
      invalidBudget(`Grounded budget has unsupported category ${String(item.category)}.`);
    }
    if (itemsByCategory.has(item.category)) {
      invalidBudget(`Grounded budget has duplicate category ${item.category}.`);
    }
    if (item.currency !== currency.code) {
      invalidBudget(`Grounded budget category ${item.category} uses another currency.`);
    }

    const expectedClassification = requiredClassification(item.priceType);
    if (expectedClassification === null || item.classification !== expectedClassification) {
      invalidBudget(
        `Grounded budget category ${item.category} has an invalid price classification.`,
      );
    }

    if (item.priceType === 'UNKNOWN') {
      if (item.amountMinor !== null) {
        invalidBudget(`Grounded budget category ${item.category} gives UNKNOWN a value.`);
      }
      const confirmedPart = normalizeInteger(
        item.confirmedAmountMinor,
        `budgetItems.${item.category}.confirmedAmountMinor`,
      );
      const estimatedPart = normalizeInteger(
        item.estimatedAmountMinor,
        `budgetItems.${item.category}.estimatedAmountMinor`,
      );
      confirmed += confirmedPart.integer;
      estimated += estimatedPart.integer;
      if (confirmed > MAX_SAFE_MINOR || estimated > MAX_SAFE_MINOR) {
        invalidBudget('Grounded budget category subtotals exceed the safe minor-unit range.');
      }
      unknownCount += 1;
      itemsByCategory.set(item.category, {
        record: item,
        amountMinor: null,
        confirmedAmountMinor: confirmedPart.text,
        estimatedAmountMinor: estimatedPart.text,
        status: 'UNKNOWN',
      });
      continue;
    }

    if (item.amountMinor === null) {
      invalidBudget(`Grounded budget category ${item.category} has no required known amount.`);
    }
    const amount = normalizeInteger(item.amountMinor, `budgetItems.${item.category}.amountMinor`);
    const confirmedPart = normalizeInteger(
      item.confirmedAmountMinor,
      `budgetItems.${item.category}.confirmedAmountMinor`,
    );
    const estimatedPart = normalizeInteger(
      item.estimatedAmountMinor,
      `budgetItems.${item.category}.estimatedAmountMinor`,
    );
    if (confirmedPart.integer + estimatedPart.integer !== amount.integer) {
      invalidBudget(`Grounded budget category ${item.category} components contradict amountMinor.`);
    }
    if (item.classification === 'CONFIRMED' && estimatedPart.integer !== 0n) {
      invalidBudget(`Grounded budget category ${item.category} has estimated confirmed money.`);
    }
    if (
      item.classification === 'ESTIMATED' &&
      amount.integer > 0n &&
      estimatedPart.integer === 0n
    ) {
      invalidBudget(`Grounded budget category ${item.category} has no estimated component.`);
    }
    confirmed += confirmedPart.integer;
    estimated += estimatedPart.integer;
    if (confirmed > MAX_SAFE_MINOR || estimated > MAX_SAFE_MINOR) {
      invalidBudget('Grounded budget category subtotals exceed the safe minor-unit range.');
    }
    itemsByCategory.set(item.category, {
      record: item,
      amountMinor: amount.text,
      confirmedAmountMinor: confirmedPart.text,
      estimatedAmountMinor: estimatedPart.text,
      status: 'KNOWN',
    });
  }

  const missingCount = GROUNDED_BUDGET_CATEGORIES.filter(
    (category) => !itemsByCategory.has(category),
  ).length;
  const incompleteCount = unknownCount + missingCount;
  const persistedUnknownCount = option.unknownCategoryCount;
  if (!Number.isSafeInteger(persistedUnknownCount) || persistedUnknownCount !== incompleteCount) {
    invalidBudget('Grounded budget unknownCategoryCount contradicts category completeness.');
  }

  const persistedConfirmed = normalizeInteger(
    option.confirmedAmountMinor,
    'rankedOption.confirmedAmountMinor',
  );
  const persistedEstimated = normalizeInteger(
    option.estimatedAmountMinor,
    'rankedOption.estimatedAmountMinor',
  );
  requireEqual(persistedConfirmed.integer, confirmed, 'confirmedAmountMinor');
  requireEqual(persistedEstimated.integer, estimated, 'estimatedAmountMinor');

  const total = normalizeOptionalInteger(option.totalAmountMinor, 'rankedOption.totalAmountMinor');
  const perPerson = normalizeOptionalInteger(
    option.costPerPersonMinor,
    'rankedOption.costPerPersonMinor',
  );
  const remaining = normalizeOptionalInteger(
    option.remainingBudgetMinor,
    'rankedOption.remainingBudgetMinor',
    true,
  );

  if (incompleteCount > 0) {
    if (total !== null || perPerson !== null || remaining !== null) {
      invalidBudget('An incomplete grounded budget cannot expose complete aggregate values.');
    }
    return {
      currency: currency.code,
      currencyContractVersion,
      budgetLimitMinor: budgetLimit.text,
      confirmedAmountMinor: persistedConfirmed.text,
      estimatedAmountMinor: persistedEstimated.text,
      unknownCategoryCount: incompleteCount,
      totalAmountMinor: null,
      costPerPersonMinor: null,
      remainingBudgetMinor: null,
      status: missingCount > 0 ? 'MISSING' : 'UNKNOWN',
      itemsByCategory,
    };
  }

  if (total === null || perPerson === null || remaining === null) {
    invalidBudget('A complete grounded budget is missing required aggregate values.');
  }
  const expectedTotal = confirmed + estimated;
  if (expectedTotal > MAX_SAFE_MINOR) {
    invalidBudget('Grounded budget total exceeds the safe minor-unit range.');
  }
  const adults = BigInt(tripRequest.adults);
  const expectedPerPerson = (expectedTotal + adults - 1n) / adults;
  const expectedRemaining = budgetLimit.integer - expectedTotal;
  requireEqual(total.integer, expectedTotal, 'totalAmountMinor');
  requireEqual(perPerson.integer, expectedPerPerson, 'costPerPersonMinor');
  requireEqual(remaining.integer, expectedRemaining, 'remainingBudgetMinor');

  return {
    currency: currency.code,
    currencyContractVersion,
    budgetLimitMinor: budgetLimit.text,
    confirmedAmountMinor: persistedConfirmed.text,
    estimatedAmountMinor: persistedEstimated.text,
    unknownCategoryCount: 0,
    totalAmountMinor: total.text,
    costPerPersonMinor: perPerson.text,
    remainingBudgetMinor: remaining.text,
    status: 'KNOWN',
    itemsByCategory,
  };
}
