import { DomainError, PACE_VALUES } from '../domain/trip-request.ts';
import type { Pace, TripRequestBrief } from '../domain/trip-request.ts';

export interface TripRequestValidationInput extends Omit<TripRequestBrief, 'pace'> {
  pace: Pace | string;
}

function isIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

export function validateTripRequest(input: TripRequestValidationInput): void {
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

  if (!Number.isInteger(input.adults) || input.adults <= 0) {
    throw new DomainError('INVALID_ADULTS', 'Liczba dorosłych musi być większa od zera.');
  }

  if (!Number.isFinite(input.totalBudget) || input.totalBudget <= 0) {
    throw new DomainError('INVALID_TOTAL_BUDGET', 'Całkowity budżet musi być większy od zera.');
  }

  if (!input.currency.trim()) {
    throw new DomainError('CURRENCY_REQUIRED', 'Waluta jest wymagana.');
  }

  if (!PACE_VALUES.some((pace) => pace === input.pace)) {
    throw new DomainError('INVALID_PACE', 'Wybrane tempo podróży jest niedozwolone.');
  }
}
