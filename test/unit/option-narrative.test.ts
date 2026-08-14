import { describe, expect, it } from 'vitest';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { zodTextFormat } from 'openai/helpers/zod';
import { AiTaskType } from '../../srv/ai/contracts.ts';
import {
  buildGroundedOptionContext,
  type GroundedOptionContextInput,
} from '../../srv/narratives/grounded-option-context.ts';
import { buildNarrativePersistenceBundle } from '../../srv/narratives/narrative-persistence.ts';
import {
  OPTION_NARRATIVE_PROMPT_VERSION,
  OPTION_NARRATIVE_SCHEMA_NAME,
  OPTION_NARRATIVE_SCHEMA_VERSION,
  createOptionNarrativeOutputSchema,
  createOptionNarrativeRequest,
  parseOptionNarrativeOutput,
} from '../../srv/narratives/option-narrative.ts';
import { groundedOptionContextInput } from '../fixtures/grounded-option.ts';

function groundedContext() {
  return buildGroundedOptionContext(contextInput());
}

function contextInput(): GroundedOptionContextInput {
  return structuredClone(groundedOptionContextInput);
}

function removeSourceContext(input: GroundedOptionContextInput, removedContext: string): void {
  for (const source of input.sourceSnapshots) {
    source.contexts = source.contexts
      .split(',')
      .map((context) => context.trim())
      .filter((context) => context !== removedContext)
      .join(', ');
  }
}

function makeIncompleteBudget(input: GroundedOptionContextInput): void {
  const food = input.budgetItems.find((item) => item.category === 'FOOD');
  if (food === undefined) throw new Error('Missing FOOD fixture.');
  food.classification = 'UNKNOWN';
  food.priceType = 'UNKNOWN';
  food.amountMinor = null;
  input.budgetItems = input.budgetItems.filter((item) => item.category !== 'ATTRACTIONS');
  removeSourceContext(input, 'BUDGET:ATTRACTIONS');
  input.rankedOption.confirmedAmountMinor = '218000';
  input.rankedOption.estimatedAmountMinor = '70600';
  input.rankedOption.unknownCategoryCount = 2;
  input.rankedOption.totalAmountMinor = null;
  input.rankedOption.costPerPersonMinor = null;
  input.rankedOption.remainingBudgetMinor = null;
}

