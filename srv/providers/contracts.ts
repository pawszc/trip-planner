import type { Destination, Place, StayOption, TransportOption } from '../domain/candidate.js';

/**
 * Common, explicit trip context shared by every provider request.
 * Orchestration validates these invariants once before provider fan-out; adapters still surface
 * unexpected invalid input as a rejected Promise rather than repairing or completing it.
 */
export interface ProviderTripRequest {
  startDate: string;
  endDate: string;
  adults: number;
  currency: string;
}

/** Transport is searched once for the finite destination set chosen by orchestration. */
export interface TransportSearchRequest extends ProviderTripRequest {
  originCity: string;
  destinations: readonly Destination[];
}

/** Accommodation is queried per destination to keep provider fan-out bounded. */
export interface AccommodationSearchRequest extends ProviderTripRequest {
  destination: Destination;
}

/** Places are queried per destination and remain independent of a concrete external API schema. */
export interface PlacesSearchRequest extends ProviderTripRequest {
  destination: Destination;
}

export interface TransportProvider {
  search(request: TransportSearchRequest): Promise<readonly TransportOption[]>;
}

export interface AccommodationProvider {
  search(request: AccommodationSearchRequest): Promise<readonly StayOption[]>;
}

export interface PlacesProvider {
  search(request: PlacesSearchRequest): Promise<readonly Place[]>;
}
