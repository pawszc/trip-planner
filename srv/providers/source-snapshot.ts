import {
  FRESHNESS_TYPE_VALUES,
  SOURCE_SNAPSHOT_CONTRACT_VERSION,
  SOURCE_TYPE_VALUES,
  type SourceSnapshot,
} from '../domain/money.ts';
import { isSupportedCurrency } from '../domain/currency.ts';
import { parseStrictIsoDate } from '../validation/strict-iso-date.ts';
import {
  canonicalizeProviderJson,
  createProviderFingerprint,
  isSha256Fingerprint,
  type ProviderJsonValue,
} from './provider-fingerprint.ts';

const INTERNAL_SOURCE_URLS = new Set(['INTERNAL_FIXTURE', 'INTERNAL_RULE']);

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || (codePoint >= 127 && codePoint <= 159);
  });
}

function strictInstant(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match =
    /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (
    match === null ||
    parseStrictIsoDate(match[1] ?? '') === null ||
    Number(match[2]) > 23 ||
    Number(match[3]) > 59 ||
    Number(match[4]) > 59
  ) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function safeText(value: unknown, maximum: number): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= maximum &&
    !containsControlCharacter(value)
  );
}

function safeAttributionUrl(value: unknown, sourceType: SourceSnapshot['sourceType']): boolean {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 500 ||
    containsControlCharacter(value)
  ) {
    return false;
  }
  if (sourceType !== 'LIVE') return INTERNAL_SOURCE_URLS.has(value);
  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === 'https:' || parsed.protocol === 'http:') &&
      parsed.username.length === 0 &&
      parsed.password.length === 0 &&
      parsed.search.length === 0 &&
      parsed.hash.length === 0
    );
  } catch {
    return false;
  }
}

/** Returns closed field identifiers only; no provider-controlled value is echoed. */
export function sourceSnapshotValidationIssues(source: SourceSnapshot | null): readonly string[] {
  if (source === null || typeof source !== 'object') return ['source'];
  const issues: string[] = [];
  const expectedKeys = [
    'adapterVersion',
    'contractVersion',
    'currency',
    'expiresAt',
    'externalItemId',
    'fetchedAt',
    'fixtureVersion',
    'freshnessType',
    'id',
    'provider',
    'providerVersion',
    'queryFingerprint',
    'resultFingerprint',
    'sourceType',
    'sourceUrl',
    'upstreamApiVersion',
    'upstreamSchemaFingerprint',
  ];
  const actualKeys = Object.keys(source).sort((left, right) => left.localeCompare(right, 'en'));
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    issues.push('fields');
  }
  if (source.contractVersion !== SOURCE_SNAPSHOT_CONTRACT_VERSION) issues.push('contractVersion');
  if (!SOURCE_TYPE_VALUES.includes(source.sourceType)) issues.push('sourceType');
  if (!safeText(source.id, 500)) issues.push('id');
  if (!safeText(source.provider, 120)) issues.push('provider');
  if (!safeText(source.adapterVersion, 120)) issues.push('adapterVersion');
  if (!safeText(source.providerVersion, 120)) issues.push('providerVersion');
  if (!safeText(source.externalItemId, 250)) issues.push('externalItemId');
  if (source.upstreamApiVersion !== null && !safeText(source.upstreamApiVersion, 120)) {
    issues.push('upstreamApiVersion');
  }
  if (
    source.upstreamSchemaFingerprint !== null &&
    !isSha256Fingerprint(source.upstreamSchemaFingerprint)
  ) {
    issues.push('upstreamSchemaFingerprint');
  }
  if (!isSha256Fingerprint(source.queryFingerprint)) issues.push('queryFingerprint');
  if (!isSha256Fingerprint(source.resultFingerprint)) issues.push('resultFingerprint');
  const fetchedAt = strictInstant(source.fetchedAt);
  if (fetchedAt === null) issues.push('fetchedAt');
  const expiresAt = source.expiresAt === null ? null : strictInstant(source.expiresAt);
  if (source.expiresAt !== null && expiresAt === null) issues.push('expiresAt');
  if (fetchedAt !== null && expiresAt !== null && expiresAt <= fetchedAt) {
    issues.push('expiresAtOrder');
  }
  if (!safeAttributionUrl(source.sourceUrl, source.sourceType)) issues.push('sourceUrl');
  if (!FRESHNESS_TYPE_VALUES.includes(source.freshnessType)) issues.push('freshnessType');
  if (!isSupportedCurrency(source.currency)) issues.push('currency');

  if (source.sourceType === 'FIXTURE') {
    if (source.freshnessType !== 'FIXTURE') issues.push('fixtureFreshness');
    if (!safeText(source.fixtureVersion, 80)) issues.push('fixtureVersion');
    if (source.expiresAt !== null) issues.push('fixtureExpiry');
  } else if (source.sourceType === 'INTERNAL_RULE') {
    if (source.freshnessType !== 'INTERNAL_RULE') issues.push('internalRuleFreshness');
    // A non-null legacy alias remains readable for grounded-context v1. Live sources may never
    // use fixtureVersion; providerVersion is authoritative for new internal-rule lineage.
    if (source.fixtureVersion !== null && !safeText(source.fixtureVersion, 80)) {
      issues.push('fixtureVersion');
    }
    if (source.expiresAt !== null) issues.push('internalRuleExpiry');
  } else if (source.sourceType === 'LIVE') {
    if (source.freshnessType !== 'LIVE' && source.freshnessType !== 'CACHED') {
      issues.push('liveFreshness');
    }
    if (source.fixtureVersion !== null) issues.push('liveFixtureVersion');
  }
  return Object.freeze([...new Set(issues)].sort((left, right) => left.localeCompare(right, 'en')));
}

