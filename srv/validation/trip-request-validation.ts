import { DomainError, PACE_VALUES } from '../domain/trip-request.ts';
import {
  convertMajorUnitsToMinorUnits,
  isSupportedCurrency,
  SUPPORTED_CURRENCY_CODES,
} from '../domain/currency.ts';
import type {
  HardConstraints,
  Pace,
  SoftPreferences,
  TripRequestBrief,
} from '../domain/trip-request.ts';
import { validateHardConstraints } from './hard-constraints-validation.ts';
import { validateSoftPreferences } from './soft-preferences-validation.ts';
import { parseStrictIsoDate } from './strict-iso-date.ts';

// Na granicy systemu `pace` może być dowolnym tekstem; walidator dopiero zawęża go do Pace.
export interface TripRequestValidationInput extends Omit<
  TripRequestBrief,
  'pace' | 'hardConstraints' | 'softPreferences'
> {
  pace: Pace | string;
}

/** Pełny, znormalizowany brief przekazywany przez warstwę CAP do walidacji domenowej. */
export interface NormalizedTripRequestValidationInput extends TripRequestValidationInput {
  hardConstraints: HardConstraints;
  softPreferences: SoftPreferences;
}

/**
 * Centralny walidator podstawowego briefu oraz jego jawnych profili.
 * Zgłasza pierwszy DomainError, aby każda reguła miała jednoznaczny kod i komunikat.
 */
export function validateTripRequest(input: NormalizedTripRequestValidationInput): void {
  // Miasto i waluta po usunięciu białych znaków muszą zawierać rzeczywistą wartość.
  if (!input.originCity.trim()) {
    throw new DomainError('ORIGIN_CITY_REQUIRED', 'Miasto rozpoczęcia jest wymagane.');
  }

  if (parseStrictIsoDate(input.startDate) === null || parseStrictIsoDate(input.endDate) === null) {
    throw new DomainError('INVALID_TRAVEL_DATES', 'Daty podróży muszą być poprawne.');
  }

  if (input.startDate >= input.endDate) {
    throw new DomainError(
      'INVALID_DATE_RANGE',
      'Data rozpoczęcia musi być wcześniejsza niż data zakończenia.',
    );
  }

  // Liczba podróżnych musi być dodatnią liczbą całkowitą, nie tylko wartością większą od zera.
  if (!Number.isInteger(input.adults) || input.adults <= 0) {
    throw new DomainError('INVALID_ADULTS', 'Liczba dorosłych musi być większa od zera.');
  }

  if (!Number.isFinite(input.totalBudget) || input.totalBudget <= 0) {
    throw new DomainError('INVALID_TOTAL_BUDGET', 'Całkowity budżet musi być większy od zera.');
  }

  if (!isSupportedCurrency(input.currency)) {
    throw new DomainError(
      'INVALID_CURRENCY',
      `Waluta nie jest obsługiwana. Dozwolone waluty: ${SUPPORTED_CURRENCY_CODES.join(', ')}.`,
    );
  }
  const budgetConversion = convertMajorUnitsToMinorUnits(input.totalBudget, input.currency);
  if (!budgetConversion.ok) {
    throw new DomainError(
      budgetConversion.reason === 'INVALID_PRECISION'
        ? 'INVALID_TOTAL_BUDGET_PRECISION'
        : 'INVALID_TOTAL_BUDGET_MINOR_UNITS',
      'Całkowity budżet nie jest reprezentowalny w minor units zgodnie z kontraktem waluty.',
    );
  }

  // Tempo musi pochodzić z zamkniętego zbioru współdzielonego przez domenę i API.
  if (!PACE_VALUES.some((pace) => pace === input.pace)) {
    throw new DomainError('INVALID_PACE', 'Wybrane tempo podróży jest niedozwolone.');
  }

  validateHardConstraints(input.hardConstraints);
  validateSoftPreferences(input.softPreferences);
}
