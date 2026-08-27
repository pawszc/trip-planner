import { isSupportedCurrency, SUPPORTED_CURRENCY_CODES } from './currency.ts';

/** Jawne pochodzenie ceny lub faktu użytego przez deterministyczny silnik. */
export const FRESHNESS_TYPE_VALUES = ['LIVE', 'CACHED', 'FIXTURE', 'INTERNAL_RULE'] as const;
export type FreshnessType = (typeof FRESHNESS_TYPE_VALUES)[number];

export const SOURCE_SNAPSHOT_CONTRACT_VERSION = 'source-snapshot-v2';
export const SOURCE_TYPE_VALUES = ['LIVE', 'FIXTURE', 'INTERNAL_RULE'] as const;
export type SourceType = (typeof SOURCE_TYPE_VALUES)[number];

/**
 * Provider-neutral provenance written by every new provider result.
 *
 * Nullable lineage fields mean "the upstream did not publish this fact", never an inferred
 * value. `fixtureVersion` is retained only for explicit fixture compatibility and is null for
 * live sources. Query/result fingerprints identify canonical, locally safe views rather than
 * raw provider payloads.
 */
export interface SourceSnapshot {
  contractVersion: typeof SOURCE_SNAPSHOT_CONTRACT_VERSION;
  id: string;
  sourceType: SourceType;
  provider: string;
  adapterVersion: string;
  providerVersion: string;
  upstreamApiVersion: string | null;
  upstreamSchemaFingerprint: string | null;
  queryFingerprint: string;
  resultFingerprint: string;
  externalItemId: string;
  fetchedAt: string;
  expiresAt: string | null;
  sourceUrl: string;
  freshnessType: FreshnessType;
  currency: string;
  fixtureVersion: string | null;
}

/** Exact historical fixture shape. Readers may expose it without inventing v2 lineage. */
export interface LegacyFixtureSourceSnapshot {
  id: string;
  provider: string;
  externalItemId: string;
  fetchedAt: string;
  sourceUrl: string;
  freshnessType: FreshnessType;
  currency: string;
  fixtureVersion: string;
}

export interface SourceSnapshotLineageView {
  contractVersion: typeof SOURCE_SNAPSHOT_CONTRACT_VERSION | 'source-snapshot-v1-legacy';
  sourceType: SourceType;
  adapterVersion: string | null;
  providerVersion: string | null;
  upstreamApiVersion: string | null;
  upstreamSchemaFingerprint: string | null;
  queryFingerprint: string | null;
  resultFingerprint: string | null;
  expiresAt: string | null;
  fixtureVersion: string | null;
}

/**
 * Dual-read compatibility view. Legacy fixture rows stay explicitly legacy; missing v2
 * fingerprints or versions are not synthesized and no persisted row is rewritten.
 */
export function sourceSnapshotLineage(
  source: SourceSnapshot | LegacyFixtureSourceSnapshot,
): SourceSnapshotLineageView {
  if ('contractVersion' in source) {
    return {
      contractVersion: source.contractVersion,
      sourceType: source.sourceType,
      adapterVersion: source.adapterVersion,
      providerVersion: source.providerVersion,
      upstreamApiVersion: source.upstreamApiVersion,
      upstreamSchemaFingerprint: source.upstreamSchemaFingerprint,
      queryFingerprint: source.queryFingerprint,
      resultFingerprint: source.resultFingerprint,
      expiresAt: source.expiresAt,
      fixtureVersion: source.fixtureVersion,
    };
  }

  return {
    contractVersion: 'source-snapshot-v1-legacy',
    sourceType: 'FIXTURE',
    adapterVersion: null,
    providerVersion: null,
    upstreamApiVersion: null,
    upstreamSchemaFingerprint: null,
    queryFingerprint: null,
    resultFingerprint: null,
    expiresAt: null,
    fixtureVersion: source.fixtureVersion,
  };
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

/** Runtime guard for locally mapped provider money; returns field names, never raw values. */
export function moneyValidationIssues(value: unknown, path: string): readonly string[] {
  if (typeof value !== 'object' || value === null) return Object.freeze([path]);
  const candidate = value as Readonly<Record<string, unknown>>;
  const issues: string[] = [];
  const expectedKeys = ['amountMinor', 'currency', 'priceType', 'sourceSnapshot'];
  const actualKeys = Object.keys(candidate).sort((left, right) => left.localeCompare(right, 'en'));
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    issues.push(`${path}.fields`);
  }
  if (!isSupportedCurrency(candidate.currency)) issues.push(`${path}.currency`);
  if (!PRICE_TYPE_VALUES.includes(candidate.priceType as PriceType)) {
    issues.push(`${path}.priceType`);
  } else if (candidate.priceType === 'UNKNOWN') {
    if (candidate.amountMinor !== null) issues.push(`${path}.amountMinor`);
  } else if (
    !Number.isSafeInteger(candidate.amountMinor) ||
    (candidate.amountMinor as number) < 0
  ) {
    issues.push(`${path}.amountMinor`);
  }
  if (
    candidate.sourceSnapshot !== null &&
    (typeof candidate.sourceSnapshot !== 'object' || candidate.sourceSnapshot === null)
  ) {
    issues.push(`${path}.sourceSnapshot`);
  }
  return Object.freeze(issues);
}

export function isMoney(value: unknown): value is Money {
  return moneyValidationIssues(value, 'money').length === 0;
}

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
  if (!isSupportedCurrency(currency)) {
    throw new MoneyError(
      'INVALID_CURRENCY',
      `Waluta ${currency || '(pusta)'} nie jest obsługiwana; dozwolone: ${SUPPORTED_CURRENCY_CODES.join(', ')}.`,
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
