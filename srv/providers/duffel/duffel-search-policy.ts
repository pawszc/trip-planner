import type { Destination } from '../../domain/candidate.ts';
import type { TransportSearchRequest } from '../contracts.ts';
import { createProviderFingerprint, type ProviderJsonValue } from '../provider-fingerprint.ts';
import { validateTransportSearchRequest } from '../provider-request-validation.ts';
import {
  DUFFEL_MAX_ADULTS_PER_SEARCH,
  DUFFEL_MAX_DESTINATIONS_PER_SEARCH,
  DUFFEL_MAX_OFFERS_PER_DESTINATION,
  DUFFEL_SEARCH_POLICY_VERSION,
  DUFFEL_SUPPLIER_TIMEOUT_MS,
} from './duffel-contracts.ts';

export const DUFFEL_ORIGIN_CATALOG_VERSION = 'duffel-origin-iata-catalog-v1';
export const DUFFEL_DESTINATION_IATA_CATALOG_VERSION = 'duffel-destination-iata-catalog-v1';

const DESTINATION_IATA_CATALOG = Object.freeze({
  BER: 'DE',
  BTS: 'SK',
  BUD: 'HU',
  DRS: 'DE',
  KRK: 'PL',
  PRG: 'CZ',
  SZG: 'AT',
  VIE: 'AT',
} as const);

function normalizedCity(value: string): string {
  return value.trim().toLocaleLowerCase('pl-PL').replace(/\s+/g, ' ');
}

export interface DuffelOriginCatalog {
  readonly version: string;
  readonly cityToIata: Readonly<Record<string, string>>;
}

export function createDuffelOriginCatalog(input: DuffelOriginCatalog): DuffelOriginCatalog {
  const inputKeys = Object.keys(input).sort((left, right) => left.localeCompare(right, 'en'));
  if (
    inputKeys.length !== 2 ||
    inputKeys[0] !== 'cityToIata' ||
    inputKeys[1] !== 'version' ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(input.version) ||
    typeof input.cityToIata !== 'object' ||
    input.cityToIata === null ||
    Array.isArray(input.cityToIata)
  ) {
    throw new TypeError('Duffel origin catalog has invalid closed metadata.');
  }

  const normalizedEntries = new Map<string, string>();
  for (const [city, iataCode] of Object.entries(input.cityToIata)) {
    const normalized = normalizedCity(city);
    if (
      normalized.length === 0 ||
      normalized.length > 80 ||
      [...normalized].some((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint <= 31 || (codePoint >= 127 && codePoint <= 159);
      }) ||
      !/^[A-Z]{3}$/.test(iataCode) ||
      normalizedEntries.has(normalized)
    ) {
      throw new TypeError('Duffel origin catalog contains an invalid or duplicate mapping.');
    }
    normalizedEntries.set(normalized, iataCode);
  }
  if (normalizedEntries.size < 1 || normalizedEntries.size > 16) {
    throw new TypeError('Duffel origin catalog is outside its bounded size.');
  }

  return Object.freeze({
    version: input.version,
    cityToIata: Object.freeze(
      Object.fromEntries(
        [...normalizedEntries.entries()].sort(([left], [right]) => left.localeCompare(right, 'pl')),
      ),
    ),
  });
}

export const DEFAULT_DUFFEL_ORIGIN_CATALOG = createDuffelOriginCatalog({
  version: DUFFEL_ORIGIN_CATALOG_VERSION,
  cityToIata: {
    Warszawa: 'WAW',
    Wrocław: 'WRO',
  },
});

export function createDuffelSearchPolicyIdentity(originCatalog: DuffelOriginCatalog): string {
  const catalog = createDuffelOriginCatalog(originCatalog);
  const policyFingerprint = createProviderFingerprint({
    policyVersion: DUFFEL_SEARCH_POLICY_VERSION,
    supplierTimeoutMs: DUFFEL_SUPPLIER_TIMEOUT_MS,
    maximumAdults: DUFFEL_MAX_ADULTS_PER_SEARCH,
    maximumDestinations: DUFFEL_MAX_DESTINATIONS_PER_SEARCH,
    maximumOffersPerDestination: DUFFEL_MAX_OFFERS_PER_DESTINATION,
    originCatalog: {
      version: catalog.version,
      cityToIata: { ...catalog.cityToIata },
    },
    destinationCatalog: {
      version: DUFFEL_DESTINATION_IATA_CATALOG_VERSION,
      countryByIata: { ...DESTINATION_IATA_CATALOG },
    },
  });
  return `${DUFFEL_SEARCH_POLICY_VERSION}:${policyFingerprint}`;
}

