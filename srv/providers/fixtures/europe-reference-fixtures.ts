import type {
  Destination,
  Place,
  StayOption,
  TransportLeg,
  TransportMode,
  TransportOption,
} from '../../domain/candidate.ts';
import { createMoney, type KnownPriceType, unknownMoney } from '../../domain/money.ts';
import type { SoftPreferences } from '../../domain/trip-request.ts';
import type {
  AccommodationSearchRequest,
  PlacesSearchRequest,
  TransportSearchRequest,
} from '../contracts.ts';
import {
  validateAccommodationSearchRequest,
  validatePlacesSearchRequest,
  validateTransportSearchRequest,
} from '../provider-request-validation.ts';
import { addFixtureDays, fixtureInstant, fixtureNights } from './fixture-date.ts';
import { createFixtureSource, MOCK_PROVIDER_NAMES } from './fixture-source.ts';

/** Finite destination catalogue for the Wrocław offline reference scenario. */
export const REFERENCE_DESTINATIONS = Object.freeze([
  Object.freeze({ code: 'PRG', city: 'Prague', countryCode: 'CZ' }),
  Object.freeze({ code: 'VIE', city: 'Vienna', countryCode: 'AT' }),
  Object.freeze({ code: 'BER', city: 'Berlin', countryCode: 'DE' }),
  Object.freeze({ code: 'BUD', city: 'Budapest', countryCode: 'HU' }),
  Object.freeze({ code: 'SZG', city: 'Salzburg', countryCode: 'AT' }),
  Object.freeze({ code: 'DRS', city: 'Dresden', countryCode: 'DE' }),
  Object.freeze({ code: 'BTS', city: 'Bratislava', countryCode: 'SK' }),
  Object.freeze({ code: 'KRK', city: 'Kraków', countryCode: 'PL' }),
]) satisfies readonly Destination[];

type DateAnchor = 'START' | 'END';

interface RelativeInstant {
  anchor: DateAnchor;
  dayOffset?: number;
  time: string;
}

interface RelativeLeg {
  departure: RelativeInstant;
  arrival: RelativeInstant;
  durationMinutes: number;
  connections: number;
}

interface TransportDefinition {
  id: string;
  externalItemId: string;
  destinationCode: string;
  mode: TransportMode;
  outbound: RelativeLeg;
  return: RelativeLeg;
  amountPerAdultMinor: number | null;
  additionalFeesMinor: number;
  priceType: KnownPriceType;
  currency?: 'MISMATCH';
  missingSource?: boolean;
}

interface StayDefinition {
  id: string;
  externalItemId: string;
  destinationCode: string;
  name: string;
  nightlyAmountMinor: number;
  additionalFeesMinor: number;
  centralityScore: number;
  priceType: KnownPriceType;
}

interface PlaceDefinition {
  id: string;
  externalItemId: string;
  destinationCode: string;
  name: string;
  preferenceScores: Readonly<Record<keyof SoftPreferences, number>>;
}

