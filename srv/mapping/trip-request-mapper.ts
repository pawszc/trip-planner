import {
  createDefaultHardConstraints,
  createDefaultSoftPreferences,
  type HardConstraints,
  type SoftPreferences,
  type TripRequestStatus,
} from '../domain/trip-request.ts';
import type {
  NormalizedTripRequestValidationInput,
  TripRequestValidationInput,
} from '../validation/trip-request-validation.ts';

/** Płaski kontrakt CAP/OData jest częściowy podczas PATCH i pochodzi z niezaufanego JSON. */
export interface MutableTripRequest extends Partial<TripRequestValidationInput> {
  ID?: string;
  status?: TripRequestStatus | string;
  hardConstraints_hardBudgetLimit?: unknown;
  hardConstraints_earliestDepartureTime?: unknown;
  hardConstraints_latestReturnTime?: unknown;
  hardConstraints_maxConnections?: unknown;
  hardConstraints_maxTravelMinutes?: unknown;
  hardConstraints_allowFlight?: unknown;
  hardConstraints_allowTrain?: unknown;
  hardConstraints_allowBus?: unknown;
  softPreferences_food?: unknown;
  softPreferences_nature?: unknown;
  softPreferences_history?: unknown;
  softPreferences_museums?: unknown;
  softPreferences_nightlife?: unknown;
  softPreferences_centralAccommodation?: unknown;
  softPreferences_travelComfort?: unknown;
  softPreferences_priceSensitivity?: unknown;
}

/** Pełny rekord persistence potrzebny handlerom CAP. */
export interface PersistedTripRequest extends MutableTripRequest {
  ID: string;
  status: TripRequestStatus;
}

/** Zachowuje jawne false; nie stosuje Boolean(value), które zmieniłoby tekst "false" na true. */
function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value as boolean;
}

function normalizeRequiredNumber(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  return value === null ? Number.NaN : Number(value);
}

function normalizeOptionalString(value: unknown): string | null {
  return value === undefined || value === null ? null : String(value);
}

function normalizeOptionalNumber(value: unknown): number | null {
  return value === undefined || value === null ? null : Number(value);
}

function normalizeHardConstraints(data: MutableTripRequest): HardConstraints {
  const defaults = createDefaultHardConstraints();
  return {
    hardBudgetLimit: normalizeBoolean(
      data.hardConstraints_hardBudgetLimit,
      defaults.hardBudgetLimit,
    ),
    earliestDepartureTime: normalizeOptionalString(data.hardConstraints_earliestDepartureTime),
    latestReturnTime: normalizeOptionalString(data.hardConstraints_latestReturnTime),
    maxConnections: normalizeRequiredNumber(
      data.hardConstraints_maxConnections,
      defaults.maxConnections,
    ),
    maxTravelMinutes: normalizeOptionalNumber(data.hardConstraints_maxTravelMinutes),
    allowFlight: normalizeBoolean(data.hardConstraints_allowFlight, defaults.allowFlight),
    allowTrain: normalizeBoolean(data.hardConstraints_allowTrain, defaults.allowTrain),
    allowBus: normalizeBoolean(data.hardConstraints_allowBus, defaults.allowBus),
  };
}

function normalizeSoftPreferences(data: MutableTripRequest): SoftPreferences {
  const defaults = createDefaultSoftPreferences();
  return {
    food: normalizeRequiredNumber(data.softPreferences_food, defaults.food),
    nature: normalizeRequiredNumber(data.softPreferences_nature, defaults.nature),
    history: normalizeRequiredNumber(data.softPreferences_history, defaults.history),
    museums: normalizeRequiredNumber(data.softPreferences_museums, defaults.museums),
    nightlife: normalizeRequiredNumber(data.softPreferences_nightlife, defaults.nightlife),
    centralAccommodation: normalizeRequiredNumber(
      data.softPreferences_centralAccommodation,
      defaults.centralAccommodation,
    ),
    travelComfort: normalizeRequiredNumber(
      data.softPreferences_travelComfort,
      defaults.travelComfort,
    ),
    priceSensitivity: normalizeRequiredNumber(
      data.softPreferences_priceSensitivity,
      defaults.priceSensitivity,
    ),
  };
}

/** Jawny mapper płaskiej granicy CAP/OData do strukturalnego kontraktu domenowego. */
export function normalizeTripRequest(
  data: MutableTripRequest,
): NormalizedTripRequestValidationInput {
  return {
    originCity: String(data.originCity ?? ''),
    startDate: String(data.startDate ?? ''),
    endDate: String(data.endDate ?? ''),
    adults: Number(data.adults),
    totalBudget: Number(data.totalBudget),
    currency: String(data.currency ?? ''),
    pace: String(data.pace ?? ''),
    hardConstraints: normalizeHardConstraints(data),
    softPreferences: normalizeSoftPreferences(data),
  };
}

/** Materializuje pełny płaski kontrakt persistence/OData po walidacji domenowej. */
export function materializeProfiles(
  data: MutableTripRequest,
  normalized: NormalizedTripRequestValidationInput,
): void {
  const { hardConstraints, softPreferences } = normalized;
  data.hardConstraints_hardBudgetLimit = hardConstraints.hardBudgetLimit;
  data.hardConstraints_earliestDepartureTime = hardConstraints.earliestDepartureTime;
  data.hardConstraints_latestReturnTime = hardConstraints.latestReturnTime;
  data.hardConstraints_maxConnections = hardConstraints.maxConnections;
  data.hardConstraints_maxTravelMinutes = hardConstraints.maxTravelMinutes;
  data.hardConstraints_allowFlight = hardConstraints.allowFlight;
  data.hardConstraints_allowTrain = hardConstraints.allowTrain;
  data.hardConstraints_allowBus = hardConstraints.allowBus;
  data.softPreferences_food = softPreferences.food;
  data.softPreferences_nature = softPreferences.nature;
  data.softPreferences_history = softPreferences.history;
  data.softPreferences_museums = softPreferences.museums;
  data.softPreferences_nightlife = softPreferences.nightlife;
  data.softPreferences_centralAccommodation = softPreferences.centralAccommodation;
  data.softPreferences_travelComfort = softPreferences.travelComfort;
  data.softPreferences_priceSensitivity = softPreferences.priceSensitivity;
}

/** Płaski PATCH może zostać bezpiecznie scalony płytko z pełnym rekordem. */
export function mergeTripRequest(
  current: PersistedTripRequest,
  patch: MutableTripRequest,
): MutableTripRequest {
  return { ...current, ...patch };
}
