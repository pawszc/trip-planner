import type { SourceSnapshot } from '../../domain/money.ts';
import type { ProviderTripRequest } from '../contracts.ts';
import { fixtureFetchedAt } from './fixture-date.ts';

export const MOCK_FIXTURE_VERSION = 'europe-reference-v1';

export const MOCK_PROVIDER_NAMES = {
  transport: 'MockTransportProvider',
  accommodation: 'MockAccommodationProvider',
  places: 'MockPlacesProvider',
} as const;

export function createFixtureSource(
  provider: (typeof MOCK_PROVIDER_NAMES)[keyof typeof MOCK_PROVIDER_NAMES],
  externalItemId: string,
  quote: ProviderTripRequest,
): SourceSnapshot {
  return {
    id: [
      MOCK_FIXTURE_VERSION,
      provider,
      externalItemId,
      quote.currency,
      quote.startDate,
      quote.endDate,
      quote.adults,
    ].join(':'),
    provider,
    externalItemId,
    fetchedAt: fixtureFetchedAt(quote.startDate),
    sourceUrl: 'INTERNAL_FIXTURE',
    freshnessType: 'FIXTURE',
    currency: quote.currency,
    fixtureVersion: MOCK_FIXTURE_VERSION,
  };
}
