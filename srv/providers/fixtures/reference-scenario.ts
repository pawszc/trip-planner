import type { PlanningContext } from '../../domain/candidate.js';

/**
 * Stabilny brief integrujący wszystkie fixture providery z candidate engine.
 * Kwota 450_000 oznacza 4 500,00 PLN i nigdy nie przechodzi przez floating point.
 */
export const REFERENCE_PLANNING_CONTEXT: PlanningContext = {
  tripRequestId: 'reference-wroclaw-city-break-v1',
  originCity: 'Wrocław',
  startDate: '2026-10-10',
  endDate: '2026-10-13',
  adults: 2,
  totalBudgetMinor: 450_000,
  currency: 'PLN',
  pace: 'RELAXED',
  hardConstraints: {
    hardBudgetLimit: true,
    earliestDepartureTime: '07:00',
    latestReturnTime: '22:00',
    maxConnections: 1,
    maxTravelMinutes: 480,
    allowFlight: false,
    allowTrain: true,
    allowBus: true,
  },
  softPreferences: {
    food: 5,
    nature: 5,
    history: 3,
    museums: 2,
    nightlife: 1,
    centralAccommodation: 4,
    travelComfort: 4,
    priceSensitivity: 4,
  },
};
