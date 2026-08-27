import { describe, expect, it } from 'vitest';
import {
  SOURCE_SNAPSHOT_CONTRACT_VERSION,
  sourceSnapshotLineage,
  type LegacyFixtureSourceSnapshot,
  type SourceSnapshot,
} from '../../srv/domain/money.js';
import type { Destination } from '../../srv/domain/candidate.js';
import type { TransportSearchRequest } from '../../srv/providers/contracts.js';
import {
  MOCK_FIXTURE_VERSION,
  MOCK_PROVIDER_NAMES,
  createFixtureSource,
} from '../../srv/providers/fixtures/fixture-source.js';
import { createProviderFingerprint } from '../../srv/providers/provider-fingerprint.js';
import {
  isCompleteSourceSnapshot,
  sourceSnapshotValidationIssues,
} from '../../srv/providers/source-snapshot.js';

const prague: Destination = { code: 'PRG', city: 'Prague', countryCode: 'CZ' };
const vienna: Destination = { code: 'VIE', city: 'Vienna', countryCode: 'AT' };
const transportRequest: TransportSearchRequest = {
  originCity: 'Wrocław',
  destinations: [prague, vienna],
  startDate: '2026-10-10',
  endDate: '2026-10-13',
  adults: 2,
  currency: 'PLN',
};

function fixtureSource(): SourceSnapshot {
  return createFixtureSource(
    MOCK_PROVIDER_NAMES.transport,
    'transport-prg-test',
    transportRequest,
    { destinationCode: 'PRG', id: 'transport-prg-test', priceMinor: 64_000 },
  );
}

function liveSource(): SourceSnapshot {
  return {
    ...fixtureSource(),
    id: 'live-transport:offer-1',
    sourceType: 'LIVE',
    provider: 'ContractLiveTransportProvider',
    adapterVersion: 'contract-live-transport-adapter-v1',
    providerVersion: 'contract-live-transport-v1',
    upstreamApiVersion: 'contract-api-v1',
    externalItemId: 'offer-1',
    fetchedAt: '2026-10-01T12:00:00.000Z',
    expiresAt: '2026-10-01T12:30:00.000Z',
    sourceUrl: 'https://provider.example/offers/offer-1',
    attribution: 'Contract provider',
    freshnessType: 'LIVE',
    fixtureVersion: null,
    termsPolicyVersion: 'contract-provider-terms-v1',
  };
}