const TRANSPORT_DEFINITIONS: readonly TransportDefinition[] = [
  {
    id: 'transport-prg-train-balanced',
    externalItemId: 'WRO-PRG-TRAIN-101',
    destinationCode: 'PRG',
    mode: 'TRAIN',
    outbound: {
      departure: { anchor: 'START', time: '08:00' },
      arrival: { anchor: 'START', time: '12:00' },
      durationMinutes: 240,
      connections: 0,
    },
    return: {
      departure: { anchor: 'END', time: '16:30' },
      arrival: { anchor: 'END', time: '20:30' },
      durationMinutes: 240,
      connections: 0,
    },
    amountPerAdultMinor: 32_000,
    additionalFeesMinor: 4_000,
    priceType: 'LIVE_PRICE',
  },
  // A different fixture record intentionally describes the exact same journey.
  {
    id: 'transport-prg-train-semantic-duplicate',
    externalItemId: 'WRO-PRG-TRAIN-101-DUP',
    destinationCode: 'PRG',
    mode: 'TRAIN',
    outbound: {
      departure: { anchor: 'START', time: '08:00' },
      arrival: { anchor: 'START', time: '12:00' },
      durationMinutes: 240,
      connections: 0,
    },
    return: {
      departure: { anchor: 'END', time: '16:30' },
      arrival: { anchor: 'END', time: '20:30' },
      durationMinutes: 240,
      connections: 0,
    },
    amountPerAdultMinor: 32_000,
    additionalFeesMinor: 4_000,
    priceType: 'LIVE_PRICE',
  },
  // Arrival before departure is a typed but deliberately invalid external fact.
  {
    id: 'transport-prg-invalid-dates',
    externalItemId: 'WRO-PRG-TRAIN-BAD-DATE',
    destinationCode: 'PRG',
    mode: 'TRAIN',
    outbound: {
      departure: { anchor: 'START', time: '15:00' },
      arrival: { anchor: 'START', time: '14:00' },
      durationMinutes: 60,
      connections: 0,
    },
    return: {
      departure: { anchor: 'END', time: '16:00' },
      arrival: { anchor: 'END', time: '20:00' },
      durationMinutes: 240,
      connections: 0,
    },
    amountPerAdultMinor: 25_000,
    additionalFeesMinor: 0,
    priceType: 'FIXED_PRICE',
  },
  {
    id: 'transport-vie-train-balanced',
    externalItemId: 'WRO-VIE-TRAIN-201',
    destinationCode: 'VIE',
    mode: 'TRAIN',
    outbound: {
      departure: { anchor: 'START', time: '08:15' },
      arrival: { anchor: 'START', time: '13:30' },
      durationMinutes: 315,
      connections: 1,
    },
    return: {
      departure: { anchor: 'END', time: '15:30' },
      arrival: { anchor: 'END', time: '20:45' },
      durationMinutes: 315,
      connections: 1,
    },
    amountPerAdultMinor: 42_000,
    additionalFeesMinor: 2_000,
    priceType: 'LIVE_PRICE',
  },
  {
    id: 'transport-vie-bus-late-return',
    externalItemId: 'WRO-VIE-BUS-LATE',
    destinationCode: 'VIE',
    mode: 'BUS',
    outbound: {
      departure: { anchor: 'START', time: '09:00' },
      arrival: { anchor: 'START', time: '15:00' },
      durationMinutes: 360,
      connections: 0,
    },
    return: {
      departure: { anchor: 'END', time: '18:00' },
      arrival: { anchor: 'END', time: '23:45' },
      durationMinutes: 345,
      connections: 0,
    },
    amountPerAdultMinor: 30_000,
    additionalFeesMinor: 2_000,
    priceType: 'FIXED_PRICE',
  },
  {
    id: 'transport-vie-train-many-connections',
    externalItemId: 'WRO-VIE-TRAIN-CONNECTIONS',
    destinationCode: 'VIE',
    mode: 'TRAIN',
    outbound: {
      departure: { anchor: 'START', time: '08:30' },
      arrival: { anchor: 'START', time: '14:00' },
      durationMinutes: 330,
      connections: 3,
    },
    return: {
      departure: { anchor: 'END', time: '15:00' },
      arrival: { anchor: 'END', time: '20:30' },
      durationMinutes: 330,
      connections: 2,
    },
    amountPerAdultMinor: 25_000,
    additionalFeesMinor: 1_000,
    priceType: 'FIXED_PRICE',
  },
  {
    id: 'transport-ber-train-comfort',
    externalItemId: 'WRO-BER-TRAIN-301',
    destinationCode: 'BER',
    mode: 'TRAIN',
    outbound: {
      departure: { anchor: 'START', time: '08:30' },
      arrival: { anchor: 'START', time: '14:00' },
      durationMinutes: 330,
      connections: 1,
    },
    return: {
      departure: { anchor: 'END', time: '15:00' },
      arrival: { anchor: 'END', time: '20:30' },
      durationMinutes: 330,
      connections: 1,
    },
    amountPerAdultMinor: 38_000,
    additionalFeesMinor: 3_000,
    priceType: 'LIVE_PRICE',
  },
  // Empty id is retained so deterministic validation can emit INCOMPLETE_DATA.
  {
    id: '',
    externalItemId: 'WRO-BER-TRAIN-INCOMPLETE',
    destinationCode: 'BER',
    mode: 'TRAIN',
    outbound: {
      departure: { anchor: 'START', time: '09:00' },
      arrival: { anchor: 'START', time: '14:30' },
      durationMinutes: 330,
      connections: 1,
    },
    return: {
      departure: { anchor: 'END', time: '14:30' },
      arrival: { anchor: 'END', time: '20:00' },
      durationMinutes: 330,
      connections: 1,
    },
    amountPerAdultMinor: 33_000,
    additionalFeesMinor: 3_000,
    priceType: 'FIXED_PRICE',
  },
  {
    id: 'transport-bud-train-value',
    externalItemId: 'WRO-BUD-TRAIN-401',
    destinationCode: 'BUD',
    mode: 'TRAIN',
    outbound: {
      departure: { anchor: 'START', time: '07:30' },
      arrival: { anchor: 'START', time: '14:00' },
      durationMinutes: 390,
      connections: 1,
    },
    return: {
      departure: { anchor: 'END', time: '14:30' },
      arrival: { anchor: 'END', time: '21:00' },
      durationMinutes: 390,
      connections: 1,
    },
    amountPerAdultMinor: 36_000,
    additionalFeesMinor: 2_000,
    priceType: 'FIXED_PRICE',
  },
  {
    id: 'transport-bud-flight-disallowed',
    externalItemId: 'WRO-BUD-FLIGHT-402',
    destinationCode: 'BUD',
    mode: 'FLIGHT',
    outbound: {
      departure: { anchor: 'START', time: '10:00' },
      arrival: { anchor: 'START', time: '11:20' },
      durationMinutes: 80,
      connections: 0,
    },
    return: {
      departure: { anchor: 'END', time: '17:00' },
      arrival: { anchor: 'END', time: '18:20' },
      durationMinutes: 80,
      connections: 0,
    },
    amountPerAdultMinor: 50_000,
    additionalFeesMinor: 12_000,
    priceType: 'LIVE_PRICE',
  },
  {
    id: 'transport-szg-bus-too-long',
    externalItemId: 'WRO-SZG-BUS-LONG',
    destinationCode: 'SZG',
    mode: 'BUS',
    outbound: {
      departure: { anchor: 'START', time: '07:00' },
      arrival: { anchor: 'START', time: '19:00' },
      durationMinutes: 720,
      connections: 1,
    },
    return: {
      departure: { anchor: 'END', time: '07:00' },
      arrival: { anchor: 'END', time: '19:00' },
      durationMinutes: 720,
      connections: 1,
    },
    amountPerAdultMinor: 24_000,
    additionalFeesMinor: 1_000,
    priceType: 'FIXED_PRICE',
  },
  {
    id: 'transport-drs-train-missing-source',
    externalItemId: 'WRO-DRS-TRAIN-NO-SOURCE',
    destinationCode: 'DRS',
    mode: 'TRAIN',
    outbound: {
      departure: { anchor: 'START', time: '09:00' },
      arrival: { anchor: 'START', time: '12:30' },
      durationMinutes: 210,
      connections: 0,
    },
    return: {
      departure: { anchor: 'END', time: '16:00' },
      arrival: { anchor: 'END', time: '19:30' },
      durationMinutes: 210,
      connections: 0,
    },
    amountPerAdultMinor: 30_000,
    additionalFeesMinor: 0,
    priceType: 'FIXED_PRICE',
    missingSource: true,
  },
  {
    id: 'transport-bts-bus-unknown-price',
    externalItemId: 'WRO-BTS-BUS-UNKNOWN',
    destinationCode: 'BTS',
    mode: 'BUS',
    outbound: {
      departure: { anchor: 'START', time: '08:00' },
      arrival: { anchor: 'START', time: '14:30' },
      durationMinutes: 390,
      connections: 0,
    },
    return: {
      departure: { anchor: 'END', time: '14:00' },
      arrival: { anchor: 'END', time: '20:30' },
      durationMinutes: 390,
      connections: 0,
    },
    amountPerAdultMinor: null,
    additionalFeesMinor: 2_000,
    priceType: 'FIXED_PRICE',
  },
  {
    id: 'transport-krk-train-eur-mismatch',
    externalItemId: 'WRO-KRK-TRAIN-EUR',
    destinationCode: 'KRK',
    mode: 'TRAIN',
    outbound: {
      departure: { anchor: 'START', time: '08:00' },
      arrival: { anchor: 'START', time: '11:30' },
      durationMinutes: 210,
      connections: 0,
    },
    return: {
      departure: { anchor: 'END', time: '17:00' },
      arrival: { anchor: 'END', time: '20:30' },
      durationMinutes: 210,
      connections: 0,
    },
    amountPerAdultMinor: 7_500,
    additionalFeesMinor: 500,
    priceType: 'FIXED_PRICE',
    currency: 'MISMATCH',
  },
  {
    id: 'transport-prg-bus-too-early',
    externalItemId: 'WRO-PRG-BUS-EARLY',
    destinationCode: 'PRG',
    mode: 'BUS',
    outbound: {
      departure: { anchor: 'START', time: '05:15' },
      arrival: { anchor: 'START', time: '09:45' },
      durationMinutes: 270,
      connections: 0,
    },
    return: {
      departure: { anchor: 'END', time: '16:00' },
      arrival: { anchor: 'END', time: '20:30' },
      durationMinutes: 270,
      connections: 0,
    },
    amountPerAdultMinor: 22_000,
    additionalFeesMinor: 1_000,
    priceType: 'FIXED_PRICE',
  },
  {
    id: 'transport-vie-train-insufficient-time',
    externalItemId: 'WRO-VIE-TRAIN-SHORT-STAY',
    destinationCode: 'VIE',
    mode: 'TRAIN',
    outbound: {
      departure: { anchor: 'END', time: '08:00' },
      arrival: { anchor: 'END', time: '13:00' },
      durationMinutes: 300,
      connections: 1,
    },
    return: {
      departure: { anchor: 'END', time: '15:00' },
      arrival: { anchor: 'END', time: '20:00' },
      durationMinutes: 300,
      connections: 1,
    },
    amountPerAdultMinor: 34_000,
    additionalFeesMinor: 2_000,
    priceType: 'FIXED_PRICE',
  },
];

