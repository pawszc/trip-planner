import type { SourceSnapshot } from '../domain/money.ts';

export const OFFER_FRESHNESS_POLICY_VERSION = 'offer-freshness-policy-v1';
export const OFFER_FRESHNESS_MARGIN_MS = 0;

export type OfferFreshnessClock = () => Date;

export const systemOfferFreshnessClock: OfferFreshnessClock = () => new Date();

export interface OfferFreshnessPolicy {
  readonly version: typeof OFFER_FRESHNESS_POLICY_VERSION;
  readonly marginMs: typeof OFFER_FRESHNESS_MARGIN_MS;
}

export const OFFER_FRESHNESS_POLICY: OfferFreshnessPolicy = Object.freeze({
  version: OFFER_FRESHNESS_POLICY_VERSION,
  marginMs: OFFER_FRESHNESS_MARGIN_MS,
});

/**
 * LIVE lineage is selectable only while its explicit expiry is strictly after the injected
 * clock. Fixture and internal-rule lineage deliberately return before reading the clock.
 */
export function sourceFreshnessValidationIssues(
  source: SourceSnapshot,
  clock: OfferFreshnessClock = systemOfferFreshnessClock,
): readonly string[] {
  if (source.sourceType !== 'LIVE') return Object.freeze([]);
  if (source.expiresAt === null) return Object.freeze(['expiresAt']);

  const expiresAt = Date.parse(source.expiresAt);
  if (!Number.isFinite(expiresAt)) return Object.freeze(['expiresAt']);

  const now = clock().getTime();
  if (!Number.isFinite(now)) return Object.freeze(['clock']);
  return expiresAt > now + OFFER_FRESHNESS_POLICY.marginMs
    ? Object.freeze([])
    : Object.freeze(['expired']);
}

export function isSourceFresh(
  source: SourceSnapshot,
  clock: OfferFreshnessClock = systemOfferFreshnessClock,
): boolean {
  return sourceFreshnessValidationIssues(source, clock).length === 0;
}