describe('grounded option narrative contract', () => {
  it('creates a versioned GENERATE request without any routing override', () => {
    const context = groundedContext();
    const request = createOptionNarrativeRequest(context);

    expect(request).toMatchObject({
      taskType: AiTaskType.GENERATE,
      promptVersion: OPTION_NARRATIVE_PROMPT_VERSION,
      schemaVersion: OPTION_NARRATIVE_SCHEMA_VERSION,
      schemaName: OPTION_NARRATIVE_SCHEMA_NAME,
      input: context,
      planningRunId: context.planningRun.id,
    });
    expect(request).not.toHaveProperty('provider');
    expect(request).not.toHaveProperty('model');
    expect(request).not.toHaveProperty('effort');
    expect(request.instructions).toContain('Never calculate');
    expect(request.instructions).toContain('Never divide minor units');
    expect(request.instructions).toContain('display values');
    expect(request.instructions).toContain('UNKNOWN and MISSING');
  });

  it('converts the same strict context-aware schema for both configured provider SDKs offline', () => {
    const context = groundedContext();
    const schema = createOptionNarrativeOutputSchema(context);

    expect(zodTextFormat(schema, OPTION_NARRATIVE_SCHEMA_NAME)).toMatchObject({
      type: 'json_schema',
      name: OPTION_NARRATIVE_SCHEMA_NAME,
      strict: true,
    });
    expect(zodOutputFormat(schema)).toMatchObject({ type: 'json_schema' });
  });

  it('accepts strict blocks whose non-empty references resolve in the exact context', () => {
    const context = groundedContext();
    const destinationFact = context.facts.find((fact) => fact.key === 'option.destination');
    if (destinationFact === undefined) throw new Error('Missing destination fact in fixture.');

    expect(
      parseOptionNarrativeOutput(
        {
          contextFingerprint: context.fingerprint,
          blocks: [
            {
              kind: 'SUMMARY',
              text: 'Praga jest wariantem wybranym przez deterministyczny ranking.',
              factReferences: [destinationFact.factId],
            },
          ],
        },
        context,
      ),
    ).toEqual({
      contextFingerprint: context.fingerprint,
      blocks: [
        {
          kind: 'SUMMARY',
          text: 'Praga jest wariantem wybranym przez deterministyczny ranking.',
          factReferences: [destinationFact.factId],
        },
      ],
    });
  });

  it('allows explicit UNKNOWN and MISSING facts to be cited without inventing values', () => {
    const input = contextInput();
    makeIncompleteBudget(input);
    const context = buildGroundedOptionContext(input);
    const unknownFact = context.facts.find((fact) => fact.key === 'option.budget.category.FOOD');
    if (unknownFact === undefined) throw new Error('Missing UNKNOWN fact.');
    const missingFact = context.facts.find(
      (fact) => fact.key === 'option.budget.category.ATTRACTIONS',
    );
    if (missingFact === undefined) throw new Error('Missing MISSING fact.');

    const parsed = parseOptionNarrativeOutput(
      {
        contextFingerprint: context.fingerprint,
        blocks: [
          {
            kind: 'RISK',
            text: 'Koszt wyżywienia pozostaje nieznany, a koszt atrakcji nie został podany.',
            factReferences: [unknownFact.factId, missingFact.factId],
          },
        ],
      },
      context,
    );

    expect(unknownFact.status).toBe('UNKNOWN');
    expect(missingFact.status).toBe('MISSING');
    expect(parsed.blocks[0]?.factReferences).toEqual([unknownFact.factId, missingFact.factId]);
  });

  it.each([
    [
      'missing factReferences',
      (fingerprint: string) => ({
        contextFingerprint: fingerprint,
        blocks: [{ kind: 'SUMMARY', text: 'Tekst bez referencji.' }],
      }),
    ],
    [
      'empty factReferences',
      (fingerprint: string) => ({
        contextFingerprint: fingerprint,
        blocks: [{ kind: 'SUMMARY', text: 'Tekst bez referencji.', factReferences: [] }],
      }),
    ],
    [
      'unknown fact reference',
      (fingerprint: string) => ({
        contextFingerprint: fingerprint,
        blocks: [
          {
            kind: 'SUMMARY',
            text: 'Tekst z obcą referencją.',
            factReferences: [`fact_${'f'.repeat(64)}`],
          },
        ],
      }),
    ],
    [
      'extra output field',
      (fingerprint: string) => ({
        contextFingerprint: fingerprint,
        blocks: [
          {
            kind: 'SUMMARY',
            text: 'Tekst.',
            factReferences: [`fact_${'f'.repeat(64)}`],
            unsupported: true,
          },
        ],
      }),
    ],
  ])('rejects the complete output for %s', (_name, createOutput) => {
    const context = groundedContext();

    expect(() =>
      parseOptionNarrativeOutput(createOutput(context.fingerprint), context),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_STRUCTURED_OUTPUT' }));
  });

  it('rejects a stale fact ID from another exact context without filtering only that block', () => {
    const context = groundedContext();
    const changedInput = contextInput();
    changedInput.rankedOption.destinationCity = 'Wiedeń';
    const otherContext = buildGroundedOptionContext(changedInput);
    const validFact = context.facts[0];
    const staleFact = otherContext.facts[0];
    if (validFact === undefined || staleFact === undefined)
      throw new Error('Missing fixture fact.');

    expect(() =>
      parseOptionNarrativeOutput(
        {
          contextFingerprint: context.fingerprint,
          blocks: [
            { kind: 'SUMMARY', text: 'Poprawny blok.', factReferences: [validFact.factId] },
            { kind: 'RISK', text: 'Nieaktualny blok.', factReferences: [staleFact.factId] },
          ],
        },
        context,
      ),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_STRUCTURED_OUTPUT' }));
  });

  it('persists only a fully revalidated output with exact planning, option, and AI linkage', () => {
    const context = groundedContext();
    const firstFact = context.facts[0];
    const secondFact = context.facts[1];
    if (firstFact === undefined || secondFact === undefined)
      throw new Error('Missing fixture facts.');
    let generated = 0;
    const generateId = () => `50000000-0000-4000-8000-${String(++generated).padStart(12, '0')}`;
    const aiRunId = '60000000-0000-4000-8000-000000000001';

    const bundle = buildNarrativePersistenceBundle({
      context,
      output: {
        contextFingerprint: context.fingerprint,
        blocks: [
          {
            kind: 'SUMMARY',
            text: 'Ugruntowane podsumowanie.',
            factReferences: [firstFact.factId, secondFact.factId],
          },
        ],
      },
      aiRunId,
      completedAt: '2026-08-13T12:00:00.000Z',
      generateId,
    });

    expect(bundle.expectedAiRun).toMatchObject({
      ID: aiRunId,
      planningRun_ID: context.planningRun.id,
      status: 'SUCCEEDED',
      taskType: 'GENERATE',
      promptVersion: OPTION_NARRATIVE_PROMPT_VERSION,
      schemaVersion: OPTION_NARRATIVE_SCHEMA_VERSION,
    });
    expect(bundle.expectedAiRun.inputFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(bundle.narrativeRun).toMatchObject({
      ID: '50000000-0000-4000-8000-000000000001',
      planningRun_ID: context.planningRun.id,
      rankedOption_ID: context.rankedOption.id,
      aiRunId,
      status: 'SUCCEEDED',
      contextVersion: context.version,
      contextFingerprint: context.fingerprint,
      promptVersion: OPTION_NARRATIVE_PROMPT_VERSION,
      schemaVersion: OPTION_NARRATIVE_SCHEMA_VERSION,
      blockCount: 1,
    });
    expect(bundle.optionNarratives).toHaveLength(1);
    expect(bundle.factReferences).toMatchObject([
      { sequence: 1, factId: firstFact.factId },
      { sequence: 2, factId: secondFact.factId },
    ]);
    expect(bundle.optionNarratives[0]).not.toHaveProperty('aiRun_ID');
    expect(bundle.factReferences.every((reference) => !('aiRun_ID' in reference))).toBe(true);
  });
});
