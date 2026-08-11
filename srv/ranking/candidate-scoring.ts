import type { PlanningContext, ScoreBreakdown, TripCandidate } from '../domain/candidate.ts';
import { SOFT_PREFERENCE_KEYS, type SoftPreferences } from '../domain/trip-request.ts';
import {
  mergeCandidateEngineConfig,
  type CandidateEngineConfig,
  type CandidateEngineConfigOverride,
} from './config.ts';
import { candidateSemanticSignature } from './candidate-filter.ts';

export const SCORE_VERSION = 'candidate-score-v1';

export interface ScoredCandidate {
  candidate: TripCandidate;
  score: ScoreBreakdown;
}

function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

function rounded(value: number): number {
  return Math.round(value * 100) / 100;
}

function requestedMinutes(context: PlanningContext): number {
  const start = Date.parse(`${context.startDate}T00:00:00.000Z`);
  const end = Date.parse(`${context.endDate}T23:59:59.999Z`);
  return Number.isFinite(start) && Number.isFinite(end) && end >= start
    ? Math.floor((end - start + 1) / 60_000)
    : 0;
}

function budgetFit(candidate: TripCandidate, context: PlanningContext): number {
  const total = candidate.budget.totalAmountMinor;
  if (total === null || context.totalBudgetMinor <= 0) return 0;
  return clampScore((1 - total / context.totalBudgetMinor) * 100);
}

function travelTime(
  candidate: TripCandidate,
  context: PlanningContext,
  config: CandidateEngineConfig,
): number {
  const maximum = context.hardConstraints.maxTravelMinutes ?? config.defaultMaximumTravelMinutes;
  const longestLeg = Math.max(
    candidate.transport.outbound.durationMinutes,
    candidate.transport.return.durationMinutes,
  );
  if (maximum <= 0) return 0;
  return clampScore((1 - longestLeg / maximum) * 100);
}

function effectiveTime(candidate: TripCandidate, context: PlanningContext): number {
  const available = requestedMinutes(context);
  return available <= 0
    ? 0
    : clampScore((candidate.effectiveTimeAtDestinationMinutes / available) * 100);
}

function dataCompleteness(candidate: TripCandidate): number {
  const checks = [
    candidate.id.trim().length > 0,
    candidate.destination.code.trim().length > 0,
    candidate.transport.id.trim().length > 0,
    candidate.stay.id.trim().length > 0,
    candidate.stay.name.trim().length > 0,
    candidate.transport.sourceSnapshot !== null,
    candidate.stay.sourceSnapshot !== null,
    candidate.places.every((place) => place.sourceSnapshot !== null),
    candidate.budget.unknownCategories.length === 0,
    candidate.budget.totalAmountMinor !== null,
  ];
  return (checks.filter(Boolean).length / checks.length) * 100;
}

function priceConfidence(candidate: TripCandidate): number {
  const { confirmedAmountMinor, estimatedAmountMinor, totalAmountMinor } = candidate.budget;
  if (totalAmountMinor === null || totalAmountMinor <= 0) return 0;
  return clampScore(((confirmedAmountMinor + estimatedAmountMinor * 0.7) / totalAmountMinor) * 100);
}

function placePreference(candidate: TripCandidate, key: keyof SoftPreferences): number {
  return candidate.places.reduce(
    (best, place) => Math.max(best, clampScore(place.preferenceScores[key])),
    0,
  );
}

export function deterministicPreferenceFit(
  candidate: TripCandidate,
  context: PlanningContext,
  componentScores: { budgetFit: number; travelTime: number },
): number {
  const preferences = context.softPreferences;
  const matches: Record<keyof SoftPreferences, number> = {
    food: placePreference(candidate, 'food'),
    nature: placePreference(candidate, 'nature'),
    history: placePreference(candidate, 'history'),
    museums: placePreference(candidate, 'museums'),
    nightlife: placePreference(candidate, 'nightlife'),
    centralAccommodation: clampScore(candidate.stay.centralityScore),
    travelComfort: componentScores.travelTime,
    priceSensitivity: componentScores.budgetFit,
  };
  const keys = SOFT_PREFERENCE_KEYS;
  const totalWeight = keys.reduce((total, key) => total + preferences[key], 0);
  if (totalWeight <= 0) return 0;
  const weighted = keys.reduce((total, key) => total + preferences[key] * matches[key], 0);
  return clampScore(weighted / totalWeight);
}

