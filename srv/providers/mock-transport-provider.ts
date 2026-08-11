import type { TransportOption } from '../domain/candidate.ts';
import type { TransportProvider, TransportSearchRequest } from './contracts.ts';
import { buildReferenceTransportOptions } from './fixtures/europe-reference-fixtures.ts';

/** Offline provider backed solely by versioned request-relative fixture definitions. */
export class MockTransportProvider implements TransportProvider {
  public async search(request: TransportSearchRequest): Promise<readonly TransportOption[]> {
    return buildReferenceTransportOptions(request);
  }
}
