import type { StayOption } from '../domain/candidate.js';
import type { AccommodationProvider, AccommodationSearchRequest } from './contracts.js';
import { buildReferenceStayOptions } from './fixtures/europe-reference-fixtures.js';

/** Offline provider backed solely by versioned request-relative fixture definitions. */
export class MockAccommodationProvider implements AccommodationProvider {
  public async search(request: AccommodationSearchRequest): Promise<readonly StayOption[]> {
    return buildReferenceStayOptions(request);
  }
}
