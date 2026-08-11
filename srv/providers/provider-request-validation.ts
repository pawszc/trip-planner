import type { Destination } from '../domain/candidate.ts';
import type {
  AccommodationSearchRequest,
  PlacesSearchRequest,
  ProviderTripRequest,
  TransportSearchRequest,
} from './contracts.ts';

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export const PROVIDER_REQUEST_ERROR_CODE_VALUES = [
  'INVALID_START_DATE',
  'INVALID_END_DATE',
  'INVALID_DATE_RANGE',
  'INVALID_ADULTS',
  'INVALID_CURRENCY',
  'INVALID_ORIGIN_CITY',
  'INVALID_DESTINATION',
  'DESTINATIONS_REQUIRED',
] as const;
export type ProviderRequestErrorCode = (typeof PROVIDER_REQUEST_ERROR_CODE_VALUES)[number];

/** Stabilny błąd wejścia providera; mock nie naprawia ani nie uzupełnia requestu. */
export class ProviderRequestValidationError extends Error {
  public readonly code: ProviderRequestErrorCode;
  public readonly field: string;

  constructor(code: ProviderRequestErrorCode, field: string, message: string) {
    super(message);
    this.name = 'ProviderRequestValidationError';
    this.code = code;
    this.field = field;
  }
}

function parseIsoCalendarDate(
  value: string,
  field: 'startDate' | 'endDate',
  code: 'INVALID_START_DATE' | 'INVALID_END_DATE',
): number {
  if (!ISO_DATE_PATTERN.test(value)) {
    throw new ProviderRequestValidationError(
      code,
      field,
      `${field} must be an ISO calendar date (YYYY-MM-DD); received: ${value}`,
    );
  }

  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new ProviderRequestValidationError(
      code,
      field,
      `${field} must identify an existing ISO calendar date; received: ${value}`,
    );
  }
  return parsed.getTime();
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null;
}

function hasNonEmptyStringField(
  value: Readonly<Record<string, unknown>>,
  field: keyof Destination,
): boolean {
  const fieldValue = value[field];
  return typeof fieldValue === 'string' && fieldValue.trim().length > 0;
}

function validateDestination(value: unknown, field: string): asserts value is Destination {
  if (
    !isRecord(value) ||
    !hasNonEmptyStringField(value, 'code') ||
    !hasNonEmptyStringField(value, 'city') ||
    !hasNonEmptyStringField(value, 'countryCode')
  ) {
    throw new ProviderRequestValidationError(
      'INVALID_DESTINATION',
      field,
      `${field} must contain non-empty code, city and countryCode fields.`,
    );
  }
}

/** Wspólne invariants są sprawdzane również wtedy, gdy provider wywoła kod spoza orkiestracji. */
export function validateProviderTripRequest(request: ProviderTripRequest): void {
  const start = parseIsoCalendarDate(request.startDate, 'startDate', 'INVALID_START_DATE');
  const end = parseIsoCalendarDate(request.endDate, 'endDate', 'INVALID_END_DATE');
  if (end <= start) {
    throw new ProviderRequestValidationError(
      'INVALID_DATE_RANGE',
      'endDate',
      `endDate must be later than startDate; received ${request.startDate}..${request.endDate}.`,
    );
  }
  if (!Number.isSafeInteger(request.adults) || request.adults <= 0) {
    throw new ProviderRequestValidationError(
      'INVALID_ADULTS',
      'adults',
      `adults must be a positive safe integer; received: ${request.adults}`,
    );
  }
  if (!/^[A-Z]{3}$/.test(request.currency)) {
    throw new ProviderRequestValidationError(
      'INVALID_CURRENCY',
      'currency',
      `currency must be an uppercase three-letter code; received: ${request.currency}`,
    );
  }
}

export function validateTransportSearchRequest(request: TransportSearchRequest): void {
  validateProviderTripRequest(request);
  if (request.originCity.trim().length === 0) {
    throw new ProviderRequestValidationError(
      'INVALID_ORIGIN_CITY',
      'originCity',
      'originCity must not be empty.',
    );
  }
  if (!Array.isArray(request.destinations) || request.destinations.length === 0) {
    throw new ProviderRequestValidationError(
      'DESTINATIONS_REQUIRED',
      'destinations',
      'At least one destination is required for a transport search.',
    );
  }
  request.destinations.forEach((destination, index) => {
    validateDestination(destination, `destinations[${index}]`);
  });
}

export function validateAccommodationSearchRequest(request: AccommodationSearchRequest): void {
  validateProviderTripRequest(request);
  validateDestination(request.destination, 'destination');
}

export function validatePlacesSearchRequest(request: PlacesSearchRequest): void {
  validateProviderTripRequest(request);
  validateDestination(request.destination, 'destination');
}
