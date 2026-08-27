import { SOURCE_SNAPSHOT_CONTRACT_VERSION } from '../domain/money.ts';
import {
  DEFAULT_PROVIDER_EXECUTION_POLICY,
  resolveProviderExecutionPolicy,
  type ProviderExecutionPolicy,
} from './provider-execution.ts';
import {
  canonicalizeProviderJson,
  createProviderFingerprint,
  isSha256Fingerprint,
  type ProviderJsonValue,
} from './provider-fingerprint.ts';
import {
  MOCK_ADAPTER_IDS,
  MOCK_ADAPTER_VERSIONS,
  MOCK_FIXTURE_VERSION,
  MOCK_PROVIDER_KEYS,
  MOCK_PROVIDER_NAMES,
  MOCK_UPSTREAM_SCHEMA_FINGERPRINT,
} from './fixtures/fixture-source.ts';

export const PROVIDER_MANIFEST_VERSION = 'planning-provider-manifest-v1';
export const PROVIDER_MANIFEST_JSON_MAX_LENGTH = 8_000;
export const PROVIDER_ROLE_VALUES = ['TRANSPORT', 'ACCOMMODATION', 'PLACES'] as const;
export type ProviderRole = (typeof PROVIDER_ROLE_VALUES)[number];
export const PROVIDER_MODE_VALUES = ['FIXTURE', 'LIVE'] as const;
export type ProviderMode = (typeof PROVIDER_MODE_VALUES)[number];

export interface ProviderManifestEntry {
  role: ProviderRole;
  mode: ProviderMode;
  providerKey: string;
  providerName: string;
  providerVersion: string;
  adapterId: string;
  adapterVersion: string;
  sourceContractVersion: typeof SOURCE_SNAPSHOT_CONTRACT_VERSION;
  searchPolicyVersion: string | null;
  fixtureVersion: string | null;
  upstreamApiVersion: string | null;
  upstreamSchemaVersion: string | null;
  upstreamSchemaFingerprint: string | null;
}

export interface ProviderConfigurationManifest {
  manifestVersion: typeof PROVIDER_MANIFEST_VERSION;
  executionPolicy: ProviderExecutionPolicy;
  entries: readonly ProviderManifestEntry[];
}

const PROVIDER_MANIFEST_ENTRY_KEYS = [
  'role',
  'mode',
  'providerKey',
  'providerName',
  'providerVersion',
  'adapterId',
  'adapterVersion',
  'sourceContractVersion',
  'searchPolicyVersion',
  'fixtureVersion',
  'upstreamApiVersion',
  'upstreamSchemaVersion',
  'upstreamSchemaFingerprint',
] as const satisfies readonly (keyof ProviderManifestEntry)[];

export interface ProviderManifestLineage {
  manifestVersion: typeof PROVIDER_MANIFEST_VERSION;
  manifestFingerprint: string;
  manifestJson: string;
  fixtureVersion: string | null;
}

function isSafeIdentifier(value: unknown, maximum = 160): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximum &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
  );
}

function assertNullableIdentifier(value: unknown, field: string): asserts value is string | null {
  if (value !== null && !isSafeIdentifier(value)) {
    throw new TypeError(`Provider manifest ${field} must be null or a safe identifier.`);
  }
}

