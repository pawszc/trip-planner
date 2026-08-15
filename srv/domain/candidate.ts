import type { HardConstraints, Pace, SoftPreferences } from './trip-request.ts';
import type { Money, SourceSnapshot } from './money.ts';

/** Brief wykonawczy używa minor units i nie przenosi legacy floating point do silnika. */
export interface PlanningContext {
  tripRequestId: string;
  originCity: string;
  startDate: string;
  endDate: string;
  adults: number;
  totalBudgetMinor: number;
  currency: string;
  pace: Pace;
  hardConstraints: HardConstraints;
  softPreferences: SoftPreferences;
}

export interface Destination {
  code: string;
  city: string;
  countryCode: string;
}

export const TRANSPORT_MODE_VALUES = ['FLIGHT', 'TRAIN', 'BUS'] as const;
export type TransportMode = (typeof TRANSPORT_MODE_VALUES)[number];

export interface TransportLeg {
  departureAt: string;
  arrivalAt: string;
  durationMinutes: number;
  connections: number;
}

export interface TransportOption {
  id: string;
  destinationCode: string;
  mode: TransportMode;
  outbound: TransportLeg;
  return: TransportLeg;
  price: Money;
  additionalFees: Money;
  sourceSnapshot: SourceSnapshot | null;
}

export interface StayOption {
  id: string;
  destinationCode: string;
  name: string;
  checkInDate: string;
  checkOutDate: string;
  nights: number;
  price: Money;
  additionalFees: Money;
  /** Deterministyczna wartość 0–100 dostarczona wraz ze źródłem oferty. */
  centralityScore: number;
  sourceSnapshot: SourceSnapshot | null;
}

export interface Place {
  id: string;
  destinationCode: string;
  name: string;
  preferenceScores: Readonly<Record<keyof SoftPreferences, number>>;
  sourceSnapshot: SourceSnapshot | null;
}

export interface LocalCostEstimates {
  localTransport: Money;
  food: Money;
  attractions: Money;
}

export const BUDGET_CATEGORY_VALUES = [
  'TRANSPORT',
  'ACCOMMODATION',
  'LOCAL_TRANSPORT',
  'FOOD',
  'ATTRACTIONS',
  'ADDITIONAL_FEES',
  'BUFFER',
] as const;
export type BudgetCategory = (typeof BUDGET_CATEGORY_VALUES)[number];

/** Znane części kategorii zachowują klasyfikację także dla agregatów mieszanych. */
export interface BudgetCategoryAmounts {
  confirmedAmountMinor: number;
  estimatedAmountMinor: number;
}

/** Wynik kalkulatora budżetu; null oznacza brak wymaganej kwoty, a nie zero. */
export interface BudgetBreakdown {
  transport: Money;
  accommodation: Money;
  localTransport: Money;
  food: Money;
  attractions: Money;
  additionalFees: Money;
  buffer: Money;
  categoryAmounts: Readonly<Record<BudgetCategory, BudgetCategoryAmounts>>;
  budgetLimitMinor: number;
  confirmedAmountMinor: number;
  estimatedAmountMinor: number;
  unknownCategories: readonly BudgetCategory[];
  totalAmountMinor: number | null;
  costPerPersonMinor: number | null;
  remainingBudgetMinor: number | null;
}

export interface TripCandidate {
  id: string;
  destination: Destination;
  transport: TransportOption;
  stay: StayOption;
  places: readonly Place[];
  localCostEstimates: LocalCostEstimates;
  budget: BudgetBreakdown;
  effectiveTimeAtDestinationMinutes: number;
}

export const REJECTION_CODE_VALUES = [
  'BUDGET_EXCEEDED',
  'DEPARTURE_TOO_EARLY',
  'RETURN_TOO_LATE',
  'TOO_MANY_CONNECTIONS',
  'TRANSPORT_MODE_NOT_ALLOWED',
  'TRAVEL_TIME_EXCEEDED',
  'REQUIRED_PRICE_UNKNOWN',
  'SOURCE_MISSING',
  'CURRENCY_MISMATCH',
  'DUPLICATE_CANDIDATE',
  'INSUFFICIENT_TIME_AT_DESTINATION',
  'INVALID_DATES',
  'INCOMPLETE_DATA',
] as const;
export type RejectionCode = (typeof REJECTION_CODE_VALUES)[number];

export type MachineReadableValue =
  | string
  | number
  | boolean
  | null
  | readonly MachineReadableValue[]
  | { readonly [key: string]: MachineReadableValue };

export type RejectionSubject =
  { candidateId: string; optionId?: never } | { optionId: string; candidateId?: never };

interface RejectionReasonBase {
  code: RejectionCode;
  details: Readonly<Record<string, MachineReadableValue>>;
  message: string;
  expected: MachineReadableValue;
  actual: MachineReadableValue;
}

/** Jeden powód wskazuje dokładnie kandydata albo surową ofertę, nigdy oba naraz. */
export type RejectionReason = RejectionReasonBase & RejectionSubject;

/** Wszystkie komponenty są punktami 0–100 przed zastosowaniem wersjonowanych wag. */
export interface ScoreBreakdown {
  scoreVersion: string;
  budgetFit: number;
  travelTime: number;
  effectiveTimeAtDestination: number;
  accommodationLocation: number;
  dataCompleteness: number;
  priceConfidence: number;
  deterministicPreferenceFit: number;
  total: number;
  reasonCodes: readonly string[];
  reasonTexts: readonly string[];
}

export const SELECTION_ROLE_VALUES = ['BEST_OVERALL', 'MOST_CONVENIENT', 'BEST_VALUE'] as const;
export type SelectionRole = (typeof SELECTION_ROLE_VALUES)[number];

export interface RankedOption {
  rank: number;
  role: SelectionRole;
  candidate: TripCandidate;
  score: ScoreBreakdown;
}
