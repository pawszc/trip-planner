import type { TripRequestValidationInput } from '../../srv/validation/trip-request-validation.js';

export const validTripRequest: TripRequestValidationInput = {
  originCity: 'Warszawa',
  startDate: '2026-10-10',
  endDate: '2026-10-13',
  adults: 2,
  totalBudget: 3500,
  currency: 'PLN',
  pace: 'BALANCED',
};
