import type {
  Destination,
  Place,
  PlanningContext,
  StayOption,
  TransportOption,
  TripCandidate,
} from '../../srv/domain/candidate.js';
import {
  SOURCE_SNAPSHOT_CONTRACT_VERSION,
  addMinorUnits,
  createMoney,
  type SourceSnapshot,
} from '../../srv/domain/money.js';
import {
  OFFER_PRICING_CONTRACT_VERSION,
  knownEmptyChargeCollection,
} from '../../srv/domain/offer-pricing.js';
import { createProviderFingerprint } from '../../srv/providers/provider-fingerprint.js';
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
  const queryFingerprint = createProviderFingerprint({
    fixture: 'candidate-test-v1',
    id,
    currency,
  });
  return {
    contractVersion: SOURCE_SNAPSHOT_CONTRACT_VERSION,
    id: `source-${id}`,
    sourceType: 'FIXTURE',
    provider: 'TEST_FIXTURE',
    adapterVersion: 'candidate-test-adapter-v1',
    providerVersion: 'candidate-test-v1',
    upstreamApiVersion: null,
    upstreamSchemaFingerprint: null,
    queryFingerprint,
    resultFingerprint: createProviderFingerprint({ queryFingerprint, id }),
    externalItemId: id,
    fetchedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: null,
    sourceUrl: 'INTERNAL_FIXTURE',
    freshnessType: 'FIXTURE',
    currency,
    fixtureVersion: 'candidate-test-v1',
  };
}

export function candidateTransport(id = 'transport-prg'): TransportOption {
  const source = candidateSource(id);
  const price = createMoney(64_000, 'PLN', 'LIVE_PRICE', source);
  const additionalFees = createMoney(4_000, 'PLN', 'FIXED_PRICE', source);
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
    price,
    additionalFees,
    pricing: {
      contractVersion: OFFER_PRICING_CONTRACT_VERSION,
      mandatoryTotal: createMoney(
        addMinorUnits(price.amountMinor, additionalFees.amountMinor),
        'PLN',
        'LIVE_PRICE',
        source,
      ),
      conditionalCharges: knownEmptyChargeCollection(),
      optionalAncillaries: knownEmptyChargeCollection(),
    },
    sourceSnapshot: source,
  };
}

export function candidateStay(id = 'stay-prg', name = 'Central Test Hotel'): StayOption {
  const source = candidateSource(id);
  const price = createMoney(90_000, 'PLN', 'FIXED_PRICE', source);
  const additionalFees = createMoney(6_000, 'PLN', 'FIXED_PRICE', source);
  return {
    id,
    destinationCode: 'PRG',
    name,
    checkInDate: '2026-10-10',
    checkOutDate: '2026-10-13',
    nights: 3,
    price,
    additionalFees,
    pricing: {
      contractVersion: OFFER_PRICING_CONTRACT_VERSION,
      mandatoryTotal: createMoney(
        addMinorUnits(price.amountMinor, additionalFees.amountMinor),
        'PLN',
        'FIXED_PRICE',
        source,
      ),
      conditionalCharges: knownEmptyChargeCollection(),
      optionalAncillaries: knownEmptyChargeCollection(),
    },
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
