import { DomainError } from './domain-error.ts';

export { DomainError } from './domain-error.ts';

/**
 * Tempo opisuje preferowaną intensywność zwiedzania: od luźnego planu
 * do wielu aktywności dziennie. Nie steruje wydajnością aplikacji.
 */
export const PACE_VALUES = ['RELAXED', 'BALANCED', 'INTENSIVE'] as const;
export type Pace = (typeof PACE_VALUES)[number];

// Statusy tworzą małą maszynę stanów: edytowalny szkic można zatwierdzić tylko raz.
export const TRIP_REQUEST_STATUS_VALUES = ['DRAFT', 'CONSTRAINTS_CONFIRMED'] as const;
export type TripRequestStatus = (typeof TRIP_REQUEST_STATUS_VALUES)[number];

/** Jawny profil ograniczeń, których późniejszy workflow nie może samodzielnie poluzować. */
export interface HardConstraints {
  hardBudgetLimit: boolean;
  earliestDepartureTime: string | null;
  latestReturnTime: string | null;
  maxConnections: number;
  maxTravelMinutes: number | null;
  allowFlight: boolean;
  allowTrain: boolean;
  allowBus: boolean;
}

/** Strukturalny profil wag miękkich preferencji podróży. */
export interface SoftPreferences {
  food: number;
  nature: number;
  history: number;
  museums: number;
  nightlife: number;
  centralAccommodation: number;
  travelComfort: number;
  priceSensitivity: number;
}

/** Stabilna kolejność pól pozwala walidować wszystkie wagi jedną regułą. */
export const SOFT_PREFERENCE_KEYS = [
  'food',
  'nature',
  'history',
  'museums',
  'nightlife',
  'centralAccommodation',
  'travelComfort',
  'priceSensitivity',
] as const satisfies readonly (keyof SoftPreferences)[];

/** Zwraca świeży profil, aby dane dwóch briefów nigdy nie współdzieliły mutowalnego obiektu. */
export function createDefaultHardConstraints(): HardConstraints {
  return {
    hardBudgetLimit: true,
    earliestDepartureTime: null,
    latestReturnTime: null,
    maxConnections: 1,
    maxTravelMinutes: null,
    allowFlight: true,
    allowTrain: true,
    allowBus: true,
  };
}

/** Neutralna waga 3 zachowuje obecny przepływ, gdy użytkownik nie poda preferencji. */
export function createDefaultSoftPreferences(): SoftPreferences {
  return {
    food: 3,
    nature: 3,
    history: 3,
    museums: 3,
    nightlife: 3,
    centralAccommodation: 3,
    travelComfort: 3,
    priceSensitivity: 3,
  };
}

/** Pola biznesowe briefu, wspólne dla transportu, bazy danych i interfejsu. */
export interface TripRequestBrief {
  originCity: string;
  startDate: string;
  endDate: string;
  adults: number;
  totalBudget: number;
  currency: string;
  pace: Pace;
  hardConstraints: HardConstraints;
  softPreferences: SoftPreferences;
}

/** Brief zapisany w bazie wraz z identyfikatorem, statusem i znacznikami czasu CAP. */
export interface TripRequest extends TripRequestBrief {
  ID: string;
  status: TripRequestStatus;
  createdAt: string;
  modifiedAt: string;
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
