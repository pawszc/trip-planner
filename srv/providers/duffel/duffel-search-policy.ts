import type { Destination } from '../../domain/candidate.ts';
import type { TransportSearchRequest } from '../contracts.ts';
import { createProviderFingerprint, type ProviderJsonValue } from '../provider-fingerprint.ts';
import { DUFFEL_SEARCH_POLICY_VERSION, DUFFEL_SUPPLIER_TIMEOUT_MS } from './duffel-contracts.ts';

export const DUFFEL_ORIGIN_CATALOG_VERSION = 'duffel-origin-iata-catalog-v1';

const ORIGIN_IATA_CATALOG = Object.freeze({
  warszawa: 'WAW',
  wrocław: 'WRO',
} as const);

function normalizedCity(value: string): string {
  return value.trim().toLocaleLowerCase('pl-PL').replace(/\s+/g, ' ');
}

export function resolveDuffelOriginIata(originCity: string): string | null {
  const normalized = normalizedCity(originCity);
  return Object.hasOwn(ORIGIN_IATA_CATALOG, normalized)
    ? ORIGIN_IATA_CATALOG[normalized as keyof typeof ORIGIN_IATA_CATALOG]
    : null;
}

export function isAllowlistedDestination(destination: Destination): boolean {
  return (
    /^[A-Z]{3}$/.test(destination.code) &&
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
): readonly DuffelOfferRequestPlan[] {
  const origin = resolveDuffelOriginIata(request.originCity);
  if (origin === null) throw new TypeError('Duffel origin is not supported by the local catalog.');
  if (
    !Number.isSafeInteger(request.adults) ||
    request.adults <= 0 ||
    request.destinations.some((destination) => !isAllowlistedDestination(destination))
  ) {
    throw new TypeError('Duffel search request is outside Search Policy v1.');
  }

  const destinations = [...request.destinations].sort(
    (left, right) =>
      left.code.localeCompare(right.code, 'en') || left.city.localeCompare(right.city, 'en'),
  );
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
        originCatalogVersion: DUFFEL_ORIGIN_CATALOG_VERSION,
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
