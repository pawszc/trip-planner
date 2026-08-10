/**
 * Tempo opisuje preferowaną intensywność zwiedzania: od luźnego planu
 * do wielu aktywności dziennie. Nie steruje wydajnością aplikacji.
 */
export const PACE_VALUES = ['RELAXED', 'BALANCED', 'INTENSIVE'] as const;
export type Pace = (typeof PACE_VALUES)[number];

// Statusy tworzą małą maszynę stanów: edytowalny szkic można zatwierdzić tylko raz.
export const TRIP_REQUEST_STATUS_VALUES = ['DRAFT', 'CONSTRAINTS_CONFIRMED'] as const;
export type TripRequestStatus = (typeof TRIP_REQUEST_STATUS_VALUES)[number];

/** Pola biznesowe briefu, wspólne dla transportu, bazy danych i interfejsu. */
export interface TripRequestBrief {
  originCity: string;
  startDate: string;
  endDate: string;
  adults: number;
  totalBudget: number;
  currency: string;
  pace: Pace;
}

/** Brief zapisany w bazie wraz z identyfikatorem, statusem i znacznikami czasu CAP. */
export interface TripRequest extends TripRequestBrief {
  ID: string;
  status: TripRequestStatus;
  createdAt: string;
  modifiedAt: string;
}

/** Kontrolowany błąd reguły biznesowej; kod jest stabilny dla klientów i testów. */
export class DomainError extends Error {
  public readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'DomainError';
  }
}

/**
 * Wykonuje jedyną obecnie dozwoloną zmianę statusu.
 * Funkcja jest czysta, dlatego można ją testować bez uruchamiania CAP ani bazy.
 */
export function confirmTripRequestStatus(status: TripRequestStatus): TripRequestStatus {
  if (status !== 'DRAFT') {
    throw new DomainError(
      'TRIP_REQUEST_ALREADY_CONFIRMED',
      'Ograniczenia dla tego briefu zostały już potwierdzone.',
    );
  }

  return 'CONSTRAINTS_CONFIRMED';
}
