import { DomainError } from '../domain/domain-error.ts';
import { SOFT_PREFERENCE_KEYS } from '../domain/trip-request.ts';
import type { SoftPreferences } from '../domain/trip-request.ts';

/** Każda miękka preferencja ma całkowitą wagę od 1 do 5. */
export function validateSoftPreferences(input: SoftPreferences): void {
  for (const preference of SOFT_PREFERENCE_KEYS) {
    const weight = input[preference];
    if (!Number.isInteger(weight) || weight < 1 || weight > 5) {
      throw new DomainError(
        'INVALID_SOFT_PREFERENCE_WEIGHT',
        `Waga preferencji ${preference} musi być liczbą całkowitą od 1 do 5.`,
      );
    }
  }
}
