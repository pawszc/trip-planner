/** Jawne pochodzenie ceny lub faktu użytego przez deterministyczny silnik. */
export const FRESHNESS_TYPE_VALUES = ['LIVE', 'CACHED', 'FIXTURE', 'INTERNAL_RULE'] as const;
export type FreshnessType = (typeof FRESHNESS_TYPE_VALUES)[number];

/** Marker INTERNAL_FIXTURE odróżnia stabilne dane lokalne od adresu zewnętrznego. */
export interface SourceSnapshot {
  id: string;
  provider: string;
  externalItemId: string;
  fetchedAt: string;
  sourceUrl: string;
  freshnessType: FreshnessType;
  currency: string;
  fixtureVersion: string;
}

export const PRICE_TYPE_VALUES = ['LIVE_PRICE', 'FIXED_PRICE', 'ESTIMATE', 'UNKNOWN'] as const;
export type PriceType = (typeof PRICE_TYPE_VALUES)[number];

export const KNOWN_PRICE_TYPE_VALUES = ['LIVE_PRICE', 'FIXED_PRICE', 'ESTIMATE'] as const;
export type KnownPriceType = (typeof KNOWN_PRICE_TYPE_VALUES)[number];

interface MoneyBase {
  currency: string;
  /** Null jest dozwolony wyłącznie po to, aby filtr mógł zgłosić SOURCE_MISSING. */
  sourceSnapshot: SourceSnapshot | null;
}

export interface KnownMoney extends MoneyBase {
  amountMinor: number;
  priceType: KnownPriceType;
}

export interface UnknownMoney extends MoneyBase {
  amountMinor: null;
  priceType: 'UNKNOWN';
}

/** UNKNOWN jest osobnym wariantem unii i nigdy nie otrzymuje wymyślonej kwoty. */
export type Money = KnownMoney | UnknownMoney;

export const MONEY_CLASSIFICATION_VALUES = ['CONFIRMED', 'ESTIMATED', 'UNKNOWN'] as const;
export type MoneyClassification = (typeof MONEY_CLASSIFICATION_VALUES)[number];

export const MONEY_ERROR_CODE_VALUES = [
  'INVALID_MINOR_AMOUNT',
  'INVALID_CURRENCY',
  'CURRENCY_MISMATCH',
  'MINOR_UNIT_OVERFLOW',
] as const;
export type MoneyErrorCode = (typeof MONEY_ERROR_CODE_VALUES)[number];

/** Kontrolowany błąd arytmetyki pieniężnej ze stabilnym kodem dla testów i filtrów. */
export class MoneyError extends Error {
  public readonly code: MoneyErrorCode;
  public readonly expectedCurrency?: string;
  public readonly actualCurrency?: string;

  constructor(
    code: MoneyErrorCode,
    message: string,
    context: { expectedCurrency?: string; actualCurrency?: string } = {},
  ) {
    super(message);
    this.name = 'MoneyError';
    this.code = code;
    if (context.expectedCurrency !== undefined) {
      this.expectedCurrency = context.expectedCurrency;
    }
    if (context.actualCurrency !== undefined) {
      this.actualCurrency = context.actualCurrency;
    }
  }
}

export interface MoneySummary {
  currency: string;
  confirmedAmountMinor: number;
  estimatedAmountMinor: number;
  knownAmountMinor: number;
  unknownCount: number;
  /** Suma jest nieznana, jeśli choć jeden jej wymagany składnik jest UNKNOWN. */
  totalAmountMinor: number | null;
}

function assertCurrency(currency: string): void {
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new MoneyError(
      'INVALID_CURRENCY',
      `Waluta ${currency || '(pusta)'} nie jest trzyliterowym kodem zapisanym wielkimi literami.`,
    );
  }
}

function assertMinorAmount(amountMinor: number): void {
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) {
    throw new MoneyError(
      'INVALID_MINOR_AMOUNT',
      `Kwota w minor units musi być nieujemną bezpieczną liczbą całkowitą; otrzymano ${amountMinor}.`,
    );
  }
}

/** Tworzy kontrolowaną cenę znaną, przechowywaną wyłącznie w integer minor units. */
export function createMoney(
  amountMinor: number,
  currency: string,
  priceType: KnownPriceType,
  sourceSnapshot: SourceSnapshot | null,
): KnownMoney {
  assertMinorAmount(amountMinor);
  assertCurrency(currency);

  return { amountMinor, currency, priceType, sourceSnapshot };
}

/** Tworzy jawny brak ceny bez wartości zastępczej. */
export function unknownMoney(
  currency: string,
  sourceSnapshot: SourceSnapshot | null,
): UnknownMoney {
  assertCurrency(currency);
  return { amountMinor: null, currency, priceType: 'UNKNOWN', sourceSnapshot };
}

export function isKnownMoney(money: Money): money is KnownMoney {
  return money.priceType !== 'UNKNOWN';
}

/** LIVE_PRICE i FIXED_PRICE są potwierdzone; ESTIMATE pozostaje osobną klasą. */
export function classifyMoney(money: Money): MoneyClassification {
  if (money.priceType === 'UNKNOWN') {
    return 'UNKNOWN';
  }
  return money.priceType === 'ESTIMATE' ? 'ESTIMATED' : 'CONFIRMED';
}

/** Chroni przed cichym mieszaniem walut; przewalutowanie nie należy do Fazy 2B. */
export function assertMoneyCurrency(money: Money, expectedCurrency: string): void {
  assertCurrency(expectedCurrency);
  if (money.currency !== expectedCurrency) {
    throw new MoneyError(
      'CURRENCY_MISMATCH',
      `Nie można użyć kwoty w ${money.currency} w zestawieniu prowadzonym w ${expectedCurrency}.`,
      { expectedCurrency, actualCurrency: money.currency },
    );
  }
}

/** Dodawanie minor units przerywa działanie przed utratą precyzji Number. */
export function addMinorUnits(left: number, right: number): number {
  assertMinorAmount(left);
  assertMinorAmount(right);
  const result = left + right;
  if (!Number.isSafeInteger(result)) {
    throw new MoneyError(
      'MINOR_UNIT_OVERFLOW',
      `Suma ${left} + ${right} przekracza bezpieczny zakres integer minor units.`,
    );
  }
  return result;
}

/**
 * Sumuje ceny jednej waluty i zachowuje rozdział kwot potwierdzonych, estymowanych
 * oraz braków. UNKNOWN nie jest traktowane jak zero w wyniku całkowitym.
 */
export function sumMoney(items: readonly Money[], currency: string): MoneySummary {
  assertCurrency(currency);

  let confirmedAmountMinor = 0;
  let estimatedAmountMinor = 0;
  let unknownCount = 0;

  for (const item of items) {
    assertMoneyCurrency(item, currency);
    if (item.priceType === 'UNKNOWN') {
      unknownCount += 1;
    } else if (item.priceType === 'ESTIMATE') {
      estimatedAmountMinor = addMinorUnits(estimatedAmountMinor, item.amountMinor);
    } else {
      confirmedAmountMinor = addMinorUnits(confirmedAmountMinor, item.amountMinor);
    }
  }

  const knownAmountMinor = addMinorUnits(confirmedAmountMinor, estimatedAmountMinor);
  return {
    currency,
    confirmedAmountMinor,
    estimatedAmountMinor,
    knownAmountMinor,
    unknownCount,
    totalAmountMinor: unknownCount === 0 ? knownAmountMinor : null,
  };
}
