import { DomainError } from '../domain/domain-error.ts';
import type { IntegerValue } from './grounded-option-types.ts';

export const GROUNDED_MONEY_DISPLAY_VERSION = 'grounded-money-display-v1';

function invalidMoneyDisplay(message: string): never {
  throw new DomainError('INVALID_GROUNDED_OPTION_CONTEXT', message);
}

function normalizeCurrency(currency: string, field: string): string {
  const normalized = currency.trim();
  if (!/^[A-Z]{3}$/.test(normalized)) {
    invalidMoneyDisplay(`Grounded context field ${field} is not an uppercase currency code.`);
  }
  return normalized;
}

function normalizeMinorUnits(value: IntegerValue, field: string): string {
  const normalized = typeof value === 'number' ? String(value) : value.trim();
  if (!/^-?\d+$/.test(normalized)) {
    invalidMoneyDisplay(`Grounded context field ${field} is not an integer minor-unit amount.`);
  }
  return normalized;
}

function currencyFractionDigits(currency: string, field: string): number {
  try {
    const options = new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      currencyDisplay: 'code',
      useGrouping: false,
    }).resolvedOptions();
    const maximumFractionDigits = options.maximumFractionDigits;
    if (
      typeof maximumFractionDigits !== 'number' ||
      options.minimumFractionDigits !== maximumFractionDigits ||
      !Number.isSafeInteger(maximumFractionDigits) ||
      maximumFractionDigits < 0
    ) {
      invalidMoneyDisplay(`Grounded context field ${field} has ambiguous currency precision.`);
    }
    return maximumFractionDigits;
  } catch (error) {
    if (error instanceof DomainError) throw error;
    invalidMoneyDisplay(`Grounded context field ${field} has unsupported currency precision.`);
  }
}

/**
 * Formats an integer minor-unit amount without converting it to floating point. Currency
 * precision comes from the local runtime's ISO currency data and never from the model.
 */
export function formatGroundedMoney(
  amountMinor: IntegerValue | null,
  currencyValue: string,
  field: string,
): string | null {
  if (amountMinor === null) return null;

  const currency = normalizeCurrency(currencyValue, `${field}.currency`);
  const normalized = normalizeMinorUnits(amountMinor, `${field}.amountMinor`);
  const fractionDigits = currencyFractionDigits(currency, `${field}.currency`);
  const negative = normalized.startsWith('-');
  const unsigned = negative ? normalized.slice(1) : normalized;
  const padded = unsigned.padStart(fractionDigits + 1, '0');
  const whole = fractionDigits === 0 ? padded : padded.slice(0, -fractionDigits);
  const fraction = fractionDigits === 0 ? '' : `.${padded.slice(-fractionDigits)}`;
  const groupedWhole = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

  return `${negative ? '-' : ''}${groupedWhole}${fraction} ${currency}`;
}