const STAY_DEFINITIONS: readonly StayDefinition[] = [
  {
    id: 'stay-prg-riverside',
    externalItemId: 'PRG-STAY-101',
    destinationCode: 'PRG',
    name: 'Riverside Residence',
    nightlyAmountMinor: 32_000,
    additionalFeesMinor: 12_000,
    centralityScore: 91,
    priceType: 'LIVE_PRICE',
  },
  {
    id: 'stay-prg-garden',
    externalItemId: 'PRG-STAY-102',
    destinationCode: 'PRG',
    name: 'Garden Rooms',
    nightlyAmountMinor: 26_000,
    additionalFeesMinor: 7_000,
    centralityScore: 70,
    priceType: 'FIXED_PRICE',
  },
  // The price is intentionally above the complete reference-trip hard budget.
  {
    id: 'stay-prg-palace-over-budget',
    externalItemId: 'PRG-STAY-EXPENSIVE',
    destinationCode: 'PRG',
    name: 'Old Town Palace',
    nightlyAmountMinor: 170_000,
    additionalFeesMinor: 25_000,
    centralityScore: 99,
    priceType: 'LIVE_PRICE',
  },
  {
    id: 'stay-vie-ring',
    externalItemId: 'VIE-STAY-201',
    destinationCode: 'VIE',
    name: 'Ring Apartments',
    nightlyAmountMinor: 36_000,
    additionalFeesMinor: 10_000,
    centralityScore: 94,
    priceType: 'LIVE_PRICE',
  },
  {
    id: 'stay-vie-green',
    externalItemId: 'VIE-STAY-202',
    destinationCode: 'VIE',
    name: 'Green Courtyard Hotel',
    nightlyAmountMinor: 28_000,
    additionalFeesMinor: 8_000,
    centralityScore: 76,
    priceType: 'FIXED_PRICE',
  },
  {
    id: 'stay-ber-mitte',
    externalItemId: 'BER-STAY-301',
    destinationCode: 'BER',
    name: 'Mitte Studio',
    nightlyAmountMinor: 33_000,
    additionalFeesMinor: 9_000,
    centralityScore: 90,
    priceType: 'LIVE_PRICE',
  },
  {
    id: 'stay-bud-danube',
    externalItemId: 'BUD-STAY-401',
    destinationCode: 'BUD',
    name: 'Danube Guesthouse',
    nightlyAmountMinor: 24_000,
    additionalFeesMinor: 6_000,
    centralityScore: 87,
    priceType: 'FIXED_PRICE',
  },
  {
    id: 'stay-szg-garden',
    externalItemId: 'SZG-STAY-501',
    destinationCode: 'SZG',
    name: 'Salzach Garden Hotel',
    nightlyAmountMinor: 30_000,
    additionalFeesMinor: 7_000,
    centralityScore: 82,
    priceType: 'FIXED_PRICE',
  },
  {
    id: 'stay-drs-altstadt',
    externalItemId: 'DRS-STAY-601',
    destinationCode: 'DRS',
    name: 'Altstadt Rooms',
    nightlyAmountMinor: 25_000,
    additionalFeesMinor: 5_000,
    centralityScore: 88,
    priceType: 'FIXED_PRICE',
  },
  {
    id: 'stay-bts-old-town',
    externalItemId: 'BTS-STAY-701',
    destinationCode: 'BTS',
    name: 'Old Town Loft',
    nightlyAmountMinor: 23_000,
    additionalFeesMinor: 5_000,
    centralityScore: 92,
    priceType: 'FIXED_PRICE',
  },
  {
    id: 'stay-krk-kazimierz',
    externalItemId: 'KRK-STAY-801',
    destinationCode: 'KRK',
    name: 'Kazimierz House',
    nightlyAmountMinor: 22_000,
    additionalFeesMinor: 5_000,
    centralityScore: 86,
    priceType: 'FIXED_PRICE',
  },
];

