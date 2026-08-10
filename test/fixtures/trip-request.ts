import type { TripRequestValidationInput } from '../../srv/validation/trip-request-validation.js';

// Jeden poprawny brief jest bazą testów; konkretne przypadki nadpisują tylko badane pole.
export const validTripRequest: TripRequestValidationInput = {
  originCity: 'Warszawa',
  startDate: '2026-10-10',
  endDate: '2026-10-13',
  adults: 2,
  totalBudget: 3500,
  currency: 'PLN',
  pace: 'BALANCED',
};
