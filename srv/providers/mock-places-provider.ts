import type { Place } from '../domain/candidate.js';
import type { PlacesProvider, PlacesSearchRequest } from './contracts.js';
import { buildReferencePlaces } from './fixtures/europe-reference-fixtures.js';

/** Offline provider backed solely by versioned request-relative fixture definitions. */
export class MockPlacesProvider implements PlacesProvider {
  public async search(request: PlacesSearchRequest): Promise<readonly Place[]> {
    return buildReferencePlaces(request);
  }
}