describe('source snapshot v2', () => {
  it('creates deterministic fixture query/result fingerprints from canonical safe views', () => {
    const first = fixtureSource();
    const reordered = createFixtureSource(
      MOCK_PROVIDER_NAMES.transport,
      'transport-prg-test',
      { ...transportRequest, destinations: [vienna, prague] },
      { priceMinor: 64_000, id: 'transport-prg-test', destinationCode: 'PRG' },
    );
    const changedQuery = createFixtureSource(
      MOCK_PROVIDER_NAMES.transport,
      'transport-prg-test',
      { ...transportRequest, originCity: 'Warszawa' },
      { destinationCode: 'PRG', id: 'transport-prg-test', priceMinor: 64_000 },
    );

    expect(first).toMatchObject({
      contractVersion: SOURCE_SNAPSHOT_CONTRACT_VERSION,
      sourceType: 'FIXTURE',
      fixtureVersion: MOCK_FIXTURE_VERSION,
      expiresAt: null,
    });
    expect(first.queryFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(first.resultFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(reordered.queryFingerprint).toBe(first.queryFingerprint);
    expect(reordered.resultFingerprint).toBe(first.resultFingerprint);
    expect(changedQuery.queryFingerprint).not.toBe(first.queryFingerprint);
    expect(sourceSnapshotValidationIssues(first)).toEqual([]);
  });

  it('accepts live lineage with optional future expiry and rejects fixture leakage', () => {
    const live = liveSource();

    expect(isCompleteSourceSnapshot(live)).toBe(true);
    expect(isCompleteSourceSnapshot({ ...live, expiresAt: null })).toBe(true);
    expect(
      sourceSnapshotValidationIssues({ ...live, fixtureVersion: MOCK_FIXTURE_VERSION }),
    ).toContain('liveFixtureVersion');
    expect(
      sourceSnapshotValidationIssues({ ...fixtureSource(), expiresAt: live.expiresAt }),
    ).toContain('fixtureExpiry');
    expect(
      sourceSnapshotValidationIssues({
        ...live,
        expiresAt: '2026-10-01T11:59:59.000Z',
      }),
    ).toContain('expiresAtOrder');
  });

  it('preserves nullable URL/currency/attribution without inventing facts and requires terms policy lineage', () => {
    const sparseLive = {
      ...liveSource(),
      sourceUrl: null,
      currency: null,
      attribution: null,
    };

    expect(sourceSnapshotValidationIssues(sparseLive)).toEqual([]);
    expect(isCompleteSourceSnapshot(sparseLive)).toBe(true);
    expect(
      sourceSnapshotValidationIssues({
        ...sparseLive,
        termsPolicyVersion: null,
      } as unknown as SourceSnapshot),
    ).toContain('termsPolicyVersion');
    expect(
      sourceSnapshotValidationIssues({ ...sparseLive, attribution: 'unsafe\nvalue' }),
    ).toContain('attribution');
  });

  it.each([
    'https://user:password@provider.example/offers/offer-1',
    'https://provider.example/offers/offer-1?token=secret',
    'https://provider.example/offers/offer-1#raw-payload',
    'ftp://provider.example/offers/offer-1',
  ])('rejects unsafe live attribution URL %s without echoing it', (sourceUrl) => {
    const issues = sourceSnapshotValidationIssues({ ...liveSource(), sourceUrl });

    expect(issues).toContain('sourceUrl');
    expect(issues.join('|')).not.toContain(sourceUrl);
  });

  it.each([
    ['impossible fetched date', { fetchedAt: '2026-02-30T12:00:00.000Z' }, 'fetchedAt'],
    ['impossible expiry date', { expiresAt: '2026-02-30T12:00:00.000Z' }, 'expiresAt'],
    [
      'control character in URL',
      { sourceUrl: 'https://provider.example/offers/offer-1\n' },
      'sourceUrl',
    ],
    ['overlong URL', { sourceUrl: `https://provider.example/${'a'.repeat(501)}` }, 'sourceUrl'],
  ] as const)('rejects %s using a closed issue identifier', (_label, override, issue) => {
    const issues = sourceSnapshotValidationIssues({ ...liveSource(), ...override });

    expect(issues).toContain(issue);
    expect(issues.join('|')).not.toContain(Object.values(override)[0]);
  });

  it.each([
    ['queryFingerprint', { queryFingerprint: 'not-a-hash' }],
    ['resultFingerprint', { resultFingerprint: 'A'.repeat(64) }],
    ['upstreamSchemaFingerprint', { upstreamSchemaFingerprint: '1234' }],
  ] as const)('rejects a non-canonical %s', (issue, override) => {
    expect(sourceSnapshotValidationIssues({ ...liveSource(), ...override })).toContain(issue);
  });

  it('keeps historical fixture lineage explicitly legacy without synthesizing v2 facts', () => {
    const legacy: LegacyFixtureSourceSnapshot = {
      id: 'legacy-source',
      provider: 'MockTransportProvider',
      externalItemId: 'legacy-offer',
      fetchedAt: '2025-01-01T00:00:00.000Z',
      sourceUrl: 'INTERNAL_FIXTURE',
      freshnessType: 'FIXTURE',
      currency: 'PLN',
      fixtureVersion: 'legacy-fixture-v1',
    };

    expect(sourceSnapshotLineage(legacy)).toStrictEqual({
      contractVersion: 'source-snapshot-v1-legacy',
      sourceType: 'FIXTURE',
      adapterVersion: null,
      providerVersion: null,
      upstreamApiVersion: null,
      upstreamSchemaFingerprint: null,
      queryFingerprint: null,
      resultFingerprint: null,
      expiresAt: null,
      fixtureVersion: 'legacy-fixture-v1',
    });
  });

  it('requires canonical SHA-256 fingerprints even when the remaining source is complete', () => {
    const fingerprint = createProviderFingerprint({ contract: 'source-snapshot-v2' });
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(
      sourceSnapshotValidationIssues({ ...liveSource(), queryFingerprint: fingerprint }),
    ).toEqual([]);
  });
});
