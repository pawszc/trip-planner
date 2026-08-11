import { DomainError } from '../domain/domain-error.ts';

export interface CandidateBuilderLimits {
  maxDestinations: number;
  maxTransportOptionsPerDestination: number;
  maxStayOptionsPerDestination: number;
  maxPlacesPerDestination: number;
  maxCandidatesPerDestination: number;
}

export interface CandidateScoringWeights {
  budgetFit: 20;
  travelTime: 15;
  effectiveTimeAtDestination: 15;
  accommodationLocation: 15;
  dataCompleteness: 10;
  priceConfidence: 10;
  deterministicPreferenceFit: 15;
}

export interface CandidateEngineConfig {
  version: string;
  limits: CandidateBuilderLimits;
  minimumEffectiveTimeAtDestinationMinutes: number;
  defaultMaximumTravelMinutes: number;
  selectionCount: number;
  scoringWeights: CandidateScoringWeights;
}

export type CandidateEngineConfigOverride = Omit<Partial<CandidateEngineConfig>, 'limits'> & {
  limits?: Partial<CandidateBuilderLimits>;
};

export const CANDIDATE_SCORING_WEIGHTS: CandidateScoringWeights = {
  budgetFit: 20,
  travelTime: 15,
  effectiveTimeAtDestination: 15,
  accommodationLocation: 15,
  dataCompleteness: 10,
  priceConfidence: 10,
  deterministicPreferenceFit: 15,
};

export const DEFAULT_CANDIDATE_ENGINE_CONFIG: CandidateEngineConfig = {
  version: 'candidate-engine-v1',
  limits: {
    maxDestinations: 12,
    maxTransportOptionsPerDestination: 6,
    maxStayOptionsPerDestination: 6,
    maxPlacesPerDestination: 20,
    maxCandidatesPerDestination: 24,
  },
  minimumEffectiveTimeAtDestinationMinutes: 24 * 60,
  defaultMaximumTravelMinutes: 12 * 60,
  selectionCount: 3,
  scoringWeights: CANDIDATE_SCORING_WEIGHTS,
};

export function mergeCandidateEngineConfig(
  override: CandidateEngineConfigOverride = {},
): CandidateEngineConfig {
  const config: CandidateEngineConfig = {
    ...DEFAULT_CANDIDATE_ENGINE_CONFIG,
    ...override,
    limits: {
      ...DEFAULT_CANDIDATE_ENGINE_CONFIG.limits,
      ...override.limits,
    },
    selectionCount: DEFAULT_CANDIDATE_ENGINE_CONFIG.selectionCount,
    scoringWeights: CANDIDATE_SCORING_WEIGHTS,
  };
  const limitsAreValid = Object.values(config.limits).every(
    (value) => Number.isSafeInteger(value) && value >= 0,
  );
  if (
    !limitsAreValid ||
    !Number.isSafeInteger(config.minimumEffectiveTimeAtDestinationMinutes) ||
    config.minimumEffectiveTimeAtDestinationMinutes < 0 ||
    !Number.isSafeInteger(config.defaultMaximumTravelMinutes) ||
    config.defaultMaximumTravelMinutes <= 0 ||
    !config.version.trim()
  ) {
    throw new DomainError(
      'INVALID_CANDIDATE_ENGINE_CONFIG',
      'Limity candidate engine muszą być nieujemnymi bezpiecznymi liczbami całkowitymi.',
    );
  }
  return config;
}
