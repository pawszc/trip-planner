import { createHash } from 'node:crypto';
import type { PlanningContext } from '../domain/candidate.ts';
import { DomainError } from '../domain/domain-error.ts';
import type { PersistedTripRequest } from '../mapping/trip-request-mapper.ts';
import { normalizeTripRequest } from '../mapping/trip-request-mapper.ts';

/**
 * Konwertuje major units na minor units przez parser dziesiętny i BigInt.
 * Dzięki temu 0,1 nie przechodzi przez arytmetykę binarnego floating point.
 */
export function majorUnitsToMinorUnits(value: unknown): number {
  const decimal = String(value).trim();
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(decimal);
  if (!match) {
    throw new DomainError(
      'INVALID_TOTAL_BUDGET_PRECISION',
      'Budżet musi mieć najwyżej dwie cyfry po separatorze dziesiętnym.',
    );
  }
  const whole = BigInt(match[1] ?? '0');
  const fraction = BigInt((match[2] ?? '').padEnd(2, '0'));
  const minor = whole * 100n + fraction;
  const result = Number(minor);
  if (!Number.isSafeInteger(result) || result <= 0) {
    throw new DomainError(
      'INVALID_TOTAL_BUDGET_MINOR_UNITS',
      'Budżet przekracza bezpieczny zakres integer minor units.',
    );
  }
  return result;
}

export function createPlanningContext(tripRequest: PersistedTripRequest): PlanningContext {
  const normalized = normalizeTripRequest(tripRequest);
  return {
    tripRequestId: tripRequest.ID,
    originCity: normalized.originCity,
    startDate: normalized.startDate,
    endDate: normalized.endDate,
    adults: normalized.adults,
    totalBudgetMinor: majorUnitsToMinorUnits(tripRequest.totalBudget),
    currency: normalized.currency,
    pace: normalized.pace as PlanningContext['pace'],
    hardConstraints: normalized.hardConstraints,
    softPreferences: normalized.softPreferences,
  };
}

/** Stabilny fingerprint obejmuje pełny, potwierdzony input oraz wersje pipeline'u. */
export function createPlanningFingerprint(
  context: PlanningContext,
  versions: { providerFixtureVersion: string; engineVersion: string; scoringVersion: string },
): string {
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
    versions,
  });
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}
