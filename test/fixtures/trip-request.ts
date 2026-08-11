import type { HardConstraints, SoftPreferences } from '../../srv/domain/trip-request.js';
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

export const customHardConstraints: HardConstraints = {
  hardBudgetLimit: false,
  earliestDepartureTime: '08:30',
  latestReturnTime: '21:15',
  maxConnections: 0,
  maxTravelMinutes: 360,
  allowFlight: false,
  allowTrain: true,
  allowBus: false,
};

export const customSoftPreferences: SoftPreferences = {
  food: 5,
  nature: 4,
  history: 2,
  museums: 1,
  nightlife: 3,
  centralAccommodation: 5,
  travelComfort: 4,
  priceSensitivity: 2,
};

/** Publiczna projekcja OData CAP spłaszcza osadzone struktury CDS do pól z prefiksem. */
export const customTripRequestODataPayload = {
  ...validTripRequest,
  hardConstraints_hardBudgetLimit: customHardConstraints.hardBudgetLimit,
  hardConstraints_earliestDepartureTime: customHardConstraints.earliestDepartureTime,
  hardConstraints_latestReturnTime: customHardConstraints.latestReturnTime,
  hardConstraints_maxConnections: customHardConstraints.maxConnections,
  hardConstraints_maxTravelMinutes: customHardConstraints.maxTravelMinutes,
  hardConstraints_allowFlight: customHardConstraints.allowFlight,
  hardConstraints_allowTrain: customHardConstraints.allowTrain,
  hardConstraints_allowBus: customHardConstraints.allowBus,
  softPreferences_food: customSoftPreferences.food,
  softPreferences_nature: customSoftPreferences.nature,
  softPreferences_history: customSoftPreferences.history,
  softPreferences_museums: customSoftPreferences.museums,
  softPreferences_nightlife: customSoftPreferences.nightlife,
  softPreferences_centralAccommodation: customSoftPreferences.centralAccommodation,
  softPreferences_travelComfort: customSoftPreferences.travelComfort,
  softPreferences_priceSensitivity: customSoftPreferences.priceSensitivity,
};
