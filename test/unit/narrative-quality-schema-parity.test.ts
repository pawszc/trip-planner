import { describe, expect, it } from 'vitest';
import type { JsonValue } from '../../srv/ai/contracts.ts';
import {
  createRuntimeNarrativeQualitySchema,
  loadCheckedInNarrativeQualitySchema,
  verifyNarrativeQualitySchemaParity,
} from '../../srv/evals/schema-parity.ts';

type MutableSchema = { [key: string]: JsonValue };

function objectAt(root: MutableSchema, ...path: string[]): MutableSchema {
  let current: unknown = root;
  for (const segment of path) {
    if (current === null || typeof current !== 'object' || Array.isArray(current)) {
      throw new Error(`Expected an object at ${path.join('.')}.`);
    }
    current = (current as MutableSchema)[segment];
  }
  if (current === null || typeof current !== 'object' || Array.isArray(current)) {
    throw new Error(`Expected an object at ${path.join('.')}.`);
  }
  return current as MutableSchema;
}

function arrayAt(root: MutableSchema, ...path: string[]): unknown[] {
  const parent = objectAt(root, ...path.slice(0, -1));
  const value = parent[path.at(-1)!];
  if (!Array.isArray(value)) throw new Error(`Expected an array at ${path.join('.')}.`);
  return value;
}

function changedCheckedInSchema(change: (schema: MutableSchema) => void): MutableSchema {
  const schema = structuredClone(loadCheckedInNarrativeQualitySchema()) as MutableSchema;
  change(schema);
  return schema;
}

describe('narrative-quality JSON Schema parity', () => {
  it('matches the frozen checked-in schema to the runtime Zod contract', () => {
    const evidence = verifyNarrativeQualitySchemaParity();

    expect(evidence.checkedInFingerprint).toBe(evidence.runtimeFingerprint);
    expect(evidence.canonicalBytes).toBeGreaterThan(0);
  });

  it.each([
    {
      label: 'missing required property',
      change: (schema: MutableSchema) => arrayAt(schema, 'required').pop(),
    },
    {
      label: 'additional property',
      change: (schema: MutableSchema) => {
        objectAt(schema, 'properties').unreviewed = { type: 'boolean' };
      },
    },
    {
      label: 'enum change',
      change: (schema: MutableSchema) => arrayAt(schema, '$defs', 'dimension', 'enum').pop(),
    },
    {
      label: 'minimum change',
      change: (schema: MutableSchema) => {
        objectAt(schema, '$defs', 'constraintSnapshot', 'properties', 'adults').minimum = 2;
      },
    },
    {
      label: 'maximum change',
      change: (schema: MutableSchema) => {
        objectAt(schema, '$defs', 'block', 'properties', 'text').maxLength = 1_199;
      },
    },
    {
      label: 'strictness change',
      change: (schema: MutableSchema) => {
        objectAt(schema, '$defs', 'case').additionalProperties = true;
      },
    },
    {
      label: 'case-count change',
      change: (schema: MutableSchema) => {
        objectAt(schema, 'properties', 'cases').maxItems = 31;
      },
    },
    {
      label: 'context-count change',
      change: (schema: MutableSchema) => {
        objectAt(schema, 'properties', 'contexts').minItems = 3;
      },
    },
    {
      label: 'literal version change',
      change: (schema: MutableSchema) => {
        objectAt(schema, 'properties', 'datasetVersion').const = 'narrative-quality-v3';
      },
    },
    {
      label: 'nested requiredProperties change',
      change: (schema: MutableSchema) => {
        objectAt(schema, '$defs', 'endToEndCase', 'properties', 'requiredProperties').minItems = 2;
      },
    },
  ])('fails closed for a $label', ({ change }) => {
    const checkedIn = changedCheckedInSchema(change);

    expect(() =>
      verifyNarrativeQualitySchemaParity(checkedIn, createRuntimeNarrativeQualitySchema()),
    ).toThrow('Runtime Zod and the frozen narrative-quality JSON Schema differ.');
  });
});
