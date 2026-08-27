import type { Destination, Place, StayOption, TransportOption } from '../domain/candidate.ts';
import type { ProviderCallOptions } from './provider-execution.ts';
import type { ProviderManifestEntry } from './provider-manifest.ts';

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
  /** Runtime adapter identity. Required for LIVE mode, including an empty result set. */
  readonly manifestEntry?: ProviderManifestEntry;
  search(
    request: TransportSearchRequest,
    options?: ProviderCallOptions,
  ): Promise<readonly TransportOption[]>;
}

export interface AccommodationProvider {
  /** Runtime adapter identity. Required for LIVE mode, including an empty result set. */
  readonly manifestEntry?: ProviderManifestEntry;
  search(
    request: AccommodationSearchRequest,
    options?: ProviderCallOptions,
  ): Promise<readonly StayOption[]>;
}

export interface PlacesProvider {
  /** Runtime adapter identity. Required for LIVE mode, including an empty result set. */
  readonly manifestEntry?: ProviderManifestEntry;
  search(request: PlacesSearchRequest, options?: ProviderCallOptions): Promise<readonly Place[]>;
}
