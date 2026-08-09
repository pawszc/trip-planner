import { describe, expect, it } from 'vitest';
import { confirmTripRequestStatus, DomainError } from '../../srv/domain/trip-request.js';
import { validateTripRequest } from '../../srv/validation/trip-request-validation.js';
import { validTripRequest } from '../fixtures/trip-request.js';

describe('TripRequest domain validation', () => {
  it('accepts a valid trip request', () => {
    expect(() => validateTripRequest(validTripRequest)).not.toThrow();
  });

  it('rejects an empty origin city', () => {
    expect(() => validateTripRequest({ ...validTripRequest, originCity: '  ' })).toThrowError(
      new DomainError('ORIGIN_CITY_REQUIRED', 'Miasto rozpoczęcia jest wymagane.'),
    );
  });

  it.each([
    ['earlier', '2026-10-09'],
    ['equal', '2026-10-10'],
  ])('rejects an end date that is %s than or equal to the start date', (_case, endDate) => {
    expect(() => validateTripRequest({ ...validTripRequest, endDate })).toThrowError(
      /Data rozpoczęcia musi być wcześniejsza/,
    );
  });

  it('rejects zero adults', () => {
    expect(() => validateTripRequest({ ...validTripRequest, adults: 0 })).toThrowError(
      /Liczba dorosłych/,
    );
  });

  it.each([0, -100])('rejects a non-positive total budget (%s)', (totalBudget) => {
    expect(() => validateTripRequest({ ...validTripRequest, totalBudget })).toThrowError(
      /budżet musi być większy/,
    );
  });

  it('rejects an unsupported pace', () => {
    expect(() => validateTripRequest({ ...validTripRequest, pace: 'EXTREME' })).toThrowError(
      /tempo podróży jest niedozwolone/,
    );
  });
});

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
