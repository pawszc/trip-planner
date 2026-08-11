import { describe, expect, it } from 'vitest';
import {
  confirmTripRequestStatus,
  createDefaultHardConstraints,
  createDefaultSoftPreferences,
  DomainError,
} from '../../srv/domain/trip-request.js';
import { validateTripRequest } from '../../srv/validation/trip-request-validation.js';
import type { NormalizedTripRequestValidationInput } from '../../srv/validation/trip-request-validation.js';
import { validTripRequest } from '../fixtures/trip-request.js';

const validFullTripRequest: NormalizedTripRequestValidationInput = {
  ...validTripRequest,
  hardConstraints: createDefaultHardConstraints(),
  softPreferences: createDefaultSoftPreferences(),
};

// Testy jednostkowe wywołują czystą domenę bez serwera CAP, HTTP i bazy danych.
describe('TripRequest domain validation', () => {
  it('accepts a valid trip request', () => {
    expect(() => validateTripRequest(validFullTripRequest)).not.toThrow();
  });

  it('rejects an empty origin city', () => {
    expect(() => validateTripRequest({ ...validFullTripRequest, originCity: '  ' })).toThrowError(
      new DomainError('ORIGIN_CITY_REQUIRED', 'Miasto rozpoczęcia jest wymagane.'),
    );
  });

  it.each([
    ['earlier', '2026-10-09'],
    ['equal', '2026-10-10'],
  ])('rejects an end date that is %s than or equal to the start date', (_case, endDate) => {
    expect(() => validateTripRequest({ ...validFullTripRequest, endDate })).toThrowError(
      /Data rozpoczęcia musi być wcześniejsza/,
    );
  });

  it('rejects zero adults', () => {
    expect(() => validateTripRequest({ ...validFullTripRequest, adults: 0 })).toThrowError(
      /Liczba dorosłych/,
    );
  });

  it.each([0, -100])('rejects a non-positive total budget (%s)', (totalBudget) => {
    expect(() => validateTripRequest({ ...validFullTripRequest, totalBudget })).toThrowError(
      /budżet musi być większy/,
    );
  });

  it.each(['pln', 'PL', 'PLNN'])('rejects an invalid currency code (%s)', (currency) => {
    expect(() => validateTripRequest({ ...validFullTripRequest, currency })).toThrowError(
      /trzyliterowym kodem/,
    );
  });

  it('rejects an unsupported pace', () => {
    expect(() => validateTripRequest({ ...validFullTripRequest, pace: 'EXTREME' })).toThrowError(
      /tempo podróży jest niedozwolone/,
    );
  });

  it('validates the nested hard constraints profile', () => {
    expect(() =>
      validateTripRequest({
        ...validFullTripRequest,
        hardConstraints: {
          ...validFullTripRequest.hardConstraints,
          allowFlight: false,
          allowTrain: false,
          allowBus: false,
        },
      }),
    ).toThrowError(/Co najmniej jeden środek transportu/);
  });

  it('validates the nested soft preferences profile', () => {
    expect(() =>
      validateTripRequest({
        ...validFullTripRequest,
        softPreferences: { ...validFullTripRequest.softPreferences, food: 0 },
      }),
    ).toThrowError(/Waga preferencji food/);
  });
});

// Przejście statusu testujemy osobno, ponieważ stan briefu jest niezależną regułą domenową.
describe('TripRequest status transition', () => {
  it('confirms a draft', () => {
    expect(confirmTripRequestStatus('DRAFT')).toBe('CONSTRAINTS_CONFIRMED');
  });

  it('rejects repeated confirmation', () => {
    expect(() => confirmTripRequestStatus('CONSTRAINTS_CONFIRMED')).toThrowError(
      /zostały już potwierdzone/,
    );
  });
});