function normalizedEntry(entry: ProviderManifestEntry): ProviderManifestEntry {
  const runtimeKeys = Object.keys(entry).sort((left, right) => left.localeCompare(right, 'en'));
  const allowedKeys = [...PROVIDER_MANIFEST_ENTRY_KEYS].sort((left, right) =>
    left.localeCompare(right, 'en'),
  );
  if (
    runtimeKeys.length !== allowedKeys.length ||
    runtimeKeys.some((key, index) => key !== allowedKeys[index]) ||
    !PROVIDER_ROLE_VALUES.includes(entry.role) ||
    !PROVIDER_MODE_VALUES.includes(entry.mode) ||
    !isSafeIdentifier(entry.providerKey) ||
    !isSafeIdentifier(entry.providerName) ||
    !isSafeIdentifier(entry.providerVersion) ||
    !isSafeIdentifier(entry.adapterId) ||
    !isSafeIdentifier(entry.adapterVersion) ||
    entry.sourceContractVersion !== SOURCE_SNAPSHOT_CONTRACT_VERSION
  ) {
    throw new TypeError('Provider manifest entry contains invalid closed lineage metadata.');
  }
  assertNullableIdentifier(entry.searchPolicyVersion, 'searchPolicyVersion');
  assertNullableIdentifier(entry.fixtureVersion, 'fixtureVersion');
  assertNullableIdentifier(entry.upstreamApiVersion, 'upstreamApiVersion');
  assertNullableIdentifier(entry.upstreamSchemaVersion, 'upstreamSchemaVersion');
  if (
    entry.upstreamSchemaFingerprint !== null &&
    !isSha256Fingerprint(entry.upstreamSchemaFingerprint)
  ) {
    throw new TypeError('Provider manifest upstreamSchemaFingerprint must be canonical SHA-256.');
  }
  if (
    (entry.mode === 'FIXTURE' && entry.fixtureVersion === null) ||
    (entry.mode === 'LIVE' && entry.fixtureVersion !== null)
  ) {
    throw new TypeError('Provider manifest fixtureVersion does not match provider mode.');
  }
  return Object.freeze({
    role: entry.role,
    mode: entry.mode,
    providerKey: entry.providerKey,
    providerName: entry.providerName,
    providerVersion: entry.providerVersion,
    adapterId: entry.adapterId,
    adapterVersion: entry.adapterVersion,
    sourceContractVersion: entry.sourceContractVersion,
    searchPolicyVersion: entry.searchPolicyVersion,
    fixtureVersion: entry.fixtureVersion,
    upstreamApiVersion: entry.upstreamApiVersion,
    upstreamSchemaVersion: entry.upstreamSchemaVersion,
    upstreamSchemaFingerprint: entry.upstreamSchemaFingerprint,
  });
}

export function createProviderConfigurationManifest(
  entries: readonly ProviderManifestEntry[],
  executionPolicy: ProviderExecutionPolicy = DEFAULT_PROVIDER_EXECUTION_POLICY,
): ProviderConfigurationManifest {
  const normalized = [...entries]
    .map(normalizedEntry)
    .sort(
      (left, right) =>
        PROVIDER_ROLE_VALUES.indexOf(left.role) - PROVIDER_ROLE_VALUES.indexOf(right.role),
    );
  if (
    normalized.length !== PROVIDER_ROLE_VALUES.length ||
    PROVIDER_ROLE_VALUES.some(
      (role) => normalized.filter((entry) => entry.role === role).length !== 1,
    )
  ) {
    throw new TypeError('Provider manifest must contain each provider role exactly once.');
  }
  const resolvedPolicy = resolveProviderExecutionPolicy({
    timeoutMs: executionPolicy.timeoutMs,
    maxCallsPerRun: executionPolicy.maxCallsPerRun,
    maxConcurrency: executionPolicy.maxConcurrency,
  });
  if (
    executionPolicy.version !== resolvedPolicy.version ||
    executionPolicy.maxAttemptsPerCall !== 1 ||
    executionPolicy.rateLimitStrategy !== 'FAIL_FAST' ||
    executionPolicy.fallbackStrategy !== 'NONE'
  ) {
    throw new TypeError('Provider manifest contains an unsupported execution policy.');
  }
  return Object.freeze({
    manifestVersion: PROVIDER_MANIFEST_VERSION,
    executionPolicy: resolvedPolicy,
    entries: Object.freeze(normalized),
  });
}

function manifestJsonValue(manifest: ProviderConfigurationManifest): ProviderJsonValue {
  return {
    manifestVersion: manifest.manifestVersion,
    executionPolicy: {
      version: manifest.executionPolicy.version,
      timeoutMs: manifest.executionPolicy.timeoutMs,
      maxCallsPerRun: manifest.executionPolicy.maxCallsPerRun,
      maxConcurrency: manifest.executionPolicy.maxConcurrency,
      maxAttemptsPerCall: manifest.executionPolicy.maxAttemptsPerCall,
      rateLimitStrategy: manifest.executionPolicy.rateLimitStrategy,
      fallbackStrategy: manifest.executionPolicy.fallbackStrategy,
    },
    entries: manifest.entries.map((entry) => ({
      role: entry.role,
      mode: entry.mode,
      providerKey: entry.providerKey,
      providerName: entry.providerName,
      providerVersion: entry.providerVersion,
      adapterId: entry.adapterId,
      adapterVersion: entry.adapterVersion,
      sourceContractVersion: entry.sourceContractVersion,
      searchPolicyVersion: entry.searchPolicyVersion,
      fixtureVersion: entry.fixtureVersion,
      upstreamApiVersion: entry.upstreamApiVersion,
      upstreamSchemaVersion: entry.upstreamSchemaVersion,
      upstreamSchemaFingerprint: entry.upstreamSchemaFingerprint,
    })),
  };
}

