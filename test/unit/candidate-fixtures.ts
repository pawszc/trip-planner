import type {
  Destination,
  Place,
  PlanningContext,
  StayOption,
  TransportOption,
  TripCandidate,
} from '../../srv/domain/candidate.js';
import { createMoney, type SourceSnapshot } from '../../srv/domain/money.js';
import { buildCandidates } from '../../srv/ranking/candidate-builder.js';

export const candidateContext: PlanningContext = {
  tripRequestId: 'candidate-test-trip',
  originCity: 'Wrocław',
  startDate: '2026-10-10',
  endDate: '2026-10-13',
  adults: 2,
  totalBudgetMinor: 450_000,
  currency: 'PLN',
  pace: 'BALANCED',
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
    nature: 4,
    history: 3,
    museums: 2,
    nightlife: 1,
    centralAccommodation: 4,
    travelComfort: 4,
    priceSensitivity: 4,
  },
};

export const candidateDestination: Destination = {
  code: 'PRG',
  city: 'Prague',
  countryCode: 'CZ',
};

export function candidateSource(id: string, currency = 'PLN'): SourceSnapshot {
  return {
    id: `source-${id}`,
    provider: 'TEST_FIXTURE',
    externalItemId: id,
    fetchedAt: '2026-01-01T00:00:00.000Z',
    sourceUrl: `internal://test/${id}`,
    freshnessType: 'FIXTURE',
    currency,
    fixtureVersion: 'candidate-test-v1',
  };
}

export function candidateTransport(id = 'transport-prg'): TransportOption {
  const source = candidateSource(id);
  return {
    id,
    destinationCode: 'PRG',
    mode: 'TRAIN',
    outbound: {
      departureAt: '2026-10-10T08:00:00.000Z',
      arrivalAt: '2026-10-10T12:00:00.000Z',
      durationMinutes: 240,
      connections: 0,
    },
    return: {
      departureAt: '2026-10-13T16:00:00.000Z',
      arrivalAt: '2026-10-13T20:00:00.000Z',
      durationMinutes: 240,
      connections: 0,
    },
    price: createMoney(64_000, 'PLN', 'LIVE_PRICE', source),
    additionalFees: createMoney(4_000, 'PLN', 'FIXED_PRICE', source),
    sourceSnapshot: source,
  };
}

export function candidateStay(id = 'stay-prg', name = 'Central Test Hotel'): StayOption {
  const source = candidateSource(id);
  return {
    id,
    destinationCode: 'PRG',
    name,
    checkInDate: '2026-10-10',
    checkOutDate: '2026-10-13',
    nights: 3,
    price: createMoney(90_000, 'PLN', 'FIXED_PRICE', source),
    additionalFees: createMoney(6_000, 'PLN', 'FIXED_PRICE', source),
    centralityScore: 90,
    sourceSnapshot: source,
  };
}

export function candidatePlace(id = 'place-prg'): Place {
  return {
    id,
    destinationCode: 'PRG',
    name: 'Test Market and Park',
    preferenceScores: {
      food: 95,
      nature: 80,
      history: 60,
      museums: 40,
      nightlife: 20,
      centralAccommodation: 0,
      travelComfort: 0,
      priceSensitivity: 0,
    },
    sourceSnapshot: candidateSource(id),
  };
}

export function candidateFixture(context = candidateContext): TripCandidate {
  const result = buildCandidates({
    context,
    destinations: [candidateDestination],
    transportOptions: [candidateTransport()],
    stayOptions: [candidateStay()],
    places: [candidatePlace()],
  });
  const candidate = result.candidates[0];
  if (!candidate) throw new Error('Candidate fixture was not built.');
  return candidate;
}
