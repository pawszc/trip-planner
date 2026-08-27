import { createHash } from 'node:crypto';
import type { PlanningContext } from '../domain/candidate.ts';
import { convertMajorUnitsToMinorUnits, SUPPORTED_CURRENCY_CODES } from '../domain/currency.ts';
import { DomainError } from '../domain/domain-error.ts';
import type { PersistedTripRequest } from '../mapping/trip-request-mapper.ts';
import { normalizeTripRequest } from '../mapping/trip-request-mapper.ts';
import { createProviderFingerprint } from '../providers/provider-fingerprint.ts';

/**
 * Konwertuje major units na minor units przez parser dziesiętny i BigInt.
 * Dzięki temu 0,1 nie przechodzi przez arytmetykę binarnego floating point.
 */
export function majorUnitsToMinorUnits(
  value: unknown,
  currencyValue: unknown,
  currencyContractVersion?: string,
): number {
  const conversion = convertMajorUnitsToMinorUnits(value, currencyValue, currencyContractVersion);
  if (!conversion.ok && conversion.reason === 'UNSUPPORTED_CURRENCY') {
    throw new DomainError(
      'INVALID_CURRENCY',
      `Waluta nie jest obsługiwana. Dozwolone waluty: ${SUPPORTED_CURRENCY_CODES.join(', ')}.`,
    );
  }
  if (!conversion.ok && conversion.reason === 'INVALID_PRECISION') {
    throw new DomainError(
      'INVALID_TOTAL_BUDGET_PRECISION',
      'Budżet musi mieć najwyżej dwie cyfry po separatorze dziesiętnym zgodnie z kontraktem waluty.',
    );
  }
  if (!conversion.ok) {
    throw new DomainError(
      'INVALID_TOTAL_BUDGET_MINOR_UNITS',
      'Budżet przekracza bezpieczny zakres integer minor units.',
    );
  }
  return conversion.amountMinor;
}

export function createPlanningContext(tripRequest: PersistedTripRequest): PlanningContext {
  const normalized = normalizeTripRequest(tripRequest);
  return {
    tripRequestId: tripRequest.ID,
    originCity: normalized.originCity,
    startDate: normalized.startDate,
    endDate: normalized.endDate,
    adults: normalized.adults,
    totalBudgetMinor: majorUnitsToMinorUnits(tripRequest.totalBudget, normalized.currency),
    currency: normalized.currency,
    pace: normalized.pace as PlanningContext['pace'],
    hardConstraints: normalized.hardConstraints,
    softPreferences: normalized.softPreferences,
  };
}

export interface PlanningVersions {
  currencyContractVersion: string;
  offerPricingContractVersion: string;
  providerManifestVersion: string;
  providerManifestFingerprint: string;
  engineVersion: string;
  scoringVersion: string;
}

export const PLANNING_REQUEST_FINGERPRINT_VERSION = 'planning-request-fingerprint-v2';

/**
 * Zamrożone lineage historycznego fingerprintu zapisywanego przez main@1b8a852.
 * Te literały nie mogą śledzić bieżących stałych pipeline'u, bo v0 jest wyłącznie
 * kontraktem kompatybilności odczytu dla już utrwalonych runów.
 */
export const LEGACY_PLANNING_FINGERPRINT_V0_VERSIONS = Object.freeze({
  providerFixtureVersion: 'europe-reference-v1',
  engineVersion: 'candidate-engine-v1',
  scoringVersion: 'candidate-score-v1',
});

/** Lineage faktycznie utrwalane na udanym PlanningRun przez main@1b8a852. */
export const LEGACY_PLANNING_RUN_V0_LINEAGE = Object.freeze({
  providerFixtureVersion: 'europe-reference-v1',
  engineVersion: 'candidate-engine-v1',
  scoringVersion: 'candidate-score-v1:candidate-engine-v1',
});

/** Exact current-v1 fingerprint versions written before provider manifest lineage existed. */
export const LEGACY_PLANNING_FINGERPRINT_V1_VERSIONS = Object.freeze({
  currencyContractVersion: 'currency-fraction-digits-v1',
  providerFixtureVersion: 'europe-reference-v1',
  engineVersion: 'candidate-engine-v1',
  scoringVersion: 'candidate-score-v1',
});

/** Exact current-v1 persisted lineage; new nullable v2 columns must remain null on these rows. */
export const LEGACY_PLANNING_RUN_V1_LINEAGE = Object.freeze({
  currencyContractVersion: 'currency-fraction-digits-v1',
  providerFixtureVersion: 'europe-reference-v1',
  engineVersion: 'candidate-engine-v1',
  scoringVersion: 'candidate-score-v1:candidate-engine-v1',
});

/**
 * Read-only fingerprint v0 odtwarza literalny payload main@1b8a852.
 * Jest celowo osobną implementacją: v0 nie jest wariantem bieżącego generatora v1.
 */
export function createLegacyPlanningFingerprintV0(context: PlanningContext): string {
  const payload = JSON.stringify({
    tripRequestId: context.tripRequestId,
    originCity: context.originCity,
    startDate: context.startDate,
    endDate: context.endDate,
    adults: context.adults,
    totalBudgetMinor: context.totalBudgetMinor,
    currency: context.currency,
    pace: context.pace,
    hardConstraints: context.hardConstraints,
    softPreferences: context.softPreferences,
    versions: LEGACY_PLANNING_FINGERPRINT_V0_VERSIONS,
  });
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

/** Frozen read-only reproduction of the request fingerprint written by source main@ad7a909. */
export function createLegacyPlanningFingerprintV1(context: PlanningContext): string {
  const { currencyContractVersion, ...pipelineVersions } = LEGACY_PLANNING_FINGERPRINT_V1_VERSIONS;
  const payload = JSON.stringify({
    currencyContractVersion,
    tripRequestId: context.tripRequestId,
    originCity: context.originCity,
    startDate: context.startDate,
    endDate: context.endDate,
    adults: context.adults,
    totalBudgetMinor: context.totalBudgetMinor,
    currency: context.currency,
    pace: context.pace,
    hardConstraints: context.hardConstraints,
    softPreferences: context.softPreferences,
    versions: pipelineVersions,
  });
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

/** New writes bind the full confirmed input to provider-manifest lineage and contract v2. */
export function createPlanningFingerprint(
  context: PlanningContext,
  versions: PlanningVersions,
): string {
  return createProviderFingerprint({
    fingerprintVersion: PLANNING_REQUEST_FINGERPRINT_VERSION,
    currencyContractVersion: versions.currencyContractVersion,
    offerPricingContractVersion: versions.offerPricingContractVersion,
    tripRequestId: context.tripRequestId,
    originCity: context.originCity,
    startDate: context.startDate,
    endDate: context.endDate,
    adults: context.adults,
    totalBudgetMinor: context.totalBudgetMinor,
    currency: context.currency,
    pace: context.pace,
    hardConstraints: { ...context.hardConstraints },
    softPreferences: { ...context.softPreferences },
    versions: {
      providerManifestVersion: versions.providerManifestVersion,
      providerManifestFingerprint: versions.providerManifestFingerprint,
      engineVersion: versions.engineVersion,
      scoringVersion: versions.scoringVersion,
    },
  });
}
