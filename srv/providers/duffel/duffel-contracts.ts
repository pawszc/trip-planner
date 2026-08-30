export const DUFFEL_API_VERSION = 'v2';
export const DUFFEL_ADAPTER_ID = 'duffel-api-transport';
export const DUFFEL_ADAPTER_VERSION = 'duffel-api-transport-v1';
export const DUFFEL_SEARCH_POLICY_VERSION = 'duffel-search-policy-v1';
export const DUFFEL_UPSTREAM_SCHEMA_VERSION = 'duffel-offer-request-offers-v2';
export const DUFFEL_TERMS_POLICY_VERSION = 'duffel-flight-offer-display-terms-v1';
export const DUFFEL_SUPPLIER_TIMEOUT_MS = 8_000;
export const DUFFEL_MAX_DESTINATIONS_PER_SEARCH = 8;
export const DUFFEL_MAX_ADULTS_PER_SEARCH = 9;
export const DUFFEL_MAX_OFFERS_PER_DESTINATION = 6;
export const DUFFEL_MAX_CONNECTIONS_PER_SLICE = 1;
export const DUFFEL_MAX_SEGMENTS_PER_SLICE = DUFFEL_MAX_CONNECTIONS_PER_SLICE + 1;
export const DUFFEL_MAX_AMOUNT_CHARACTERS = 24;

export type DuffelEnvironment = 'TEST' | 'LIVE';

export interface DuffelLocation {
  readonly iata_code: string;
  readonly time_zone: string;
}

export interface DuffelCarrier {
  readonly id: string;
  readonly name: string;
  readonly iata_code: string | null;
}

export interface DuffelSegment {
  readonly id: string;
  readonly departing_at: string;
  readonly arriving_at: string;
  readonly duration: string;
  readonly origin: DuffelLocation;
  readonly destination: DuffelLocation;
  readonly operating_carrier: DuffelCarrier;
  readonly operating_carrier_flight_number: string;
}

export interface DuffelSlice {
  readonly id: string;
  readonly duration: string;
  readonly origin: DuffelLocation;
  readonly destination: DuffelLocation;
  readonly segments: readonly DuffelSegment[];
}

export interface DuffelAvailableService {
  readonly id: string;
  readonly type: string;
  readonly total_amount: string;
  readonly total_currency: string;
}

export interface DuffelOffer {
  readonly id: string;
  readonly expires_at: string;
  readonly live_mode: boolean;
  readonly base_amount: string;
  readonly base_currency: string;
  readonly tax_amount: string | null;
  readonly tax_currency: string | null;
  readonly total_amount: string;
  readonly total_currency: string;
  readonly slices: readonly [DuffelSlice, DuffelSlice];
  readonly available_services?: readonly DuffelAvailableService[] | undefined;
}

export interface DuffelOfferRequestResponse {
  readonly data: {
    readonly id: string;
    readonly live_mode: boolean;
    readonly offers: readonly DuffelOffer[];
  };
}
