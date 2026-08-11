import type { Place } from '../domain/candidate.ts';
import type { PlacesProvider, PlacesSearchRequest } from './contracts.ts';
import { buildReferencePlaces } from './fixtures/europe-reference-fixtures.ts';

/** Offline provider backed solely by versioned request-relative fixture definitions. */
export class MockPlacesProvider implements PlacesProvider {
  public async search(request: PlacesSearchRequest): Promise<readonly Place[]> {
    return buildReferencePlaces(request);
  }
}
