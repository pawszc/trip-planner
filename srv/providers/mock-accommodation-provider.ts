import type { StayOption } from '../domain/candidate.ts';
import type { AccommodationProvider, AccommodationSearchRequest } from './contracts.ts';
import type { ProviderCallOptions } from './provider-execution.ts';
import { buildReferenceStayOptions } from './fixtures/europe-reference-fixtures.ts';
import { MOCK_PROVIDER_MANIFEST, providerEntry } from './provider-manifest.ts';

/** Offline provider backed solely by versioned request-relative fixture definitions. */
export class MockAccommodationProvider implements AccommodationProvider {
  public readonly manifestEntry = providerEntry(MOCK_PROVIDER_MANIFEST, 'ACCOMMODATION');

  public async search(
    request: AccommodationSearchRequest,
    options?: ProviderCallOptions,
  ): Promise<readonly StayOption[]> {
    if (options?.signal.aborted === true) throw new Error('Provider call cancelled.');
    return buildReferenceStayOptions(request);
  }
}
