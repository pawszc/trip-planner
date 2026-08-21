import {
  canonicalizeJson,
  createInputFingerprint,
  type JsonObject,
  type JsonValue,
} from '../ai/contracts.ts';
import { DomainError } from '../domain/domain-error.ts';
import {
  GROUNDED_OPTION_CONTEXT_VERSION,
  type GroundedFact,
  type GroundedFactStatus,
  type GroundedOptionContext,
} from './grounded-option-context.ts';

export const NARRATIVE_MODEL_VIEW_VERSION = 'narrative-model-view-v1';
export const NARRATIVE_PROVENANCE_FACT_KEY_VERSION = 'narrative-provenance-fact-key-v1';
export const NARRATIVE_MODEL_VIEW_MAX_BYTES = 64 * 1024;
export const NARRATIVE_REDACTED_VALUE = '[EXCLUDED_UNTRUSTED_VALUE]';

const GROUNDED_PROVENANCE_FACT_KEY_PREFIX = 'provenance.';
const MODEL_PROVENANCE_FACT_KEY_PREFIX = 'provenance.opaque-v1.';

const EXCLUDED_FIELD_NAMES = new Set([
  'sourceurl',
  'externalitemid',
  'provider',
  'sourcekey',
  'contexts',
]);
// The model boundary must recognize every forbidden C0/C1 control code explicitly.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu;
const BIDI_OVERRIDE_PATTERN = /[\u202a-\u202e\u2066-\u2069]/gu;
const SCRIPT_OR_STYLE_PATTERN = /<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/giu;
const HTML_TAG_PATTERN = /<\/?[a-z][^>]*>/giu;
const MARKDOWN_LINK_PATTERN = /!?\[[^\]\r\n]{0,512}\]\([^\s)]+(?:\s+[^)]*)?\)/gu;
const SCRIPT_PROTOCOL_PATTERN = /\b(?:javascript\s*:|data\s*:\s*text\/html|vbscript\s*:)[^\s]*/giu;
const EVENT_HANDLER_PATTERN = /\bon[a-z]{3,}\s*=\s*(?:"[^"]*"|'[^']*'|[^\s,;]*)/giu;
const URL_PATTERN =
  /(?:\b[a-z][a-z0-9+.-]*:\/\/|\bwww\.|\bmailto:|\b(?:\d{1,3}\.){3}\d{1,3}\b|\b[a-z0-9](?:[a-z0-9-]{0,62}\.)+[a-z]{2,63}(?![a-z0-9-]))[^\s<>()]*/giu;
const METADATA_URL_PATTERN =
  /(?:\b[a-z][a-z0-9+.-]*:\/\/|\bwww\.|\bmailto:|\b(?:\d{1,3}\.){3}\d{1,3}\b)[^\s<>()]*/giu;
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu;
const SECRET_PATTERN = /\b(?:sk|pk|api|token|secret)[-_][A-Za-z0-9_-]{6,}\b/giu;
const SOURCE_FRESHNESS_VALUES = new Set(['LIVE', 'CACHED', 'FIXTURE', 'INTERNAL_RULE']);

export type NarrativeModelFact = JsonObject & {
  readonly factId: string;
  readonly key: string;
  readonly status: GroundedFactStatus;
  readonly value: JsonValue;
  readonly sourceSnapshotIds: readonly string[];
  readonly internalDerivation: JsonObject | null;
};

export type NarrativeModelSource = JsonObject & {
  readonly id: string;
  readonly fetchedAt: string;
  readonly freshnessType: string;
  readonly currency: string;
  readonly fixtureVersion: string;
  readonly demonstrationData: boolean;
};

export type NarrativeModelView = JsonObject & {
  readonly version: typeof NARRATIVE_MODEL_VIEW_VERSION;
  readonly fingerprint: string;
  readonly groundedContextVersion: string;
  readonly groundedContextFingerprint: string;
  readonly planningRun: JsonObject;
  readonly rankedOption: JsonObject;
  readonly facts: readonly NarrativeModelFact[];
  readonly sourceSnapshots: readonly NarrativeModelSource[];
};

function invalidModelView(message: string): never {
  throw new DomainError('INVALID_NARRATIVE_MODEL_VIEW', message);
}

function isJsonArray(value: JsonValue): value is readonly JsonValue[] {
  return Array.isArray(value);
}

function sanitizeString(value: string): string {
  const sanitized = value
    .replace(SCRIPT_OR_STYLE_PATTERN, NARRATIVE_REDACTED_VALUE)
    .replace(HTML_TAG_PATTERN, NARRATIVE_REDACTED_VALUE)
    .replace(MARKDOWN_LINK_PATTERN, NARRATIVE_REDACTED_VALUE)
    .replace(SCRIPT_PROTOCOL_PATTERN, NARRATIVE_REDACTED_VALUE)
    .replace(EVENT_HANDLER_PATTERN, NARRATIVE_REDACTED_VALUE)
    .replace(URL_PATTERN, NARRATIVE_REDACTED_VALUE)
    .replace(EMAIL_PATTERN, NARRATIVE_REDACTED_VALUE)
    .replace(SECRET_PATTERN, NARRATIVE_REDACTED_VALUE)
    .replace(CONTROL_CHARACTER_PATTERN, '')
    .replace(BIDI_OVERRIDE_PATTERN, '')
    .trim();
  return sanitized.length === 0 ? NARRATIVE_REDACTED_VALUE : sanitized;
}

