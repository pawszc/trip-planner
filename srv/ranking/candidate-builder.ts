import type {
  Destination,
  Place,
  PlanningContext,
  StayOption,
  TransportOption,
  TripCandidate,
} from '../domain/candidate.js';
import { calculateBudgetBreakdown, estimateLocalCosts } from './budget.js';
import { mergeCandidateEngineConfig, type CandidateEngineConfigOverride } from './config.js';

export interface CandidateBuilderInput {
  context: PlanningContext;
  destinations: readonly Destination[];
  transportOptions: readonly TransportOption[];
  stayOptions: readonly StayOption[];
  places: readonly Place[];
  config?: CandidateEngineConfigOverride;
}

export interface CandidateBuilderResult {
  candidates: readonly TripCandidate[];
  destinationCount: number;
  transportOptionCount: number;
  stayOptionCount: number;
}

function stableBy<T>(items: readonly T[], key: (item: T) => string): readonly T[] {
  return [...items].sort((left, right) => key(left).localeCompare(key(right), 'en'));
}

function effectiveMinutes(transport: TransportOption): number {
  const arrival = Date.parse(transport.outbound.arrivalAt);
  const departure = Date.parse(transport.return.departureAt);
  if (!Number.isFinite(arrival) || !Number.isFinite(departure) || departure < arrival) {
    return 0;
  }
  return Math.floor((departure - arrival) / 60_000);
}

export function buildCandidates(input: CandidateBuilderInput): CandidateBuilderResult {
  const config = mergeCandidateEngineConfig(input.config);
  const destinationsByCode = new Map<string, Destination>();
  for (const destination of stableBy(
    input.destinations,
    (item) => `${item.code}|${item.city}|${item.countryCode}`,
  )) {
    if (!destinationsByCode.has(destination.code)) {
      destinationsByCode.set(destination.code, destination);
    }
  }
  const destinations = [...destinationsByCode.values()].slice(0, config.limits.maxDestinations);
  const localCostEstimates = estimateLocalCosts(input.context);
  const candidates: TripCandidate[] = [];
  let transportOptionCount = 0;
  let stayOptionCount = 0;

  for (const destination of destinations) {
    const transports = stableBy(
      input.transportOptions.filter((option) => option.destinationCode === destination.code),
      (option) => option.id,
    ).slice(0, config.limits.maxTransportOptionsPerDestination);
    const stays = stableBy(
      input.stayOptions.filter((option) => option.destinationCode === destination.code),
      (option) => option.id,
    ).slice(0, config.limits.maxStayOptionsPerDestination);
    const destinationPlaces = stableBy(
      input.places.filter((place) => place.destinationCode === destination.code),
      (place) => place.id,
    ).slice(0, config.limits.maxPlacesPerDestination);
    transportOptionCount += transports.length;
    stayOptionCount += stays.length;

    let destinationCandidates = 0;
    for (const transport of transports) {
      for (const stay of stays) {
        if (destinationCandidates >= config.limits.maxCandidatesPerDestination) {
          break;
        }
        const candidateBase = {
          id: `${destination.code}::${transport.id}::${stay.id}`,
          destination,
          transport,
          stay,
          places: destinationPlaces,
          localCostEstimates,
          effectiveTimeAtDestinationMinutes: effectiveMinutes(transport),
        };
        candidates.push({
          ...candidateBase,
          budget: calculateBudgetBreakdown(input.context, candidateBase),
        });
        destinationCandidates += 1;
      }
    }
  }

  return {
    candidates,
    destinationCount: destinations.length,
    transportOptionCount,
    stayOptionCount,
  };
}