function preferenceScores(
  food: number,
  nature: number,
  history: number,
  museums: number,
  nightlife: number,
): Readonly<Record<keyof SoftPreferences, number>> {
  return {
    food,
    nature,
    history,
    museums,
    nightlife,
    centralAccommodation: 0,
    travelComfort: 0,
    priceSensitivity: 0,
  };
}

const PLACE_DEFINITIONS: readonly PlaceDefinition[] = [
  {
    id: 'place-prg-food-market',
    externalItemId: 'PRG-PLACE-FOOD',
    destinationCode: 'PRG',
    name: 'Náplavka Food Market',
    preferenceScores: preferenceScores(96, 55, 45, 15, 35),
  },
  {
    id: 'place-prg-divoka-sarka',
    externalItemId: 'PRG-PLACE-NATURE',
    destinationCode: 'PRG',
    name: 'Divoká Šárka',
    preferenceScores: preferenceScores(25, 96, 35, 5, 5),
  },
  {
    id: 'place-vie-naschmarkt',
    externalItemId: 'VIE-PLACE-FOOD',
    destinationCode: 'VIE',
    name: 'Naschmarkt',
    preferenceScores: preferenceScores(94, 25, 55, 20, 25),
  },
  {
    id: 'place-vie-wienerwald',
    externalItemId: 'VIE-PLACE-NATURE',
    destinationCode: 'VIE',
    name: 'Wienerwald Trails',
    preferenceScores: preferenceScores(20, 94, 30, 5, 5),
  },
  {
    id: 'place-ber-tiergarten',
    externalItemId: 'BER-PLACE-NATURE',
    destinationCode: 'BER',
    name: 'Tiergarten',
    preferenceScores: preferenceScores(30, 90, 45, 10, 15),
  },
  {
    id: 'place-ber-markthalle',
    externalItemId: 'BER-PLACE-FOOD',
    destinationCode: 'BER',
    name: 'Markthalle Neun',
    preferenceScores: preferenceScores(92, 20, 40, 10, 45),
  },
  {
    id: 'place-bud-great-market',
    externalItemId: 'BUD-PLACE-FOOD',
    destinationCode: 'BUD',
    name: 'Great Market Hall',
    preferenceScores: preferenceScores(91, 15, 65, 10, 20),
  },
  {
    id: 'place-bud-buda-hills',
    externalItemId: 'BUD-PLACE-NATURE',
    destinationCode: 'BUD',
    name: 'Buda Hills',
    preferenceScores: preferenceScores(20, 92, 45, 5, 5),
  },
  {
    id: 'place-szg-monchsberg',
    externalItemId: 'SZG-PLACE-NATURE',
    destinationCode: 'SZG',
    name: 'Mönchsberg Trail',
    preferenceScores: preferenceScores(35, 94, 55, 10, 5),
  },
  {
    id: 'place-drs-neustadt',
    externalItemId: 'DRS-PLACE-FOOD',
    destinationCode: 'DRS',
    name: 'Neustadt Food Quarter',
    preferenceScores: preferenceScores(85, 30, 45, 15, 55),
  },
  {
    id: 'place-bts-devin',
    externalItemId: 'BTS-PLACE-NATURE',
    destinationCode: 'BTS',
    name: 'Devín Riverside',
    preferenceScores: preferenceScores(35, 88, 70, 10, 5),
  },
  {
    id: 'place-krk-stary-kleparz',
    externalItemId: 'KRK-PLACE-FOOD',
    destinationCode: 'KRK',
    name: 'Stary Kleparz',
    preferenceScores: preferenceScores(93, 20, 55, 10, 20),
  },
];

