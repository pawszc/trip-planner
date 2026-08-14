import { createHash } from 'node:crypto';
import type { PlanningContext } from '../domain/candidate.ts';
import { convertMajorUnitsToMinorUnits, SUPPORTED_CURRENCY_CODES } from '../domain/currency.ts';
import { DomainError } from '../domain/domain-error.ts';
import type { PersistedTripRequest } from '../mapping/trip-request-mapper.ts';
import { normalizeTripRequest } from '../mapping/trip-request-mapper.ts';

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
  providerFixtureVersion: string;
  engineVersion: string;
  scoringVersion: string;
}

/** Stabilny fingerprint obejmuje pełny, potwierdzony input oraz wersje pipeline'u. */
export function createPlanningFingerprint(
  context: PlanningContext,
  versions: PlanningVersions,
): string {
  const { currencyContractVersion, ...pipelineVersions } = versions;
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