function sanitizeMetadataString(value: string): string {
  const sanitized = value
    .replace(SCRIPT_OR_STYLE_PATTERN, NARRATIVE_REDACTED_VALUE)
    .replace(HTML_TAG_PATTERN, NARRATIVE_REDACTED_VALUE)
    .replace(MARKDOWN_LINK_PATTERN, NARRATIVE_REDACTED_VALUE)
    .replace(SCRIPT_PROTOCOL_PATTERN, NARRATIVE_REDACTED_VALUE)
    .replace(EVENT_HANDLER_PATTERN, NARRATIVE_REDACTED_VALUE)
    .replace(METADATA_URL_PATTERN, NARRATIVE_REDACTED_VALUE)
    .replace(EMAIL_PATTERN, NARRATIVE_REDACTED_VALUE)
    .replace(SECRET_PATTERN, NARRATIVE_REDACTED_VALUE)
    .replace(CONTROL_CHARACTER_PATTERN, '')
    .replace(BIDI_OVERRIDE_PATTERN, '')
    .trim();
  return sanitized.length === 0 ? NARRATIVE_REDACTED_VALUE : sanitized;
}

function requireSafeMetadata(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || sanitizeMetadataString(value) !== normalized) {
    invalidModelView(`Narrative model-view metadata ${field} is unsafe.`);
  }
  return normalized;
}

function requireFingerprint(value: string, field: string): string {
  const normalized = requireSafeMetadata(value, field);
  if (!/^[0-9a-f]{64}$/u.test(normalized)) {
    invalidModelView(`Narrative model-view metadata ${field} is not a canonical fingerprint.`);
  }
  return normalized;
}

function requireFetchedAt(value: string): string {
  const normalized = requireSafeMetadata(value, 'sourceSnapshots.fetchedAt');
  const timestamp = Date.parse(normalized);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== normalized) {
    invalidModelView('Narrative model-view source timestamp is not an exact ISO instant.');
  }
  return normalized;
}

function requireFreshness(value: string): string {
  const normalized = requireSafeMetadata(value, 'sourceSnapshots.freshnessType');
  if (!SOURCE_FRESHNESS_VALUES.has(normalized)) {
    invalidModelView('Narrative model-view source freshness is outside the closed catalog.');
  }
  return normalized;
}

function sanitizeValue(value: JsonValue): JsonValue {
  if (typeof value === 'string') return sanitizeString(value);
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (isJsonArray(value)) return value.map((item) => sanitizeValue(item));

  const sanitized: Record<string, JsonValue> = {};
  for (const key of Object.keys(value).sort()) {
    if (EXCLUDED_FIELD_NAMES.has(key.toLowerCase())) continue;
    const fieldValue = value[key];
    if (fieldValue === undefined) {
      invalidModelView(`Grounded fact field ${key} is not JSON-serializable.`);
    }
    sanitized[key] = sanitizeValue(fieldValue);
  }
  return sanitized;
}

function projectFactKey(fact: GroundedFact, factId: string): string {
  if (!fact.key.startsWith(GROUNDED_PROVENANCE_FACT_KEY_PREFIX)) {
    return requireSafeMetadata(fact.key, 'facts.key');
  }
  const opaqueId = createInputFingerprint({
    version: NARRATIVE_PROVENANCE_FACT_KEY_VERSION,
    factId,
  });
  return `${MODEL_PROVENANCE_FACT_KEY_PREFIX}${opaqueId}`;
}

