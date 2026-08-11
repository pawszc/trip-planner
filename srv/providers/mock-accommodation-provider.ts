import type { StayOption } from '../domain/candidate.ts';
import type { AccommodationProvider, AccommodationSearchRequest } from './contracts.ts';
import { buildReferenceStayOptions } from './fixtures/europe-reference-fixtures.ts';

/** Offline provider backed solely by versioned request-relative fixture definitions. */
export class MockAccommodationProvider implements AccommodationProvider {
  public async search(request: AccommodationSearchRequest): Promise<readonly StayOption[]> {
    return buildReferenceStayOptions(request);
  }
}