export function isCompleteSourceSnapshot(source: SourceSnapshot | null): source is SourceSnapshot {
  return sourceSnapshotValidationIssues(source).length === 0;
}

export type SourceSnapshotResultFingerprintInput = Omit<SourceSnapshot, 'resultFingerprint'>;

/**
 * Binds one source to the complete allowlisted normalized item view. The raw upstream result is
 * never accepted by this helper and the existing result fingerprint is deliberately excluded.
 */
export function createSourceSnapshotResultFingerprint(
  source: SourceSnapshotResultFingerprintInput | SourceSnapshot,
  normalizedResult: ProviderJsonValue,
): string {
  return createProviderFingerprint({
    source: {
      contractVersion: source.contractVersion,
      id: source.id,
      sourceType: source.sourceType,
      provider: source.provider,
      adapterVersion: source.adapterVersion,
      providerVersion: source.providerVersion,
      upstreamApiVersion: source.upstreamApiVersion,
      upstreamSchemaFingerprint: source.upstreamSchemaFingerprint,
      queryFingerprint: source.queryFingerprint,
      externalItemId: source.externalItemId,
      fetchedAt: source.fetchedAt,
      expiresAt: source.expiresAt,
      sourceUrl: source.sourceUrl,
      freshnessType: source.freshnessType,
      currency: source.currency,
      fixtureVersion: source.fixtureVersion,
    },
    normalizedResult,
  });
}

/** Canonical equality used as defense-in-depth when stable source IDs collide. */
export function canonicalSourceSnapshot(source: SourceSnapshot): string {
  return canonicalizeProviderJson({
    contractVersion: source.contractVersion,
    id: source.id,
    sourceType: source.sourceType,
    provider: source.provider,
    adapterVersion: source.adapterVersion,
    providerVersion: source.providerVersion,
    upstreamApiVersion: source.upstreamApiVersion,
    upstreamSchemaFingerprint: source.upstreamSchemaFingerprint,
    queryFingerprint: source.queryFingerprint,
    resultFingerprint: source.resultFingerprint,
    externalItemId: source.externalItemId,
    fetchedAt: source.fetchedAt,
    expiresAt: source.expiresAt,
    sourceUrl: source.sourceUrl,
    freshnessType: source.freshnessType,
    currency: source.currency,
    fixtureVersion: source.fixtureVersion,
  });
}
