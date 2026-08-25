import {
  canonicalizeJson,
  createInputFingerprint,
  type JsonObject,
  type JsonValue,
} from '../ai/contracts.ts';
import { DomainError } from '../domain/domain-error.ts';
import type { GroundedOptionContext } from './grounded-option-context.ts';
import {
  buildNarrativeModelView,
  type NarrativeModelFact,
  type NarrativeModelView,
} from './narrative-model-view.ts';

export const NARRATIVE_GENERATION_VIEW_VERSION = 'narrative-generation-view-v1';
export const NARRATIVE_GENERATION_VIEW_MAX_BYTES = 48 * 1024;

const PROVENANCE_FACT_KEY_PREFIX = 'provenance.';
const SOURCE_OWNED_STRING_FIELDS = [
  'id',
  'sourceKey',
  'provider',
  'externalItemId',
  'fetchedAt',
  'sourceUrl',
  'freshnessType',
  'fixtureVersion',
  'contexts',
] as const;
const SOURCE_OWNED_FIELD_NAMES = new Set([
  'contexts',
  'demonstrationdata',
  'externalitemid',
  'fetchedat',
  'fixtureversion',
  'freshnesstype',
  'provider',
  'sourcekey',
  'sourcesnapshotid',
  'sourcesnapshotids',
  'sourceurl',
]);

export type NarrativeGenerationFact = JsonObject & {
  readonly factId: string;
  readonly key: string;
  readonly status: 'KNOWN';
  readonly value: JsonValue;
};

export type NarrativeGenerationView = JsonObject & {
  readonly version: typeof NARRATIVE_GENERATION_VIEW_VERSION;
  readonly fingerprint: string;
  readonly groundedContextVersion: string;
  readonly groundedContextFingerprint: string;
  readonly rankedOption: JsonObject & {
    readonly rank: number;
    readonly role: string;
  };
  readonly facts: readonly NarrativeGenerationFact[];
};

function invalidGenerationView(message: string): never {
  throw new DomainError('INVALID_NARRATIVE_GENERATION_VIEW', message);
}

function isJsonArray(value: JsonValue): value is readonly JsonValue[] {
  return Array.isArray(value);
}

function removeSourceOwnedFields(value: JsonValue): JsonValue {
  if (value === null || typeof value !== 'object') return value;
  if (isJsonArray(value)) return value.map((item) => removeSourceOwnedFields(item));

  const result: Record<string, JsonValue> = {};
  for (const key of Object.keys(value).sort((left, right) => left.localeCompare(right, 'en'))) {
    if (SOURCE_OWNED_FIELD_NAMES.has(key.toLowerCase())) continue;
    const nested = value[key];
    if (nested === undefined) {
      invalidGenerationView(`Generation fact field ${key} is not JSON-serializable.`);
    }
    result[key] = removeSourceOwnedFields(nested);
  }
  return result;
}

function projectKnownFact(fact: NarrativeModelFact): NarrativeGenerationFact | null {
  if (fact.status !== 'KNOWN' || fact.key.startsWith(PROVENANCE_FACT_KEY_PREFIX)) return null;
  return {
    factId: fact.factId,
    key: fact.key,
    status: 'KNOWN',
    value: removeSourceOwnedFields(fact.value),
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
  if (Buffer.byteLength(canonicalizeJson(value), 'utf8') > NARRATIVE_GENERATION_VIEW_MAX_BYTES) {
    invalidGenerationView(
      `Narrative generation view exceeds the ${NARRATIVE_GENERATION_VIEW_MAX_BYTES}-byte v1 limit.`,
    );
  }
}

function collectSourceOwnedStrings(context: GroundedOptionContext): ReadonlySet<string> {
  const excluded = new Set<string>();
  for (const source of context.sourceSnapshots) {
    for (const field of SOURCE_OWNED_STRING_FIELDS) {
      const value = source[field];
      if (value.length > 0) excluded.add(value);
    }
  }
  return excluded;
}

/**
 * Compares decoded JSON strings instead of serialized bytes, so quotes, backslashes and line breaks
 * cannot bypass the guard through JSON escaping. Object names are strings too: a source-owned
 * identifier must not be projected as a dynamic nested key.
 */
function containsSourceOwnedString(value: JsonValue, excluded: readonly string[]): boolean {
  if (typeof value === 'string') {
    return excluded.some((excludedValue) => value.includes(excludedValue));
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return false;
  if (isJsonArray(value)) {
    return value.some((item) => containsSourceOwnedString(item, excluded));
  }
  return Object.entries(value).some(
    ([key, nested]) =>
      excluded.some((excludedValue) => key.includes(excludedValue)) ||
      containsSourceOwnedString(nested, excluded),
  );
}

/**
 * Builds the only GENERATE-provider projection. The full model view remains available locally and
 * to JUDGE, while provenance and non-KNOWN facts stay exclusively in deterministic code.
 */
export function buildNarrativeGenerationView(
  context: GroundedOptionContext,
  modelView: NarrativeModelView = buildNarrativeModelView(context),
): NarrativeGenerationView {
  const expectedModelView = buildNarrativeModelView(context);
  if (canonicalizeJson(modelView) !== canonicalizeJson(expectedModelView)) {
    invalidGenerationView(
      'The narrative model view does not belong to the exact grounded context.',
    );
  }

  const facts = modelView.facts.flatMap((fact) => {
    const projected = projectKnownFact(fact);
    return projected === null ? [] : [projected];
  });
  if (facts.length === 0) {
    invalidGenerationView('The narrative generation view contains no narratable KNOWN facts.');
  }

  const fingerprintBasis: JsonObject = {
    version: NARRATIVE_GENERATION_VIEW_VERSION,
    groundedContextVersion: context.version,
    groundedContextFingerprint: context.fingerprint,
    rankedOption: {
      rank: context.rankedOption.rank,
      role: context.rankedOption.role,
    },
    facts,
  };
  assertSize(fingerprintBasis);
  const result: NarrativeGenerationView = {
    ...fingerprintBasis,
    version: NARRATIVE_GENERATION_VIEW_VERSION,
    fingerprint: createInputFingerprint(fingerprintBasis),
  } as NarrativeGenerationView;
  assertSize(result);

  if (containsSourceOwnedString(result, [...collectSourceOwnedStrings(context)])) {
    invalidGenerationView('The generation view contains a value excluded from provider input.');
  }
  return deepFreeze(result);
}
