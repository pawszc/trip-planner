export const PACE_VALUES = ['RELAXED', 'BALANCED', 'INTENSIVE'] as const;
export type Pace = (typeof PACE_VALUES)[number];

export const TRIP_REQUEST_STATUS_VALUES = ['DRAFT', 'CONSTRAINTS_CONFIRMED'] as const;
export type TripRequestStatus = (typeof TRIP_REQUEST_STATUS_VALUES)[number];

export interface TripRequestBrief {
  originCity: string;
  startDate: string;
  endDate: string;
  adults: number;
  totalBudget: number;
  currency: string;
  pace: Pace;
}

export interface TripRequest extends TripRequestBrief {
  ID: string;
  status: TripRequestStatus;
  createdAt: string;
  modifiedAt: string;
}

export class DomainError extends Error {
  public readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'DomainError';
  }
}

export function confirmTripRequestStatus(status: TripRequestStatus): TripRequestStatus {
  if (status !== 'DRAFT') {
    throw new DomainError(
      'TRIP_REQUEST_ALREADY_CONFIRMED',
      'Ograniczenia dla tego briefu zostały już potwierdzone.',
    );
  }

  return 'CONSTRAINTS_CONFIRMED';
}