export function providerManifestLineage(
  manifest: ProviderConfigurationManifest,
): ProviderManifestLineage {
  const manifestKeys = Object.keys(manifest).sort((left, right) => left.localeCompare(right, 'en'));
  if (
    manifestKeys.length !== 3 ||
    !['entries', 'executionPolicy', 'manifestVersion'].every(
      (key, index) => manifestKeys[index] === key,
    ) ||
    manifest.manifestVersion !== PROVIDER_MANIFEST_VERSION
  ) {
    throw new TypeError('Provider manifest contains fields outside the closed contract.');
  }
  const normalizedManifest = createProviderConfigurationManifest(
    manifest.entries,
    manifest.executionPolicy,
  );
  const manifestJson = canonicalizeProviderJson(manifestJsonValue(normalizedManifest));
  if (manifestJson.length > PROVIDER_MANIFEST_JSON_MAX_LENGTH) {
    throw new TypeError('Provider manifest exceeds the bounded persistence contract.');
  }
  const fixtureVersions = new Set(
    normalizedManifest.entries
      .map((entry) => entry.fixtureVersion)
      .filter((value) => value !== null),
  );
  return Object.freeze({
    manifestVersion: manifest.manifestVersion,
    manifestFingerprint: createProviderFingerprint(manifestJsonValue(normalizedManifest)),
    manifestJson,
    fixtureVersion:
      normalizedManifest.entries.every((entry) => entry.mode === 'FIXTURE') &&
      fixtureVersions.size === 1
        ? ([...fixtureVersions][0] ?? null)
        : null,
  });
}

function mockEntry(
  role: ProviderRole,
  kind: keyof typeof MOCK_PROVIDER_NAMES,
): ProviderManifestEntry {
  return {
    role,
    mode: 'FIXTURE',
    providerKey: MOCK_PROVIDER_KEYS[kind],
    providerName: MOCK_PROVIDER_NAMES[kind],
    providerVersion: MOCK_FIXTURE_VERSION,
    adapterId: MOCK_ADAPTER_IDS[kind],
    adapterVersion: MOCK_ADAPTER_VERSIONS[kind],
    sourceContractVersion: SOURCE_SNAPSHOT_CONTRACT_VERSION,
    searchPolicyVersion: null,
    fixtureVersion: MOCK_FIXTURE_VERSION,
    upstreamApiVersion: null,
    upstreamSchemaVersion: 'europe-reference-fixture-schema-v1',
    upstreamSchemaFingerprint: MOCK_UPSTREAM_SCHEMA_FINGERPRINT,
  };
}

export const MOCK_PROVIDER_MANIFEST = createProviderConfigurationManifest([
  mockEntry('TRANSPORT', 'transport'),
  mockEntry('ACCOMMODATION', 'accommodation'),
  mockEntry('PLACES', 'places'),
]);

export const MOCK_PROVIDER_MANIFEST_LINEAGE = providerManifestLineage(MOCK_PROVIDER_MANIFEST);

/** Legacy fixture replay is opt-in only for this exact, closed mock configuration. */
export function isLegacyFixtureCompatibleManifest(
  manifest: ProviderConfigurationManifest,
): boolean {
  return (
    providerManifestLineage(manifest).manifestFingerprint ===
    MOCK_PROVIDER_MANIFEST_LINEAGE.manifestFingerprint
  );
}

export function providerEntry(
  manifest: ProviderConfigurationManifest,
  role: ProviderRole,
): ProviderManifestEntry {
  const entry = manifest.entries.find((candidate) => candidate.role === role);
  if (entry === undefined) {
    throw new TypeError(`Provider manifest is missing role ${role}.`);
  }
  return entry;
}
