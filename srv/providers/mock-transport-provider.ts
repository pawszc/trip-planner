import type { TransportOption } from '../domain/candidate.js';
import type { TransportProvider, TransportSearchRequest } from './contracts.js';
import { buildReferenceTransportOptions } from './fixtures/europe-reference-fixtures.js';

/** Offline provider backed solely by versioned request-relative fixture definitions. */
export class MockTransportProvider implements TransportProvider {
  public async search(request: TransportSearchRequest): Promise<readonly TransportOption[]> {
    return buildReferenceTransportOptions(request);
  }
}
