import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { canonicalizeJson, createInputFingerprint, type JsonValue } from '../ai/contracts.ts';
import { NARRATIVE_QUALITY_DATASET_VERSION, narrativeQualityDatasetSchema } from './dataset.ts';

export const NARRATIVE_QUALITY_SCHEMA_PARITY_VERSION = 'narrative-quality-schema-parity-v1';

type JsonObject = Record<string, JsonValue>;

export interface NarrativeQualitySchemaParityEvidence {
  readonly parityVersion: typeof NARRATIVE_QUALITY_SCHEMA_PARITY_VERSION;
  readonly datasetVersion: typeof NARRATIVE_QUALITY_DATASET_VERSION;
  readonly checkedInFingerprint: string;
  readonly runtimeFingerprint: string;
  readonly canonicalBytes: number;
}

export class NarrativeQualitySchemaParityError extends Error {
  readonly code = 'NARRATIVE_QUALITY_SCHEMA_PARITY_MISMATCH';

  constructor(message: string) {
    super(message);
    this.name = 'NarrativeQualitySchemaParityError';
  }
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseJsonSchema(input: string): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input) as unknown;
  } catch {
    throw new NarrativeQualitySchemaParityError('The checked-in JSON Schema is unreadable.');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new NarrativeQualitySchemaParityError('The checked-in JSON Schema is not an object.');
  }
  return parsed as JsonObject;
}

export function loadCheckedInNarrativeQualitySchema(
  schemaUrl: URL = new URL('../../evals/schemas/narrative-quality-v2.schema.json', import.meta.url),
): JsonObject {
  try {
    return parseJsonSchema(readFileSync(schemaUrl, 'utf8'));
  } catch (error) {
    if (error instanceof NarrativeQualitySchemaParityError) throw error;
    throw new NarrativeQualitySchemaParityError('The checked-in JSON Schema is unreadable.');
  }
}

export function createRuntimeNarrativeQualitySchema(): JsonObject {
  return z.toJSONSchema(narrativeQualityDatasetSchema) as JsonObject;
}

function decodeJsonPointerToken(token: string): string {
  return token.replaceAll('~1', '/').replaceAll('~0', '~');
}

function resolveLocalReference(root: JsonObject, reference: string): JsonValue {
  if (!reference.startsWith('#/')) {
    throw new NarrativeQualitySchemaParityError('Only local JSON Schema references are allowed.');
  }
  let current: JsonValue = root;
  for (const token of reference.slice(2).split('/').map(decodeJsonPointerToken)) {
    if (!isJsonObject(current) || !(token in current)) {
      throw new NarrativeQualitySchemaParityError('A checked-in JSON Schema reference is invalid.');
    }
    current = current[token]!;
  }
  return current;
}

function dereferenceSchema(
  root: JsonObject,
  value: JsonValue,
  activeReferences: ReadonlySet<string> = new Set(),
): JsonValue {
  if (Array.isArray(value)) {
    return value.map((entry) => dereferenceSchema(root, entry, activeReferences));
  }
  if (!isJsonObject(value)) return value;

  const reference = value.$ref;
  if (typeof reference === 'string') {
    if (activeReferences.has(reference)) {
      throw new NarrativeQualitySchemaParityError(
        'Recursive JSON Schema references are unsupported.',
      );
    }
    const nextReferences = new Set(activeReferences);
    nextReferences.add(reference);
    const resolved = dereferenceSchema(
      root,
      resolveLocalReference(root, reference),
      nextReferences,
    );
    if (!isJsonObject(resolved)) {
      throw new NarrativeQualitySchemaParityError(
        'A JSON Schema reference did not resolve to an object.',
      );
    }
    const siblings = Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== '$ref')
        .map(([key, child]) => [key, dereferenceSchema(root, child, activeReferences)]),
    ) as JsonObject;
    return { ...resolved, ...siblings };
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      dereferenceSchema(root, child, activeReferences),
    ]),
  ) as JsonObject;
}

function jsonType(value: JsonValue): 'boolean' | 'number' | 'string' | null {
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'string') return 'string';
  return null;
}

function normalizedInferredType(schema: JsonObject): string | null {
  if (schema.const !== undefined) return jsonType(schema.const);
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    const types = new Set(schema.enum.map(jsonType));
    if (types.size === 1) return [...types][0] ?? null;
  }
  return null;
}

function isTautologicalStringPropertyNames(value: JsonValue): boolean {
  return isJsonObject(value) && Object.keys(value).length === 1 && value.type === 'string';
}

function normalizeSchemaNode(value: JsonValue, isRoot = false): JsonValue {
  if (Array.isArray(value)) return value.map((entry) => normalizeSchemaNode(entry));
  if (!isJsonObject(value)) return value;

  const normalized: JsonObject = {};
  for (const [key, child] of Object.entries(value)) {
    if (isRoot && ['$schema', '$id', 'title', '$defs'].includes(key)) continue;
    if (key === 'minItems' && child === 0) continue;
    if (key === 'propertyNames' && isTautologicalStringPropertyNames(child)) continue;
    normalized[key] = normalizeSchemaNode(child);
  }
  const inferredType = normalizedInferredType(normalized);
  if (normalized.type === undefined && inferredType !== null) normalized.type = inferredType;
  return normalized;
}

export function normalizeNarrativeQualitySchema(schema: JsonObject): JsonValue {
  const dereferenced = dereferenceSchema(schema, schema);
  return normalizeSchemaNode(dereferenced, true);
}

export function verifyNarrativeQualitySchemaParity(
  checkedInSchema: JsonObject = loadCheckedInNarrativeQualitySchema(),
  runtimeSchema: JsonObject = createRuntimeNarrativeQualitySchema(),
): NarrativeQualitySchemaParityEvidence {
  const checkedIn = normalizeNarrativeQualitySchema(checkedInSchema);
  const runtime = normalizeNarrativeQualitySchema(runtimeSchema);
  const checkedInCanonical = canonicalizeJson(checkedIn);
  const runtimeCanonical = canonicalizeJson(runtime);
  const checkedInFingerprint = createInputFingerprint(checkedIn);
  const runtimeFingerprint = createInputFingerprint(runtime);
  if (checkedInCanonical !== runtimeCanonical || checkedInFingerprint !== runtimeFingerprint) {
    throw new NarrativeQualitySchemaParityError(
      'Runtime Zod and the frozen narrative-quality JSON Schema differ.',
    );
  }
  return {
    parityVersion: NARRATIVE_QUALITY_SCHEMA_PARITY_VERSION,
    datasetVersion: NARRATIVE_QUALITY_DATASET_VERSION,
    checkedInFingerprint,
    runtimeFingerprint,
    canonicalBytes: Buffer.byteLength(checkedInCanonical, 'utf8'),
  };
}
