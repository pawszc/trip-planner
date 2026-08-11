import { DomainError, PACE_VALUES } from '../domain/trip-request.ts';
import type {
  HardConstraints,
  Pace,
  SoftPreferences,
  TripRequestBrief,
} from '../domain/trip-request.ts';
import { validateHardConstraints } from './hard-constraints-validation.ts';
import { validateSoftPreferences } from './soft-preferences-validation.ts';

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

/** Sprawdza format kalendarzowy YYYY-MM-DD bez zależności od lokalnej strefy czasowej. */
function isIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
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

  if (!isIsoDate(input.startDate) || !isIsoDate(input.endDate)) {
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

  if (!/^[A-Z]{3}$/.test(input.currency)) {
    throw new DomainError(
      'INVALID_CURRENCY',
      'Waluta musi być trzyliterowym kodem zapisanym wielkimi literami.',
    );
  }

  // Tempo musi pochodzić z zamkniętego zbioru współdzielonego przez domenę i API.
  if (!PACE_VALUES.some((pace) => pace === input.pace)) {
    throw new DomainError('INVALID_PACE', 'Wybrane tempo podróży jest niedozwolone.');
  }

  validateHardConstraints(input.hardConstraints);
  validateSoftPreferences(input.softPreferences);
}
