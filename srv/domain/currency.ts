/**
 * Zamknięty kontrakt walut dla obecnego modelu `Decimal(13, 2)`.
 * Dodanie waluty o innej liczbie cyfr ułamkowych wymaga zmiany modelu budżetowego.
 */
export const CURRENCY_CONTRACT_VERSION = 'currency-fraction-digits-v1';

export const SUPPORTED_CURRENCY_DEFINITIONS = Object.freeze({
  EUR: { code: 'EUR', fractionDigits: 2 },
  PLN: { code: 'PLN', fractionDigits: 2 },
} as const);

export type SupportedCurrencyCode = keyof typeof SUPPORTED_CURRENCY_DEFINITIONS;
export type SupportedCurrencyDefinition =
  (typeof SUPPORTED_CURRENCY_DEFINITIONS)[SupportedCurrencyCode];

export const SUPPORTED_CURRENCY_CODES = Object.freeze(
  Object.keys(SUPPORTED_CURRENCY_DEFINITIONS).sort((left, right) =>
    left.localeCompare(right, 'en'),
  ) as SupportedCurrencyCode[],
);

export function getSupportedCurrencyDefinition(value: unknown): SupportedCurrencyDefinition | null {
  if (typeof value !== 'string' || !Object.hasOwn(SUPPORTED_CURRENCY_DEFINITIONS, value)) {
    return null;
  }
  return SUPPORTED_CURRENCY_DEFINITIONS[value as SupportedCurrencyCode];
}

export function isSupportedCurrency(value: unknown): value is SupportedCurrencyCode {
  return getSupportedCurrencyDefinition(value) !== null;
}

export type MajorToMinorConversionResult =
  | {
      readonly ok: true;
      readonly amountMinor: number;
      readonly currency: SupportedCurrencyDefinition;
    }
  | {
      readonly ok: false;
      readonly reason: 'UNSUPPORTED_CURRENCY' | 'INVALID_PRECISION' | 'OUT_OF_SAFE_RANGE';
    };

/** Wspólny parser dla walidacji wejścia i wykonawczej konwersji major → minor. */
export function convertMajorUnitsToMinorUnits(
  value: unknown,
  currencyValue: unknown,
): MajorToMinorConversionResult {
  const currency = getSupportedCurrencyDefinition(currencyValue);
  if (currency === null) return { ok: false, reason: 'UNSUPPORTED_CURRENCY' };

  const decimal = String(value).trim();
  const match = new RegExp(`^(\\d+)(?:\\.(\\d{1,${currency.fractionDigits}}))?$`).exec(decimal);
  if (!match) return { ok: false, reason: 'INVALID_PRECISION' };

  const whole = BigInt(match[1] ?? '0');
  const fraction = BigInt((match[2] ?? '').padEnd(currency.fractionDigits, '0'));
  const scale = 10n ** BigInt(currency.fractionDigits);
  const amountMinor = Number(whole * scale + fraction);
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
    return { ok: false, reason: 'OUT_OF_SAFE_RANGE' };
  }
  return { ok: true, amountMinor, currency };
}
