import {
  SELECTION_ROLE_VALUES,
  type RankedOption,
  type SelectionRole,
} from '../domain/candidate.js';
import { candidateSemanticSignature } from './candidate-filter.js';
import type { ScoredCandidate } from './candidate-scoring.js';
import { mergeCandidateEngineConfig, type CandidateEngineConfigOverride } from './config.js';

export interface CandidateShortage {
  code: 'INSUFFICIENT_VALID_CANDIDATES';
  required: number;
  available: number;
  missing: number;
  message: string;
}

export interface CandidateSelectionResult {
  options: readonly RankedOption[];
  shortage: CandidateShortage | null;
}

function roleScore(item: ScoredCandidate, role: SelectionRole): number {
  if (role === 'BEST_OVERALL') return item.score.total;
  if (role === 'MOST_CONVENIENT') {
    return (
      item.score.travelTime * 0.4 +
      item.score.effectiveTimeAtDestination * 0.35 +
      item.score.accommodationLocation * 0.25
    );
  }
  return item.score.budgetFit * 0.65 + item.score.priceConfidence * 0.35;
}

function orderedForRole(items: readonly ScoredCandidate[], role: SelectionRole): ScoredCandidate[] {
  return [...items].sort(
    (left, right) =>
      roleScore(right, role) - roleScore(left, role) ||
      right.score.total - left.score.total ||
      (left.candidate.budget.totalAmountMinor ?? Number.POSITIVE_INFINITY) -
        (right.candidate.budget.totalAmountMinor ?? Number.POSITIVE_INFINITY) ||
      left.candidate.id.localeCompare(right.candidate.id, 'en'),
  );
}

/** Wybiera maksymalnie trzy role bez luzowania filtrów i preferuje różne cele. */
export function selectDiverseOptions(
  rankedCandidates: readonly ScoredCandidate[],
  configOverride: CandidateEngineConfigOverride = {},
): CandidateSelectionResult {
  const config = mergeCandidateEngineConfig(configOverride);
  const roles = SELECTION_ROLE_VALUES.slice(0, Math.min(config.selectionCount, 3));
  const selected: RankedOption[] = [];
  const selectedIds = new Set<string>();
  const destinations = new Set<string>();
  const signatures = new Set<string>();

  for (const role of roles) {
    const available = orderedForRole(rankedCandidates, role).filter(
      (item) =>
        !selectedIds.has(item.candidate.id) &&
        !signatures.has(candidateSemanticSignature(item.candidate)),
    );
    const choice =
      available.find(
        (item) =>
          !destinations.has(item.candidate.destination.code) &&
          !signatures.has(candidateSemanticSignature(item.candidate)),
      ) ?? available[0];
    if (!choice) break;

    selectedIds.add(choice.candidate.id);
    destinations.add(choice.candidate.destination.code);
    signatures.add(candidateSemanticSignature(choice.candidate));
    selected.push({ rank: selected.length + 1, role, ...choice });
  }

  const required = roles.length;
  const available = selected.length;
  return {
    options: selected,
    shortage:
      available < required
        ? {
            code: 'INSUFFICIENT_VALID_CANDIDATES',
            required,
            available,
            missing: required - available,
            message: `Dostępne warianty: ${available} z wymaganych ${required}; ograniczenia nie zostały poluzowane.`,
          }
        : null,
  };
}
