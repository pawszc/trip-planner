import type { TransportOption } from '../domain/candidate.ts';
import type { TransportProvider, TransportSearchRequest } from './contracts.ts';
import type { ProviderCallOptions } from './provider-execution.ts';
import { buildReferenceTransportOptions } from './fixtures/europe-reference-fixtures.ts';
import { MOCK_PROVIDER_MANIFEST, providerEntry } from './provider-manifest.ts';

/** Offline provider backed solely by versioned request-relative fixture definitions. */
export class MockTransportProvider implements TransportProvider {
  public readonly manifestEntry = providerEntry(MOCK_PROVIDER_MANIFEST, 'TRANSPORT');

  public async search(
    request: TransportSearchRequest,
    options?: ProviderCallOptions,
  ): Promise<readonly TransportOption[]> {
    if (options?.signal.aborted === true) throw new Error('Provider call cancelled.');
    return buildReferenceTransportOptions(request);
  }
}
