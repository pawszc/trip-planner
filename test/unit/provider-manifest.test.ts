import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SOURCE_SNAPSHOT_CONTRACT_VERSION } from '../../srv/domain/money.js';
import {
  MOCK_PROVIDER_MANIFEST,
  MOCK_PROVIDER_MANIFEST_LINEAGE,
  PROVIDER_MANIFEST_VERSION,
  createProviderConfigurationManifest,
  isLegacyFixtureCompatibleManifest,
  providerManifestLineage,
  type ProviderManifestEntry,
} from '../../srv/providers/provider-manifest.js';

function mutableMockEntries(): ProviderManifestEntry[] {
  return MOCK_PROVIDER_MANIFEST.entries.map((entry) => ({ ...entry }));
}

describe('provider configuration manifest', () => {
  it('has a versioned canonical fingerprint independent of entry input order', () => {
    const reversed = createProviderConfigurationManifest(mutableMockEntries().reverse());
    const reversedLineage = providerManifestLineage(reversed);

    expect(reversed.manifestVersion).toBe(PROVIDER_MANIFEST_VERSION);
    expect(PROVIDER_MANIFEST_VERSION).toBe('planning-provider-manifest-v1');
    expect(reversed.entries.map((entry) => entry.role)).toEqual([
      'TRANSPORT',
      'ACCOMMODATION',
      'PLACES',
    ]);
    expect(reversedLineage).toStrictEqual(MOCK_PROVIDER_MANIFEST_LINEAGE);
    expect(reversedLineage.manifestFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(createHash('sha256').update(reversedLineage.manifestJson, 'utf8').digest('hex')).toBe(
      reversedLineage.manifestFingerprint,
    );
    expect(JSON.parse(reversedLineage.manifestJson)).toStrictEqual({
      entries: reversed.entries.map((entry) => ({ ...entry })),
      executionPolicy: { ...reversed.executionPolicy },
      manifestVersion: PROVIDER_MANIFEST_VERSION,
    });
  });

  it('changes the fingerprint when adapter lineage or execution policy changes', () => {
    const changedEntries = mutableMockEntries();
    const transport = changedEntries.find((entry) => entry.role === 'TRANSPORT');
    if (transport === undefined) throw new Error('Missing transport manifest entry.');
    transport.adapterVersion = 'mock-transport-adapter-v2';

    const adapterChange = providerManifestLineage(
      createProviderConfigurationManifest(changedEntries),
    );
    const policyChange = providerManifestLineage(
      createProviderConfigurationManifest(mutableMockEntries(), {
        ...MOCK_PROVIDER_MANIFEST.executionPolicy,
        timeoutMs: MOCK_PROVIDER_MANIFEST.executionPolicy.timeoutMs - 1,
      }),
    );

    expect(adapterChange.manifestFingerprint).not.toBe(
      MOCK_PROVIDER_MANIFEST_LINEAGE.manifestFingerprint,
    );
    expect(policyChange.manifestFingerprint).not.toBe(
      MOCK_PROVIDER_MANIFEST_LINEAGE.manifestFingerprint,
    );
    expect(
      isLegacyFixtureCompatibleManifest(createProviderConfigurationManifest(changedEntries)),
    ).toBe(false);
  });

  it('keeps a mixed live configuration explicit and removes the legacy fixture alias', () => {
    const mixedEntries = mutableMockEntries();
    const transport = mixedEntries.find((entry) => entry.role === 'TRANSPORT');
    if (transport === undefined) throw new Error('Missing transport manifest entry.');
    Object.assign(transport, {
      mode: 'LIVE' as const,
      providerKey: 'contract-live-transport',
      providerName: 'ContractLiveTransportProvider',
      providerVersion: 'contract-live-transport-v1',
      adapterId: 'contract-live-transport-adapter',
      adapterVersion: 'contract-live-transport-adapter-v1',
      sourceContractVersion: SOURCE_SNAPSHOT_CONTRACT_VERSION,
      fixtureVersion: null,
      upstreamApiVersion: 'contract-api-v1',
      upstreamSchemaVersion: 'contract-schema-v1',
    });

    const manifest = createProviderConfigurationManifest(mixedEntries);
    const lineage = providerManifestLineage(manifest);

    expect(lineage.fixtureVersion).toBeNull();
    expect(isLegacyFixtureCompatibleManifest(manifest)).toBe(false);
    expect(manifest.entries.find((entry) => entry.role === 'TRANSPORT')).toMatchObject({
      mode: 'LIVE',
      fixtureVersion: null,
    });
    expect(lineage.manifestJson).not.toContain('apiKey');
    expect(lineage.manifestJson).not.toContain('authorization');
  });

  it('fails closed for a missing or duplicate provider role', () => {
    const withoutPlaces = mutableMockEntries().filter((entry) => entry.role !== 'PLACES');
    const duplicatedTransport = mutableMockEntries();
    duplicatedTransport[2] = { ...duplicatedTransport[0]! };

    expect(() => createProviderConfigurationManifest(withoutPlaces)).toThrowError(
      'Provider manifest must contain each provider role exactly once.',
    );
    expect(() => createProviderConfigurationManifest(duplicatedTransport)).toThrowError(
      'Provider manifest must contain each provider role exactly once.',
    );
  });

  it('rejects runtime fields outside the manifest allowlist without serializing a secret', () => {
    const entries = mutableMockEntries();
    const sentinel = 'SECRET_PROVIDER_API_KEY_SENTINEL';
    const transport = entries.find((entry) => entry.role === 'TRANSPORT');
    if (transport === undefined) throw new Error('Missing transport manifest entry.');
    (transport as ProviderManifestEntry & { apiKey: string }).apiKey = sentinel;

    const error = (() => {
      try {
        createProviderConfigurationManifest(entries);
        return null;
      } catch (caught) {
        return caught;
      }
    })();

    expect(error).toBeInstanceOf(TypeError);
    expect(String(error)).not.toContain(sentinel);
  });
});
