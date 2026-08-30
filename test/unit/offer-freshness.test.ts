import { describe, expect, it, vi } from 'vitest';

import {
  OFFER_FRESHNESS_MARGIN_MS,
  OFFER_FRESHNESS_POLICY_VERSION,
  isSourceFresh,
  sourceFreshnessValidationIssues,
} from '../../srv/providers/offer-freshness.js';
import { candidateSource } from './candidate-fixtures.js';

function liveSource(expiresAt: string | null) {
  return {
    ...candidateSource('live-offer'),
    sourceType: 'LIVE' as const,
    provider: 'Duffel',
    freshnessType: 'LIVE' as const,
    fixtureVersion: null,
    sourceUrl: 'https://duffel.com',
    expiresAt,
  };
}

describe('offer freshness policy v1', () => {
  it('freezes the zero-margin versioned policy', () => {
    expect(OFFER_FRESHNESS_POLICY_VERSION).toBe('offer-freshness-policy-v1');
    expect(OFFER_FRESHNESS_MARGIN_MS).toBe(0);
  });

  it.each([
    ['before expiry', '2026-10-01T12:00:00.001Z', true, []],
    ['at expiry', '2026-10-01T12:00:00.000Z', false, ['expired']],
    ['after expiry', '2026-10-01T11:59:59.999Z', false, ['expired']],
    ['missing expiry', null, false, ['expiresAt']],
  ] as const)('%s is evaluated against the injected clock', (_label, expiresAt, fresh, issues) => {
    const clock = () => new Date('2026-10-01T12:00:00.000Z');
    expect(isSourceFresh(liveSource(expiresAt), clock)).toBe(fresh);
    expect(sourceFreshnessValidationIssues(liveSource(expiresAt), clock)).toEqual(issues);
  });

  it.each([
    ['FIXTURE', 'FIXTURE'],
    ['INTERNAL_RULE', 'INTERNAL_RULE'],
  ] as const)('does not read the clock for %s lineage', (sourceType, freshnessType) => {
    const clock = vi.fn(() => {
      throw new Error('clock must not be read');
    });
    const source = {
      ...candidateSource(`non-live-${sourceType}`),
      sourceType,
      freshnessType,
      fixtureVersion: sourceType === 'FIXTURE' ? 'candidate-test-v1' : null,
      sourceUrl: sourceType === 'FIXTURE' ? 'INTERNAL_FIXTURE' : 'INTERNAL_RULE',
    };

    expect(sourceFreshnessValidationIssues(source, clock)).toEqual([]);
    expect(clock).not.toHaveBeenCalled();
  });
});
