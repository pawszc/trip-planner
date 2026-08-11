import type {
  Destination,
  PlanningContext,
  RankedOption,
  RejectionReason,
  TripCandidate,
} from '../domain/candidate.ts';
import { DomainError } from '../domain/domain-error.ts';
import { PACE_VALUES } from '../domain/trip-request.ts';
import type {
  AccommodationProvider,
  PlacesProvider,
  TransportProvider,
} from '../providers/contracts.ts';
import { buildCandidates, type CandidateBuilderResult } from '../ranking/candidate-builder.ts';
import { filterCandidates, type CandidateValidationResult } from '../ranking/candidate-filter.ts';
import { rankCandidates, type ScoredCandidate } from '../ranking/candidate-scoring.ts';
import { selectDiverseOptions, type CandidateShortage } from '../ranking/candidate-selection.ts';
import {
  mergeCandidateEngineConfig,
  type CandidateEngineConfigOverride,
} from '../ranking/config.ts';
import { validateHardConstraints } from '../validation/hard-constraints-validation.ts';
import { validateSoftPreferences } from '../validation/soft-preferences-validation.ts';

export interface CandidateEngineProviders {
  transport: TransportProvider;
  accommodation: AccommodationProvider;
  places: PlacesProvider;
}

export interface CandidateEngineInput {
  context: PlanningContext;
  destinations: readonly Destination[];
  providers: CandidateEngineProviders;
  config?: CandidateEngineConfigOverride;
}

export interface CandidateEngineCounts {
  destinations: number;
  transportOptions: number;
  stayOptions: number;
  builtCandidates: number;
  validCandidates: number;
  rejectedCandidates: number;
}

export interface CandidateEngineResult {
  configVersion: string;
  counts: CandidateEngineCounts;
  candidates: readonly TripCandidate[];
  validCandidates: readonly TripCandidate[];
  rejectedCandidates: readonly CandidateValidationResult[];
  rejectionReasons: readonly RejectionReason[];
  rankedCandidates: readonly ScoredCandidate[];
  options: readonly RankedOption[];
  shortage: CandidateShortage | null;
}

function strictDate(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value
    ? parsed
    : null;
}

/** Providerzy nie są wywoływani dla niepoprawnego briefu wykonawczego. */
export function assertPlanningContext(context: PlanningContext): void {
  const start = strictDate(context.startDate);
  const end = strictDate(context.endDate);
  const valid =
    context.tripRequestId.trim().length > 0 &&
    context.originCity.trim().length > 0 &&
    Number.isSafeInteger(context.adults) &&
    context.adults > 0 &&
    Number.isSafeInteger(context.totalBudgetMinor) &&
    context.totalBudgetMinor > 0 &&
    /^[A-Z]{3}$/.test(context.currency) &&
    start !== null &&
    end !== null &&
    end > start &&
    PACE_VALUES.some((pace) => pace === context.pace);
  if (!valid) {
    throw new DomainError(
      'INVALID_PLANNING_CONTEXT',
      'Brief wykonawczy ma niepoprawne osoby, budżet, walutę, identyfikator lub daty.',
    );
  }
  validateHardConstraints(context.hardConstraints);
  validateSoftPreferences(context.softPreferences);
}

function stableDestinations(
  destinations: readonly Destination[],
  maximum: number,
): readonly Destination[] {
  if (
    destinations.some(
      (destination) =>
        !destination.code.trim() || !destination.city.trim() || !destination.countryCode.trim(),
    )
  ) {
    throw new DomainError(
      'INVALID_DESTINATION',
      'Każda destynacja musi mieć niepusty kod, miasto i kod kraju.',
    );
  }
  const unique = new Map<string, Destination>();
  for (const destination of [...destinations].sort(
    (left, right) =>
      left.code.localeCompare(right.code, 'en') ||
      left.city.localeCompare(right.city, 'en') ||
      left.countryCode.localeCompare(right.countryCode, 'en'),
  )) {
    if (!unique.has(destination.code)) unique.set(destination.code, destination);
  }
  return [...unique.values()].slice(0, maximum);
}

/** Wykonuje ograniczony pipeline provider → build → hard filter → score → diversity. */
export async function runCandidateEngine(
  input: CandidateEngineInput,
): Promise<CandidateEngineResult> {
  assertPlanningContext(input.context);
  const config = mergeCandidateEngineConfig(input.config);
  const destinations = stableDestinations(input.destinations, config.limits.maxDestinations);
  const providerRequest = {
    startDate: input.context.startDate,
    endDate: input.context.endDate,
    adults: input.context.adults,
    currency: input.context.currency,
  };
  const transportPromise = input.providers.transport.search({
    ...providerRequest,
    originCity: input.context.originCity,
    destinations,
  });
  const stayPromises = destinations.map((destination) =>
    input.providers.accommodation.search({ ...providerRequest, destination }),
  );
  const placePromises = destinations.map((destination) =>
    input.providers.places.search({ ...providerRequest, destination }),
  );
  let providerResults: readonly [
    Awaited<typeof transportPromise>,
    Awaited<(typeof stayPromises)[number]>[],
    Awaited<(typeof placePromises)[number]>[],
  ];
  try {
    providerResults = await Promise.all([
      transportPromise,
      Promise.all(stayPromises),
      Promise.all(placePromises),
    ]);
  } catch {
    // Adapter nie może przepuścić stack trace'u ani zależnego od providera payloadu do API.
    throw new DomainError(
      'PROVIDER_SEARCH_FAILED',
      'Nie udało się pobrać danych demonstracyjnych do planowania.',
    );
  }
  const [transportOptions, stayGroups, placeGroups] = providerResults;
  const builder: CandidateBuilderResult = buildCandidates({
    context: input.context,
    destinations,
    transportOptions,
    stayOptions: stayGroups.flat(),
    places: placeGroups.flat(),
    config,
  });
  const filtered = filterCandidates(builder.candidates, input.context, config);
  const rankedCandidates = rankCandidates(filtered.validCandidates, input.context, config);
  const selected = selectDiverseOptions(rankedCandidates, config);

  return {
    configVersion: config.version,
    counts: {
      destinations: builder.destinationCount,
      transportOptions: builder.transportOptionCount,
      stayOptions: builder.stayOptionCount,
      builtCandidates: builder.candidates.length,
      validCandidates: filtered.validCandidates.length,
      rejectedCandidates: filtered.rejectedCandidates.length,
    },
    candidates: builder.candidates,
    validCandidates: filtered.validCandidates,
    rejectedCandidates: filtered.rejectedCandidates,
    rejectionReasons: filtered.rejectedCandidates.flatMap((result) => result.reasons),
    rankedCandidates,
    options: selected.options,
    shortage: selected.shortage,
  };
}