function requestDate(request: TransportSearchRequest, instant: RelativeInstant): string {
  const anchorDate = instant.anchor === 'START' ? request.startDate : request.endDate;
  return addFixtureDays(anchorDate, instant.dayOffset ?? 0);
}

function buildLeg(request: TransportSearchRequest, leg: RelativeLeg): TransportLeg {
  return {
    departureAt: fixtureInstant(requestDate(request, leg.departure), leg.departure.time),
    arrivalAt: fixtureInstant(requestDate(request, leg.arrival), leg.arrival.time),
    durationMinutes: leg.durationMinutes,
    connections: leg.connections,
  };
}

function mismatchCurrency(currency: string): string {
  return currency === 'EUR' ? 'PLN' : 'EUR';
}

function buildTransportOption(
  request: TransportSearchRequest,
  definition: TransportDefinition,
): TransportOption {
  const currency =
    definition.currency === 'MISMATCH' ? mismatchCurrency(request.currency) : request.currency;
  const sourceSnapshot = definition.missingSource
    ? null
    : createFixtureSource(MOCK_PROVIDER_NAMES.transport, definition.externalItemId, {
        ...request,
        currency,
      });
  const price =
    definition.amountPerAdultMinor === null
      ? unknownMoney(currency, sourceSnapshot)
      : createMoney(
          definition.amountPerAdultMinor * request.adults,
          currency,
          definition.priceType,
          sourceSnapshot,
        );

  return {
    id: definition.id,
    destinationCode: definition.destinationCode,
    mode: definition.mode,
    outbound: buildLeg(request, definition.outbound),
    return: buildLeg(request, definition.return),
    price,
    additionalFees: createMoney(
      definition.additionalFeesMinor,
      currency,
      'FIXED_PRICE',
      sourceSnapshot,
    ),
    sourceSnapshot,
  };
}