function resolveOriginFromCatalog(
  originCity: string,
  originCatalog: DuffelOriginCatalog,
): string | null {
  const normalized = normalizedCity(originCity);
  return Object.hasOwn(originCatalog.cityToIata, normalized)
    ? (originCatalog.cityToIata[normalized] ?? null)
    : null;
}

export function resolveDuffelOriginIata(
  originCity: string,
  originCatalog: DuffelOriginCatalog,
): string | null {
  return resolveOriginFromCatalog(originCity, createDuffelOriginCatalog(originCatalog));
}

export function isAllowlistedDestination(destination: Destination): boolean {
  return (
    /^[A-Z]{3}$/.test(destination.code) &&
    Object.hasOwn(DESTINATION_IATA_CATALOG, destination.code) &&
    DESTINATION_IATA_CATALOG[destination.code as keyof typeof DESTINATION_IATA_CATALOG] ===
      destination.countryCode &&
    destination.city.trim().length > 0 &&
    /^[A-Z]{2}$/.test(destination.countryCode)
  );
}

export interface DuffelOfferRequestPlan {
  readonly destination: Destination;
  readonly path: string;
  readonly body: ProviderJsonValue;
  readonly queryFingerprint: string;
}

export function buildDuffelOfferRequestPlans(
  request: TransportSearchRequest,
  originCatalog: DuffelOriginCatalog,
): readonly DuffelOfferRequestPlan[] {
  validateTransportSearchRequest(request);
  const catalog = createDuffelOriginCatalog(originCatalog);
  const origin = resolveOriginFromCatalog(request.originCity, catalog);
  if (origin === null) throw new TypeError('Duffel origin is not supported by the local catalog.');
  if (
    request.adults > DUFFEL_MAX_ADULTS_PER_SEARCH ||
    request.destinations.length > DUFFEL_MAX_DESTINATIONS_PER_SEARCH ||
    request.destinations.some((destination) => !isAllowlistedDestination(destination))
  ) {
    throw new TypeError('Duffel search request is outside Search Policy v1.');
  }

  const destinationsByCode = new Map<string, Destination>();
  for (const destination of [...request.destinations].sort(
    (left, right) =>
      left.code.localeCompare(right.code, 'en') ||
      left.city.localeCompare(right.city, 'en') ||
      left.countryCode.localeCompare(right.countryCode, 'en'),
  )) {
    if (!destinationsByCode.has(destination.code)) {
      destinationsByCode.set(destination.code, destination);
    }
  }
  const destinations = [...destinationsByCode.values()];
  return Object.freeze(
    destinations.map((destination) => {
      const body: ProviderJsonValue = {
        data: {
          cabin_class: 'economy',
          include_split_ticket: false,
          max_connections: 1,
          passengers: Array.from({ length: request.adults }, () => ({ type: 'adult' })),
          slices: [
            {
              origin,
              destination: destination.code,
              departure_date: request.startDate,
            },
            {
              origin: destination.code,
              destination: origin,
              departure_date: request.endDate,
            },
          ],
        },
      };
      const queryView: ProviderJsonValue = {
        policyVersion: DUFFEL_SEARCH_POLICY_VERSION,
        policyIdentity: createDuffelSearchPolicyIdentity(catalog),
        originCatalogVersion: catalog.version,
        destinationCatalogVersion: DUFFEL_DESTINATION_IATA_CATALOG_VERSION,
        maximumDestinations: DUFFEL_MAX_DESTINATIONS_PER_SEARCH,
        supplierTimeoutMs: DUFFEL_SUPPLIER_TIMEOUT_MS,
        destinationCode: destination.code,
        request: body,
      };
      return Object.freeze({
        destination,
        path: `/air/offer_requests?return_offers=true&supplier_timeout=${DUFFEL_SUPPLIER_TIMEOUT_MS}&view=offers`,
        body,
        queryFingerprint: createProviderFingerprint(queryView),
      });
    }),
  );
}
