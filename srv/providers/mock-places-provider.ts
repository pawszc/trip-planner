import type { Place } from '../domain/candidate.ts';
import type { PlacesProvider, PlacesSearchRequest } from './contracts.ts';
import type { ProviderCallOptions } from './provider-execution.ts';
import { buildReferencePlaces } from './fixtures/europe-reference-fixtures.ts';
import { MOCK_PROVIDER_MANIFEST, providerEntry } from './provider-manifest.ts';

/** Offline provider backed solely by versioned request-relative fixture definitions. */
export class MockPlacesProvider implements PlacesProvider {
  public readonly manifestEntry = providerEntry(MOCK_PROVIDER_MANIFEST, 'PLACES');

  public async search(
    request: PlacesSearchRequest,
    options?: ProviderCallOptions,
  ): Promise<readonly Place[]> {
    if (options?.signal.aborted === true) throw new Error('Provider call cancelled.');
    return buildReferencePlaces(request);
  }
}