const REASON_TEMPLATES = [
  ['BUDGET_FIT', 'Dopasowanie do budżetu'],
  ['TRAVEL_TIME', 'Czas podróży'],
  ['EFFECTIVE_TIME', 'Efektywny czas na miejscu'],
  ['ACCOMMODATION_LOCATION', 'Lokalizacja noclegu'],
  ['DATA_COMPLETENESS', 'Kompletność danych'],
  ['PRICE_CONFIDENCE', 'Pewność ceny'],
  ['PREFERENCE_FIT', 'Dopasowanie preferencji'],
] as const;

export function scoreCandidate(
  candidate: TripCandidate,
  context: PlanningContext,
  configOverride: CandidateEngineConfigOverride = {},
): ScoreBreakdown {
  const config = mergeCandidateEngineConfig(configOverride);
  const budget = budgetFit(candidate, context);
  const travel = travelTime(candidate, context, config);
  const components = {
    budgetFit: rounded(budget),
    travelTime: rounded(travel),
    effectiveTimeAtDestination: rounded(effectiveTime(candidate, context)),
    accommodationLocation: rounded(clampScore(candidate.stay.centralityScore)),
    dataCompleteness: rounded(dataCompleteness(candidate)),
    priceConfidence: rounded(priceConfidence(candidate)),
    deterministicPreferenceFit: rounded(
      deterministicPreferenceFit(candidate, context, { budgetFit: budget, travelTime: travel }),
    ),
  };
  const weights = config.scoringWeights;
  const total = rounded(
    (components.budgetFit * weights.budgetFit +
      components.travelTime * weights.travelTime +
      components.effectiveTimeAtDestination * weights.effectiveTimeAtDestination +
      components.accommodationLocation * weights.accommodationLocation +
      components.dataCompleteness * weights.dataCompleteness +
      components.priceConfidence * weights.priceConfidence +
      components.deterministicPreferenceFit * weights.deterministicPreferenceFit) /
      100,
  );
  const componentValues = [
    components.budgetFit,
    components.travelTime,
    components.effectiveTimeAtDestination,
    components.accommodationLocation,
    components.dataCompleteness,
    components.priceConfidence,
    components.deterministicPreferenceFit,
  ];
  return {
    scoreVersion: `${SCORE_VERSION}:${config.version}`,
    ...components,
    total: clampScore(total),
    reasonCodes: REASON_TEMPLATES.map(([code]) => code),
    reasonTexts: REASON_TEMPLATES.map(
      ([, label], index) => `${label}: ${componentValues[index]?.toFixed(2) ?? '0.00'}/100.`,
    ),
  };
}

export function compareScoredCandidates(left: ScoredCandidate, right: ScoredCandidate): number {
  const leftCost = left.candidate.budget.totalAmountMinor ?? Number.POSITIVE_INFINITY;
  const rightCost = right.candidate.budget.totalAmountMinor ?? Number.POSITIVE_INFINITY;
  return (
    right.score.total - left.score.total ||
    leftCost - rightCost ||
    left.candidate.destination.code.localeCompare(right.candidate.destination.code, 'en') ||
    candidateSemanticSignature(left.candidate).localeCompare(
      candidateSemanticSignature(right.candidate),
      'en',
    ) ||
    left.candidate.id.localeCompare(right.candidate.id, 'en')
  );
}

export function rankCandidates(
  candidates: readonly TripCandidate[],
  context: PlanningContext,
  configOverride: CandidateEngineConfigOverride = {},
): readonly ScoredCandidate[] {
  return candidates
    .map((candidate) => ({
      candidate,
      score: scoreCandidate(candidate, context, configOverride),
    }))
    .sort(compareScoredCandidates);
}