export function buildReferenceTransportOptions(
  request: TransportSearchRequest,
): readonly TransportOption[] {
  validateTransportSearchRequest(request);
  if (request.originCity.trim().toLocaleLowerCase('pl-PL') !== 'wrocław') {
    return [];
  }

  const requestedCodes = new Set(request.destinations.map((destination) => destination.code));
  return TRANSPORT_DEFINITIONS.filter((definition) =>
    requestedCodes.has(definition.destinationCode),
  ).map((definition) => buildTransportOption(request, definition));
}

function buildStayOption(
  request: AccommodationSearchRequest,
  definition: StayDefinition,
): StayOption {
  const nights = fixtureNights(request.startDate, request.endDate);
  const sourceSnapshot = createFixtureSource(
    MOCK_PROVIDER_NAMES.accommodation,
    definition.externalItemId,
    request,
  );

  return {
    id: definition.id,
    destinationCode: definition.destinationCode,
    name: definition.name,
    checkInDate: request.startDate,
    checkOutDate: request.endDate,
    nights,
    price: createMoney(
      definition.nightlyAmountMinor * nights,
      request.currency,
      definition.priceType,
      sourceSnapshot,
    ),
    additionalFees: createMoney(
      definition.additionalFeesMinor,
      request.currency,
      'FIXED_PRICE',
      sourceSnapshot,
    ),
    centralityScore: definition.centralityScore,
    sourceSnapshot,
  };
}

export function buildReferenceStayOptions(
  request: AccommodationSearchRequest,
): readonly StayOption[] {
  validateAccommodationSearchRequest(request);
  return STAY_DEFINITIONS.filter(
    (definition) => definition.destinationCode === request.destination.code,
  ).map((definition) => buildStayOption(request, definition));
}

function buildPlace(request: PlacesSearchRequest, definition: PlaceDefinition): Place {
  const sourceSnapshot = createFixtureSource(
    MOCK_PROVIDER_NAMES.places,
    definition.externalItemId,
    request,
  );

  return {
    id: definition.id,
    destinationCode: definition.destinationCode,
    name: definition.name,
    preferenceScores: { ...definition.preferenceScores },
    sourceSnapshot,
  };
}

export function buildReferencePlaces(request: PlacesSearchRequest): readonly Place[] {
  validatePlacesSearchRequest(request);
  return PLACE_DEFINITIONS.filter(
    (definition) => definition.destinationCode === request.destination.code,
  ).map((definition) => buildPlace(request, definition));
}
