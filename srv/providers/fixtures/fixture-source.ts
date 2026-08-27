import { SOURCE_SNAPSHOT_CONTRACT_VERSION, type SourceSnapshot } from '../../domain/money.ts';
import type {
  AccommodationSearchRequest,
  PlacesSearchRequest,
  ProviderTripRequest,
  TransportSearchRequest,
} from '../contracts.ts';
import { createProviderFingerprint, type ProviderJsonValue } from '../provider-fingerprint.ts';
import {
  createSourceSnapshotResultFingerprint,
  type SourceSnapshotResultFingerprintInput,
} from '../source-snapshot.ts';
import { fixtureFetchedAt } from './fixture-date.ts';

export const MOCK_FIXTURE_VERSION = 'europe-reference-v1';

export const MOCK_PROVIDER_NAMES = {
  transport: 'MockTransportProvider',
  accommodation: 'MockAccommodationProvider',
  places: 'MockPlacesProvider',
} as const;

export const MOCK_PROVIDER_KEYS = {
  transport: 'mock-transport',
  accommodation: 'mock-accommodation',
  places: 'mock-places',
} as const;

export const MOCK_ADAPTER_IDS = {
  transport: 'mock-transport-adapter',
  accommodation: 'mock-accommodation-adapter',
  places: 'mock-places-adapter',
} as const;

export const MOCK_ADAPTER_VERSIONS = {
  transport: 'mock-transport-adapter-v1',
  accommodation: 'mock-accommodation-adapter-v1',
  places: 'mock-places-adapter-v1',
} as const;

export const MOCK_UPSTREAM_SCHEMA_FINGERPRINT = createProviderFingerprint({
  fixtureVersion: MOCK_FIXTURE_VERSION,
  schema: 'europe-reference-fixture-schema-v1',
});

type FixtureProvider = (typeof MOCK_PROVIDER_NAMES)[keyof typeof MOCK_PROVIDER_NAMES];
type FixtureRequest =
  ProviderTripRequest | TransportSearchRequest | AccommodationSearchRequest | PlacesSearchRequest;

function providerKind(provider: FixtureProvider): keyof typeof MOCK_PROVIDER_NAMES {
  if (provider === MOCK_PROVIDER_NAMES.transport) return 'transport';
  if (provider === MOCK_PROVIDER_NAMES.accommodation) return 'accommodation';
  return 'places';
}

function queryView(quote: FixtureRequest): ProviderJsonValue {
  const base: Record<string, ProviderJsonValue> = {
    startDate: quote.startDate,
    endDate: quote.endDate,
    adults: quote.adults,
    currency: quote.currency,
  };
  if ('originCity' in quote) {
    base.originCity = quote.originCity;
    base.destinations = [...quote.destinations]
      .map((destination) => ({
        code: destination.code,
        city: destination.city,
        countryCode: destination.countryCode,
      }))
      .sort((left, right) =>
        `${left.code}|${left.city}|${left.countryCode}`.localeCompare(
          `${right.code}|${right.city}|${right.countryCode}`,
          'en',
        ),
      );
  } else if ('destination' in quote) {
    base.destination = {
      code: quote.destination.code,
      city: quote.destination.city,
      countryCode: quote.destination.countryCode,
    };
  }
  return base;
}

export function createFixtureSource(
  provider: FixtureProvider,
  externalItemId: string,
  quote: FixtureRequest,
  normalizedResult: ProviderJsonValue = { externalItemId },
): SourceSnapshot {
  const kind = providerKind(provider);
  const queryFingerprint = createProviderFingerprint(queryView(quote));
  const source: SourceSnapshotResultFingerprintInput = {
    contractVersion: SOURCE_SNAPSHOT_CONTRACT_VERSION,
    id: [
      MOCK_FIXTURE_VERSION,
      provider,
      externalItemId,
      quote.currency,
      quote.startDate,
      quote.endDate,
      quote.adults,
    ].join(':'),
    sourceType: 'FIXTURE',
    provider,
    adapterVersion: MOCK_ADAPTER_VERSIONS[kind],
    providerVersion: MOCK_FIXTURE_VERSION,
    upstreamApiVersion: null,
    upstreamSchemaFingerprint: MOCK_UPSTREAM_SCHEMA_FINGERPRINT,
    queryFingerprint,
    externalItemId,
    fetchedAt: fixtureFetchedAt(quote.startDate),
    expiresAt: null,
    sourceUrl: 'INTERNAL_FIXTURE',
    attribution: 'Trip Planner internal reference fixture',
    freshnessType: 'FIXTURE',
    currency: quote.currency,
    fixtureVersion: MOCK_FIXTURE_VERSION,
    termsPolicyVersion: 'internal-fixture-terms-v1',
  };
  return {
    ...source,
    resultFingerprint: createSourceSnapshotResultFingerprint(source, normalizedResult),
  };
}