function projectFact(fact: GroundedFact): NarrativeModelFact {
  const factId = requireSafeMetadata(fact.factId, 'facts.factId');
  if (!/^fact_[0-9a-f]{64}$/u.test(factId)) {
    invalidModelView('Narrative model-view fact ID is not canonical.');
  }
  return {
    factId,
    key: projectFactKey(fact, factId),
    status: fact.status,
    value: sanitizeValue(fact.value),
    sourceSnapshotIds: fact.sourceSnapshotIds.map((id) =>
      requireSafeMetadata(id, 'facts.sourceSnapshotIds'),
    ),
    internalDerivation:
      fact.internalDerivation === null
        ? null
        : (sanitizeValue(fact.internalDerivation) as JsonObject),
  };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function assertSize(value: JsonValue): void {
  const bytes = Buffer.byteLength(canonicalizeJson(value), 'utf8');
  if (bytes > NARRATIVE_MODEL_VIEW_MAX_BYTES) {
    invalidModelView(
      `Narrative model view exceeds the ${NARRATIVE_MODEL_VIEW_MAX_BYTES}-byte v1 limit.`,
    );
  }
}

/**
 * Produces the only provider-facing projection of a grounded context.
 * Raw source URLs, external IDs, provider labels, source keys and source contexts never enter it.
 */
export function buildNarrativeModelView(context: GroundedOptionContext): NarrativeModelView {
  if (context.version !== GROUNDED_OPTION_CONTEXT_VERSION) {
    invalidModelView(
      `Narrative model view requires exact ${GROUNDED_OPTION_CONTEXT_VERSION} input.`,
    );
  }
  const projectedFacts = context.facts.map(projectFact);
  if (new Set(projectedFacts.map(({ key }) => key)).size !== projectedFacts.length) {
    invalidModelView('Narrative model-view fact keys must remain unique after projection.');
  }
  const fingerprintBasis: JsonObject = {
    version: NARRATIVE_MODEL_VIEW_VERSION,
    groundedContextVersion: requireSafeMetadata(context.version, 'groundedContextVersion'),
    groundedContextFingerprint: requireFingerprint(
      context.fingerprint,
      'groundedContextFingerprint',
    ),
    planningRun: {
      id: requireSafeMetadata(context.planningRun.id, 'planningRun.id'),
      requestFingerprint: requireFingerprint(
        context.planningRun.requestFingerprint,
        'planningRun.requestFingerprint',
      ),
      currencyContractVersion: requireSafeMetadata(
        context.planningRun.currencyContractVersion,
        'planningRun.currencyContractVersion',
      ),
      providerFixtureVersion: requireSafeMetadata(
        context.planningRun.providerFixtureVersion,
        'planningRun.providerFixtureVersion',
      ),
      engineVersion: requireSafeMetadata(
        context.planningRun.engineVersion,
        'planningRun.engineVersion',
      ),
      scoringVersion: requireSafeMetadata(
        context.planningRun.scoringVersion,
        'planningRun.scoringVersion',
      ),
    },
    rankedOption: {
      id: requireSafeMetadata(context.rankedOption.id, 'rankedOption.id'),
      rank: context.rankedOption.rank,
      role: requireSafeMetadata(context.rankedOption.role, 'rankedOption.role'),
    },
    facts: projectedFacts,
    sourceSnapshots: context.sourceSnapshots.map((source): NarrativeModelSource => ({
      id: requireSafeMetadata(source.id, 'sourceSnapshots.id'),
      fetchedAt: requireFetchedAt(source.fetchedAt),
      freshnessType: requireFreshness(source.freshnessType),
      currency: requireSafeMetadata(source.currency, 'sourceSnapshots.currency'),
      fixtureVersion: requireSafeMetadata(source.fixtureVersion, 'sourceSnapshots.fixtureVersion'),
      demonstrationData:
        typeof source.demonstrationData === 'boolean'
          ? source.demonstrationData
          : invalidModelView('Narrative model-view demonstrationData must be boolean.'),
    })),
  };
  assertSize(fingerprintBasis);
  const result: NarrativeModelView = {
    ...fingerprintBasis,
    version: NARRATIVE_MODEL_VIEW_VERSION,
    fingerprint: createInputFingerprint(fingerprintBasis),
  } as NarrativeModelView;
  assertSize(result);
  return deepFreeze(result);
}

/** Values intentionally excluded from model inputs and forbidden in generated text. */
export function collectNarrativeExcludedValues(
  context: GroundedOptionContext,
): ReadonlySet<string> {
  const allowedStrings = new Set<string>();
  const collectAllStrings = (value: JsonValue): void => {
    if (typeof value === 'string') {
      allowedStrings.add(value);
      return;
    }
    if (value === null || typeof value === 'boolean' || typeof value === 'number') return;
    if (isJsonArray(value)) {
      for (const item of value) collectAllStrings(item);
      return;
    }
    for (const [key, fieldValue] of Object.entries(value)) {
      allowedStrings.add(key);
      collectAllStrings(fieldValue);
    }
  };
  collectAllStrings(buildNarrativeModelView(context));

  const values = new Set<string>();
  for (const source of context.sourceSnapshots) {
    for (const value of [
      source.sourceUrl,
      source.externalItemId,
      source.provider,
      source.sourceKey,
      source.contexts,
    ]) {
      const normalized = value.trim();
      if (normalized.length >= 4 && !allowedStrings.has(normalized)) values.add(normalized);
    }
  }
  const collectUnsafeStrings = (value: JsonValue): void => {
    if (typeof value === 'string') {
      const normalized = value.trim();
      if (
        normalized.length >= 4 &&
        !allowedStrings.has(normalized) &&
        sanitizeString(normalized) !== normalized
      ) {
        values.add(normalized);
      }
      return;
    }
    if (value === null || typeof value === 'boolean' || typeof value === 'number') return;
    if (isJsonArray(value)) {
      for (const item of value) collectUnsafeStrings(item);
      return;
    }
    for (const fieldValue of Object.values(value)) collectUnsafeStrings(fieldValue);
  };
  for (const fact of context.facts) collectUnsafeStrings(fact.value);
  return values;
}
