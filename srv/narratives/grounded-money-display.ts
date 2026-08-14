import { DomainError } from '../domain/domain-error.ts';
import {
  CURRENCY_CONTRACT_VERSION,
  getSupportedCurrencyDefinitionForContract,
  SUPPORTED_CURRENCY_CODES,
} from '../domain/currency.ts';
import type { IntegerValue } from './grounded-option-types.ts';

export const GROUNDED_MONEY_DISPLAY_VERSION = 'grounded-money-display-v1';

function invalidMoneyDisplay(message: string): never {
  throw new DomainError('INVALID_GROUNDED_OPTION_CONTEXT', message);
}

function requireCurrency(currency: string, contractVersion: string, field: string) {
  const definition = getSupportedCurrencyDefinitionForContract(contractVersion, currency);
  if (definition === null) {
    invalidMoneyDisplay(
      `Grounded context field ${field} is not supported by currency contract ${contractVersion || '(missing)'} (${SUPPORTED_CURRENCY_CODES.join(', ')}).`,
    );
  }
  return definition;
}

function normalizeMinorUnits(value: IntegerValue, field: string): string {
  const normalized = typeof value === 'number' ? String(value) : value.trim();
  if (!/^-?\d+$/.test(normalized)) {
    invalidMoneyDisplay(`Grounded context field ${field} is not an integer minor-unit amount.`);
  }
  return normalized;
}

/**
 * Formats an integer minor-unit amount without converting it to floating point. Currency
 * precision comes from the closed local contract and never from the runtime or model.
 */
export function formatGroundedMoney(
  amountMinor: IntegerValue | null,
  currencyValue: string,
  field: string,
  currencyContractVersion = CURRENCY_CONTRACT_VERSION,
): string | null {
  const currency = requireCurrency(currencyValue, currencyContractVersion, `${field}.currency`);
  if (amountMinor === null) return null;
  const normalized = normalizeMinorUnits(amountMinor, `${field}.amountMinor`);
  const fractionDigits = currency.fractionDigits;
  const negative = normalized.startsWith('-');
  const unsigned = negative ? normalized.slice(1) : normalized;
  const padded = unsigned.padStart(fractionDigits + 1, '0');
  const whole = padded.slice(0, -fractionDigits);
  const fraction = `.${padded.slice(-fractionDigits)}`;
  const groupedWhole = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

  return `${negative ? '-' : ''}${groupedWhole}${fraction} ${currency.code}`;
}
