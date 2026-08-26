import { describe, expect, it } from 'vitest';
import {
  canonicalizeJson,
  validateBoundStructuredAiOutput,
  validateStructuredAiOutput,
} from '../../srv/ai/contracts.ts';
import {
  buildGroundedOptionContext,
  type GroundedOptionContextInput,
} from '../../srv/narratives/grounded-option-context.ts';
import {
  buildMandatoryNarrativeBlocks,
  finalizeNarrativeOutput,
  OPTION_NARRATIVE_FINAL_MAX_BLOCKS,
  OPTION_NARRATIVE_PROVIDER_MAX_BLOCKS,
  validateFinalizedNarrative,
} from '../../srv/narratives/narrative-finalization.ts';
import {
  buildNarrativeGenerationView,
  NARRATIVE_GENERATION_VIEW_MAX_BYTES,
  NARRATIVE_GENERATION_VIEW_VERSION,
} from '../../srv/narratives/narrative-generation-view.ts';
import { buildNarrativeModelView } from '../../srv/narratives/narrative-model-view.ts';
import { runNarrativeSafetyPrecheck } from '../../srv/narratives/narrative-safety-precheck.ts';
import {
  createOptionNarrativeRequest,
  optionNarrativeProviderOutputSchema,
  type OptionNarrativeBlock,
} from '../../srv/narratives/option-narrative.ts';
import { groundedOptionContextInput } from '../fixtures/grounded-option.ts';

function completeContext() {
  return buildGroundedOptionContext(groundedOptionContextInput);
}

function generatedBlock(context = completeContext()): OptionNarrativeBlock {
  const generationView = buildNarrativeGenerationView(context);
  const destination = generationView.facts.find((fact) => fact.key === 'option.destination');
  if (destination === undefined) throw new Error('Test fixture has no destination fact.');
  return {
    kind: 'SUMMARY',
    text: 'Praga jest wybraną destynacją tej opcji.',
    factReferences: [destination.factId],
  };
}

function unknownMissingContext(externalItemId?: string) {
  const input: GroundedOptionContextInput = structuredClone(groundedOptionContextInput);
  input.rankedOption.confirmedAmountMinor = '218000';
  input.rankedOption.estimatedAmountMinor = '70600';
  input.rankedOption.unknownCategoryCount = 2;
  input.rankedOption.totalAmountMinor = null;
  input.rankedOption.costPerPersonMinor = null;
  input.rankedOption.remainingBudgetMinor = null;
  input.budgetItems = input.budgetItems
    .filter((item) => item.category !== 'ATTRACTIONS')
    .map((item) =>
      item.category === 'FOOD'
        ? {
            ...item,
            sourceSnapshot_ID: null,
            priceType: 'UNKNOWN' as const,
            classification: 'UNKNOWN' as const,
            amountMinor: null,
            confirmedAmountMinor: '0',
            estimatedAmountMinor: '0',
          }
        : item,
    );
  input.sourceSnapshots = input.sourceSnapshots.map((source) => ({
    ...source,
    contexts: source.contexts
      .split(', ')
      .filter((context) => context !== 'BUDGET:FOOD' && context !== 'BUDGET:ATTRACTIONS')
      .join(', '),
  }));
  if (externalItemId !== undefined) input.sourceSnapshots[0]!.externalItemId = externalItemId;
  return buildGroundedOptionContext(input);
}

function contextWithUnavailableBudgetCost(
  category: 'TRANSPORT' | 'ACCOMMODATION',
  status: 'UNKNOWN' | 'MISSING',
  externalItemId?: string,
) {
  const input: GroundedOptionContextInput = structuredClone(groundedOptionContextInput);
  if (status === 'MISSING') {
    input.budgetItems = input.budgetItems.filter((item) => item.category !== category);
  } else {
    const item = input.budgetItems.find((candidate) => candidate.category === category);
    if (item === undefined) throw new Error(`Missing ${category} budget fixture.`);
    item.sourceSnapshot_ID = null;
    item.priceType = 'UNKNOWN';
    item.classification = 'UNKNOWN';
    item.amountMinor = null;
    item.confirmedAmountMinor = '0';
    item.estimatedAmountMinor = '0';
  }
  input.rankedOption.confirmedAmountMinor = category === 'TRANSPORT' ? '98000' : '120000';
  input.rankedOption.estimatedAmountMinor = '262600';
  input.rankedOption.unknownCategoryCount = 1;
  input.rankedOption.totalAmountMinor = null;
  input.rankedOption.costPerPersonMinor = null;
  input.rankedOption.remainingBudgetMinor = null;
  input.sourceSnapshots = input.sourceSnapshots.map((source) => ({
    ...source,
    contexts: source.contexts
      .split(', ')
      .filter((context) => context !== `BUDGET:${category}`)
      .join(', '),
  }));
  if (externalItemId !== undefined) input.sourceSnapshots[0]!.externalItemId = externalItemId;
  return buildGroundedOptionContext(input);
}

describe('generation-only narrative view', () => {
  it('is deterministic, fingerprinted, bounded, and contains only narratable KNOWN facts', () => {
    const context = completeContext();
    const first = buildNarrativeGenerationView(context);
    const second = buildNarrativeGenerationView(context, buildNarrativeModelView(context));
    const serialized = canonicalizeJson(first);

    expect(first).toEqual(second);
    expect(first.version).toBe(NARRATIVE_GENERATION_VIEW_VERSION);
    expect(first.fingerprint).toMatch(/^[0-9a-f]{64}$/u);
    expect(Buffer.byteLength(serialized, 'utf8')).toBeLessThanOrEqual(
      NARRATIVE_GENERATION_VIEW_MAX_BYTES,
    );
    expect(first.facts.every((fact) => fact.status === 'KNOWN')).toBe(true);
    expect(first.facts.some((fact) => fact.key.startsWith('provenance.'))).toBe(false);
    expect(serialized).not.toContain('sourceSnapshots');
    expect(serialized).not.toContain('sourceSnapshotId');
    expect(serialized).not.toContain('REFERENCE_FIXTURE');
    expect(serialized).not.toContain('prague-option');
    expect(serialized).not.toContain('UNKNOWN');
    expect(serialized).not.toContain('MISSING');
  });

  it('removes every non-KNOWN fact from the provider-visible view', () => {
    const context = unknownMissingContext();
    const generationView = buildNarrativeGenerationView(context);
    const nonKnownIds = new Set(
      context.facts.filter((fact) => fact.status !== 'KNOWN').map((fact) => fact.factId),
    );

    expect(nonKnownIds.size).toBeGreaterThan(0);
    expect(generationView.facts.some((fact) => nonKnownIds.has(fact.factId))).toBe(false);
  });
});

describe('provider transport and deterministic narrative finalization', () => {
  it('uses a blocks-only provider schema and injects the exact context fingerprint locally', () => {
    const context = completeContext();
    const modelView = buildNarrativeModelView(context);
    const generationView = buildNarrativeGenerationView(context, modelView);
    const request = createOptionNarrativeRequest(context, modelView, generationView);
    const providerOutput = { blocks: [generatedBlock(context)] };
    const result = validateStructuredAiOutput(request, providerOutput);

    expect(request.input).toEqual(generationView);
    expect(request.providerOutputSchema).toBe(optionNarrativeProviderOutputSchema);
    expect(Object.keys(providerOutput)).toEqual(['blocks']);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.output.contextFingerprint).toBe(context.fingerprint);
    expect(result.output.blocks[0]).toEqual(providerOutput.blocks[0]);
    expect(result.output.blocks).toHaveLength(2);
    expect(result.output.blocks[1]?.kind).toBe('RISK');
    expect(result.output.blocks[1]?.text).toContain('demonstrative fixture/test data');
  });

  it('rejects provider attempts to set the code-owned fingerprint or exceed six blocks', () => {
    const context = completeContext();
    const block = generatedBlock(context);
    const request = createOptionNarrativeRequest(context);

    expect(
      validateStructuredAiOutput(request, {
        contextFingerprint: context.fingerprint,
        blocks: [block],
      }),
    ).toEqual({ success: false, validationFailureStage: 'TRANSPORT_SCHEMA_VALIDATION' });
    expect(
      optionNarrativeProviderOutputSchema.safeParse({
        blocks: Array.from({ length: OPTION_NARRATIVE_PROVIDER_MAX_BLOCKS + 1 }, () => block),
      }).success,
    ).toBe(false);
    expect(OPTION_NARRATIVE_PROVIDER_MAX_BLOCKS).toBe(6);
    expect(OPTION_NARRATIVE_FINAL_MAX_BLOCKS).toBe(8);
  });

  it('allows exact cited transport facts when the separate transport cost is UNKNOWN', () => {
    const context = contextWithUnavailableBudgetCost('TRANSPORT', 'UNKNOWN', 'TRAIN');
    const modelView = buildNarrativeModelView(context);
    const generationView = buildNarrativeGenerationView(context, modelView);
    const transport = generationView.facts.find((fact) => fact.key === 'option.transport');
    if (transport === undefined) throw new Error('Missing transport generation fact.');
    const block: OptionNarrativeBlock = {
      kind: 'ADVANTAGE',
      text: 'This trip includes direct TRAIN transport departing at 2026-10-10T06:30:00.000Z, with 0 connections and 255 travel minutes.',
      factReferences: [transport.factId],
    };

    const finalized = finalizeNarrativeOutput({
      context,
      modelView,
      generationView,
      providerBlocks: [block],
    });

    expect(finalized.blocks[0]).toEqual(block);
    expect(finalized.blocks.at(-1)?.text).toContain('transport cost');
  });

  it('allows exact cited accommodation facts when the separate accommodation cost is MISSING', () => {
    const context = contextWithUnavailableBudgetCost('ACCOMMODATION', 'MISSING');
    const modelView = buildNarrativeModelView(context);
    const generationView = buildNarrativeGenerationView(context, modelView);
    const accommodation = generationView.facts.find((fact) => fact.key === 'option.accommodation');
    if (accommodation === undefined) throw new Error('Missing accommodation generation fact.');
    const block: OptionNarrativeBlock = {
      kind: 'ADVANTAGE',
      text: 'Hotel accommodation is Central Prague Hotel from 2026-10-10 for 3 nights.',
      factReferences: [accommodation.factId],
    };

    const finalized = finalizeNarrativeOutput({
      context,
      modelView,
      generationView,
      providerBlocks: [block],
    });

    expect(finalized.blocks[0]).toEqual(block);
    expect(finalized.blocks.at(-1)?.text).toContain('accommodation cost');
  });

  it('allows exact cited destination prose despite unrelated non-KNOWN budget facts', () => {
    const context = unknownMissingContext('PRG');
    const modelView = buildNarrativeModelView(context);
    const generationView = buildNarrativeGenerationView(context, modelView);
    const destination = generationView.facts.find((fact) => fact.key === 'option.destination');
    if (destination === undefined) throw new Error('Missing destination generation fact.');
    const block: OptionNarrativeBlock = {
      kind: 'SUMMARY',
      text: "This trip's destination is Praga (PRG).",
      factReferences: [destination.factId],
    };

    const finalized = finalizeNarrativeOutput({
      context,
      modelView,
      generationView,
      providerBlocks: [block],
    });

    expect(finalized.blocks[0]).toEqual(block);
  });

  it('allows broad transport nouns without a value/status assertion when its cost is UNKNOWN', () => {
    const context = contextWithUnavailableBudgetCost('TRANSPORT', 'UNKNOWN');
    const modelView = buildNarrativeModelView(context);
    const generationView = buildNarrativeGenerationView(context, modelView);
    const transport = generationView.facts.find((fact) => fact.key === 'option.transport');
    if (transport === undefined) throw new Error('Missing transport generation fact.');
    const block: OptionNarrativeBlock = {
      kind: 'ADVANTAGE',
      text: 'The trip uses direct TRAIN transport, while local transport is a separate itinerary detail.',
      factReferences: [transport.factId],
    };

    expect(
      finalizeNarrativeOutput({
        context,
        modelView,
        generationView,
        providerBlocks: [block],
      }).blocks[0],
    ).toEqual(block);
  });

  it('allows confirmation of an exact cited CONFIRMED category value', () => {
    const context = completeContext();
    const modelView = buildNarrativeModelView(context);
    const generationView = buildNarrativeGenerationView(context, modelView);
    const transportCost = generationView.facts.find(
      (fact) => fact.key === 'option.budget.category.TRANSPORT',
    );
    const amountDisplay =
      transportCost !== undefined &&
      transportCost.value !== null &&
      typeof transportCost.value === 'object' &&
      !Array.isArray(transportCost.value)
        ? (transportCost.value as { readonly amountDisplay?: unknown }).amountDisplay
        : undefined;
    if (transportCost === undefined || typeof amountDisplay !== 'string') {
      throw new Error('Missing exact transport amount display.');
    }
    const block: OptionNarrativeBlock = {
      kind: 'SUMMARY',
      text: `Transport pricing is confirmed at ${amountDisplay}.`,
      factReferences: [transportCost.factId],
    };

    expect(
      finalizeNarrativeOutput({
        context,
        modelView,
        generationView,
        providerBlocks: [block],
      }).blocks[0],
    ).toEqual(block);
  });

  it('rejects an availability assertion even when every grounded fact is KNOWN', () => {
    const context = completeContext();
    const modelView = buildNarrativeModelView(context);
    const generationView = buildNarrativeGenerationView(context, modelView);
    const accommodation = generationView.facts.find((fact) => fact.key === 'option.accommodation');
    if (accommodation === undefined) throw new Error('Missing accommodation generation fact.');

    expect(() =>
      finalizeNarrativeOutput({
        context,
        modelView,
        generationView,
        providerBlocks: [
          {
            kind: 'SUMMARY',
            text: 'The hotel is available.',
            factReferences: [accommodation.factId],
          },
        ],
      }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_NARRATIVE_FINALIZATION' }));
  });

  it('rejects confirmed-price wording for an exact cited KNOWN-but-ESTIMATED category', () => {
    const context = completeContext();
    const modelView = buildNarrativeModelView(context);
    const generationView = buildNarrativeGenerationView(context, modelView);
    const foodCost = generationView.facts.find(
      (fact) => fact.key === 'option.budget.category.FOOD',
    );
    const amountDisplay =
      foodCost !== undefined &&
      foodCost.value !== null &&
      typeof foodCost.value === 'object' &&
      !Array.isArray(foodCost.value)
        ? (foodCost.value as { readonly amountDisplay?: unknown }).amountDisplay
        : undefined;
    if (foodCost === undefined || typeof amountDisplay !== 'string') {
      throw new Error('Missing estimated food-cost generation fact.');
    }

    for (const text of [
      'Food pricing is confirmed.',
      `Food price ${amountDisplay} is confirmed.`,
    ]) {
      expect(() =>
        finalizeNarrativeOutput({
          context,
          modelView,
          generationView,
          providerBlocks: [
            {
              kind: 'SUMMARY',
              text,
              factReferences: [foodCost.factId],
            },
          ],
        }),
      ).toThrowError(expect.objectContaining({ code: 'INVALID_NARRATIVE_FINALIZATION' }));
    }
  });

  it('keeps TRANSPORT UNKNOWN bound to its own clause when LOCAL_TRANSPORT is also mentioned', () => {
    const context = contextWithUnavailableBudgetCost('TRANSPORT', 'UNKNOWN');
    const modelView = buildNarrativeModelView(context);
    const generationView = buildNarrativeGenerationView(context, modelView);
    const transport = generationView.facts.find((fact) => fact.key === 'option.transport');
    if (transport === undefined) throw new Error('Missing transport generation fact.');

    expect(() =>
      finalizeNarrativeOutput({
        context,
        modelView,
        generationView,
        providerBlocks: [
          {
            kind: 'SUMMARY',
            text: 'Transport pricing is confirmed, while local transport is convenient.',
            factReferences: [transport.factId],
          },
        ],
      }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_NARRATIVE_FINALIZATION' }));
  });

  it.each([
    ['English source provider', 'The source provider is TRAIN.'],
    ['English plain provider', 'The provider is TRAIN.'],
    ['Polish source provider', 'Dostawca źródła to TRAIN.'],
    ['Polish plain provider', 'Dostawca to TRAIN.'],
  ])('rejects explicit source framing despite a cited TRAIN collision: %s', (_name, text) => {
    const input: GroundedOptionContextInput = structuredClone(groundedOptionContextInput);
    input.sourceSnapshots[0]!.provider = 'TRAIN';
    const context = buildGroundedOptionContext(input);
    const modelView = buildNarrativeModelView(context);
    const generationView = buildNarrativeGenerationView(context, modelView);
    const transport = generationView.facts.find((fact) => fact.key === 'option.transport');
    if (transport === undefined) throw new Error('Missing transport generation fact.');

    expect(() =>
      finalizeNarrativeOutput({
        context,
        modelView,
        generationView,
        providerBlocks: [{ kind: 'SUMMARY', text, factReferences: [transport.factId] }],
      }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_NARRATIVE_FINALIZATION' }));
  });

  it.each([
    ['English source key', 'The source key is PRG.'],
    ['exact sourceKey field label', 'sourceKey is PRG.'],
    ['Polish source key', 'Klucz źródła to PRG.'],
  ])('rejects explicit source-key framing despite a cited PRG collision: %s', (_name, text) => {
    const input: GroundedOptionContextInput = structuredClone(groundedOptionContextInput);
    input.sourceSnapshots[0]!.sourceKey = 'PRG';
    const context = buildGroundedOptionContext(input);
    const modelView = buildNarrativeModelView(context);
    const generationView = buildNarrativeGenerationView(context, modelView);
    const destination = generationView.facts.find((fact) => fact.key === 'option.destination');
    if (destination === undefined) throw new Error('Missing destination generation fact.');

    expect(() =>
      finalizeNarrativeOutput({
        context,
        modelView,
        generationView,
        providerBlocks: [{ kind: 'SUMMARY', text, factReferences: [destination.factId] }],
      }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_NARRATIVE_FINALIZATION' }));
  });

  it('rejects fetched-at framing despite an exact cited date-time collision', () => {
    const input: GroundedOptionContextInput = structuredClone(groundedOptionContextInput);
    input.sourceSnapshots[0]!.fetchedAt = input.rankedOption.outboundDepartureAt;
    const context = buildGroundedOptionContext(input);
    const modelView = buildNarrativeModelView(context);
    const generationView = buildNarrativeGenerationView(context, modelView);
    const transport = generationView.facts.find((fact) => fact.key === 'option.transport');
    if (transport === undefined) throw new Error('Missing transport generation fact.');

    expect(() =>
      finalizeNarrativeOutput({
        context,
        modelView,
        generationView,
        providerBlocks: [
          {
            kind: 'SUMMARY',
            text: `The source was fetched at ${input.rankedOption.outboundDepartureAt}.`,
            factReferences: [transport.factId],
          },
        ],
      }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_NARRATIVE_FINALIZATION' }));
  });

  it('allows plain cited TRAIN and PRG domain facts despite source-metadata collisions', () => {
    const trainInput: GroundedOptionContextInput = structuredClone(groundedOptionContextInput);
    trainInput.sourceSnapshots[0]!.provider = 'TRAIN';
    const trainContext = buildGroundedOptionContext(trainInput);
    const trainModelView = buildNarrativeModelView(trainContext);
    const trainGenerationView = buildNarrativeGenerationView(trainContext, trainModelView);
    const transport = trainGenerationView.facts.find((fact) => fact.key === 'option.transport');
    if (transport === undefined) throw new Error('Missing transport generation fact.');

    expect(
      finalizeNarrativeOutput({
        context: trainContext,
        modelView: trainModelView,
        generationView: trainGenerationView,
        providerBlocks: [
          {
            kind: 'SUMMARY',
            text: 'The trip uses direct TRAIN transport.',
            factReferences: [transport.factId],
          },
        ],
      }).blocks[0]?.text,
    ).toContain('TRAIN');

    const prgInput: GroundedOptionContextInput = structuredClone(groundedOptionContextInput);
    prgInput.sourceSnapshots[0]!.sourceKey = 'PRG';
    const prgContext = buildGroundedOptionContext(prgInput);
    const prgModelView = buildNarrativeModelView(prgContext);
    const prgGenerationView = buildNarrativeGenerationView(prgContext, prgModelView);
    const destination = prgGenerationView.facts.find((fact) => fact.key === 'option.destination');
    if (destination === undefined) throw new Error('Missing destination generation fact.');

    expect(
      finalizeNarrativeOutput({
        context: prgContext,
        modelView: prgModelView,
        generationView: prgGenerationView,
        providerBlocks: [
          {
            kind: 'SUMMARY',
            text: 'The destination code is PRG.',
            factReferences: [destination.factId],
          },
        ],
      }).blocks[0]?.text,
    ).toContain('PRG');
  });

  it.each([
    ['English external item ID', 'The external item ID is PRG.'],
    ['Polish external item ID', 'Zewnętrzny identyfikator elementu to PRG.'],
  ])('rejects explicit source framing despite a cited PRG collision: %s', (_name, text) => {
    const context = unknownMissingContext('PRG');
    const modelView = buildNarrativeModelView(context);
    const generationView = buildNarrativeGenerationView(context, modelView);
    const destination = generationView.facts.find((fact) => fact.key === 'option.destination');
    if (destination === undefined) throw new Error('Missing destination generation fact.');

    expect(() =>
      finalizeNarrativeOutput({
        context,
        modelView,
        generationView,
        providerBlocks: [{ kind: 'SUMMARY', text, factReferences: [destination.factId] }],
      }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_NARRATIVE_FINALIZATION' }));
  });

  it('appends FIXTURE, CACHED, combined, and no-source disclosures deterministically', () => {
    const fixture = completeContext();
    const cachedInput: GroundedOptionContextInput = structuredClone(groundedOptionContextInput);
    cachedInput.sourceSnapshots[0]!.freshnessType = 'CACHED';
    cachedInput.sourceSnapshots[0]!.demonstrationData = false;
    const cached = buildGroundedOptionContext(cachedInput);
    const combinedInput: GroundedOptionContextInput = structuredClone(groundedOptionContextInput);
    combinedInput.sourceSnapshots[0]!.freshnessType = 'CACHED';
    const combined = buildGroundedOptionContext(combinedInput);
    const liveInput: GroundedOptionContextInput = structuredClone(groundedOptionContextInput);
    liveInput.sourceSnapshots[0]!.freshnessType = 'LIVE';
    liveInput.sourceSnapshots[0]!.demonstrationData = false;
    const live = buildGroundedOptionContext(liveInput);

    expect(buildMandatoryNarrativeBlocks({ context: fixture })[0]?.text).toContain(
      'demonstrative fixture/test data',
    );
    expect(buildMandatoryNarrativeBlocks({ context: cached })[0]?.text).toContain('cached data');
    expect(buildMandatoryNarrativeBlocks({ context: cached })[0]?.text).not.toContain(
      'demonstrative',
    );
    expect(buildMandatoryNarrativeBlocks({ context: combined })[0]?.text).toContain(
      'demonstrative fixture/test data and cached data',
    );
    expect(buildMandatoryNarrativeBlocks({ context: live })).toEqual([]);
  });

  it('appends one exact UNKNOWN/MISSING block with all non-KNOWN fact IDs', () => {
    const context = unknownMissingContext();
    const blocks = buildMandatoryNarrativeBlocks({ context });
    const limitation = blocks.at(-1)!;
    const expectedIds = context.facts
      .filter((fact) => fact.status !== 'KNOWN')
      .map((fact) => fact.factId)
      .sort();

    expect(blocks).toHaveLength(2);
    expect(limitation.text).toContain('UNKNOWN applies to');
    expect(limitation.text).toContain('MISSING (absent) applies to');
    expect(limitation.text).toContain('total, per-person, and remaining budget are unavailable');
    expect([...limitation.factReferences].sort()).toEqual(expectedIds);
  });

  it('rejects provider-owned provenance/non-KNOWN duties and tampered deterministic tails', () => {
    const context = completeContext();
    const modelView = buildNarrativeModelView(context);
    const generationView = buildNarrativeGenerationView(context, modelView);
    const destination = generationView.facts.find((fact) => fact.key === 'option.destination');
    if (destination === undefined) throw new Error('Missing destination generation fact.');

    expect(() =>
      finalizeNarrativeOutput({
        context,
        modelView,
        generationView,
        providerBlocks: [
          {
            kind: 'RISK',
            text: 'This fixture is a current live offer.',
            factReferences: [destination.factId],
          },
        ],
      }),
    ).toThrow(/freshness|demonstration/u);

    const finalized = finalizeNarrativeOutput({
      context,
      modelView,
      generationView,
      providerBlocks: [generatedBlock(context)],
    });
    const tampered = {
      ...finalized,
      blocks: finalized.blocks.slice(0, -1),
    };
    expect(
      validateFinalizedNarrative({ context, modelView, generationView, output: tampered }),
    ).toBe(false);
    const request = createOptionNarrativeRequest(context, modelView, generationView);
    expect(validateBoundStructuredAiOutput(request, tampered)).toEqual({
      success: false,
      validationFailureStage: 'NARRATIVE_FINALIZATION',
    });
    expect(validateBoundStructuredAiOutput(request, finalized)).toEqual({
      success: true,
      output: finalized,
    });
  });

  it.each([
    ['English freshness', 'Availability is current for this option.'],
    ['Polish freshness', 'Dane są aktualne i dostępne na żywo.'],
    ['uncited money', 'Koszt wynosi 123,00 PLN.'],
    ['uncited currency', 'Waluta tej opcji to EUR.'],
    ['uncited date and time', 'Wyjazd odbędzie się 01.01.2027 o 09:30.'],
    ['uncited number', 'Ta opcja obejmuje 999 elementów.'],
  ])('rejects provider-owned or uncited sensitive claims: %s', (_name, text) => {
    const context = completeContext();
    const modelView = buildNarrativeModelView(context);
    const generationView = buildNarrativeGenerationView(context, modelView);

    expect(() =>
      finalizeNarrativeOutput({
        context,
        modelView,
        generationView,
        providerBlocks: [{ ...generatedBlock(context), text }],
      }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_NARRATIVE_FINALIZATION' }));
  });

  it.each(['Food is included.', 'Wyżywienie jest wliczone.'])(
    'rejects provider handling of a non-KNOWN category: %s',
    (text) => {
      const context = unknownMissingContext();
      const modelView = buildNarrativeModelView(context);
      const generationView = buildNarrativeGenerationView(context, modelView);
      const destination = generationView.facts.find((fact) => fact.key === 'option.destination');
      if (destination === undefined) throw new Error('Missing destination generation fact.');

      expect(() =>
        finalizeNarrativeOutput({
          context,
          modelView,
          generationView,
          providerBlocks: [
            {
              kind: 'SUMMARY',
              text,
              factReferences: [destination.factId],
            },
          ],
        }),
      ).toThrowError(expect.objectContaining({ code: 'INVALID_NARRATIVE_FINALIZATION' }));
    },
  );

  it.each([
    ['English cost/amount', 'TRANSPORT', 'UNKNOWN', 'Transport cost amount is included.'],
    ['Polish cost/included', 'TRANSPORT', 'UNKNOWN', 'Koszt transportu jest wliczony.'],
    ['English free status', 'ACCOMMODATION', 'MISSING', 'Hotel accommodation is free.'],
    ['Polish free status', 'ACCOMMODATION', 'MISSING', 'Nocleg jest bezpłatny.'],
    ['English confirmed pricing', 'TRANSPORT', 'UNKNOWN', 'Transport pricing is confirmed.'],
    ['Polish confirmed pricing', 'TRANSPORT', 'UNKNOWN', 'Cena transportu jest potwierdzona.'],
    ['English terse train free', 'TRANSPORT', 'UNKNOWN', 'Train travel is free.'],
    ['English terse train included', 'TRANSPORT', 'UNKNOWN', 'Train travel is included.'],
    ['English terse stay complimentary', 'ACCOMMODATION', 'MISSING', 'The stay is complimentary.'],
    ['English terse room complimentary', 'ACCOMMODATION', 'MISSING', 'The room is complimentary.'],
    [
      'English confirmed availability',
      'ACCOMMODATION',
      'MISSING',
      'Hotel availability is confirmed.',
    ],
    [
      'Polish confirmed availability',
      'ACCOMMODATION',
      'MISSING',
      'Dostępność noclegu jest potwierdzona.',
    ],
  ] as const)(
    'rejects completion of a matching non-KNOWN budget value/status: %s',
    (_name, category, status, text) => {
      const context = contextWithUnavailableBudgetCost(category, status);
      const modelView = buildNarrativeModelView(context);
      const generationView = buildNarrativeGenerationView(context, modelView);
      const factKey = category === 'TRANSPORT' ? 'option.transport' : 'option.accommodation';
      const structuralFact = generationView.facts.find((fact) => fact.key === factKey);
      if (structuralFact === undefined) throw new Error(`Missing ${factKey} generation fact.`);

      expect(() =>
        finalizeNarrativeOutput({
          context,
          modelView,
          generationView,
          providerBlocks: [
            {
              kind: 'SUMMARY',
              text,
              factReferences: [structuralFact.factId],
            },
          ],
        }),
      ).toThrowError(expect.objectContaining({ code: 'INVALID_NARRATIVE_FINALIZATION' }));
    },
  );

  it.each(['Transport cost is unknown.', 'Brak ceny transportu.'])(
    'rejects provider-authored UNKNOWN/MISSING disclosure: %s',
    (text) => {
      const context = contextWithUnavailableBudgetCost('TRANSPORT', 'UNKNOWN');
      const modelView = buildNarrativeModelView(context);
      const generationView = buildNarrativeGenerationView(context, modelView);
      const transport = generationView.facts.find((fact) => fact.key === 'option.transport');
      if (transport === undefined) throw new Error('Missing transport generation fact.');

      expect(() =>
        finalizeNarrativeOutput({
          context,
          modelView,
          generationView,
          providerBlocks: [{ kind: 'RISK', text, factReferences: [transport.factId] }],
        }),
      ).toThrowError(expect.objectContaining({ code: 'INVALID_NARRATIVE_FINALIZATION' }));
    },
  );

  it('rejects a provider reference to the excluded non-KNOWN budget fact ID', () => {
    const context = contextWithUnavailableBudgetCost('TRANSPORT', 'UNKNOWN');
    const modelView = buildNarrativeModelView(context);
    const generationView = buildNarrativeGenerationView(context, modelView);
    const nonKnownCost = context.facts.find(
      (fact) => fact.key === 'option.budget.category.TRANSPORT',
    );
    if (nonKnownCost === undefined) throw new Error('Missing non-KNOWN transport cost fact.');

    expect(() =>
      finalizeNarrativeOutput({
        context,
        modelView,
        generationView,
        providerBlocks: [
          {
            kind: 'SUMMARY',
            text: 'Transport uses TRAIN.',
            factReferences: [nonKnownCost.factId],
          },
        ],
      }),
    ).toThrow(/outside the generation-only view/u);
  });

  it('still rejects a source-only value with no exact cited KNOWN structural support', () => {
    const context = completeContext();
    const modelView = buildNarrativeModelView(context);
    const generationView = buildNarrativeGenerationView(context, modelView);
    const destination = generationView.facts.find((fact) => fact.key === 'option.destination');
    if (destination === undefined) throw new Error('Missing destination generation fact.');

    expect(() =>
      finalizeNarrativeOutput({
        context,
        modelView,
        generationView,
        providerBlocks: [
          {
            kind: 'SUMMARY',
            text: 'The source item is prague-option.',
            factReferences: [destination.factId],
          },
        ],
      }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_NARRATIVE_FINALIZATION' }));
  });

  it('requires exact finalized evidence at the production precheck entry point', () => {
    const context = completeContext();
    const modelView = buildNarrativeModelView(context);
    const generationView = buildNarrativeGenerationView(context, modelView);
    const output = finalizeNarrativeOutput({
      context,
      modelView,
      generationView,
      providerBlocks: [generatedBlock(context)],
    });

    expect(
      runNarrativeSafetyPrecheck({ context, modelView, generationView, narrativeOutput: output }),
    ).toEqual({ passed: true, findings: [] });
    expect(
      runNarrativeSafetyPrecheck({
        context,
        modelView,
        narrativeOutput: output,
      } as unknown as Parameters<typeof runNarrativeSafetyPrecheck>[0]),
    ).toMatchObject({
      passed: false,
      findings: [{ reasonCode: 'UNTRUSTED_CONTENT_EXPOSED', blockSequence: 1 }],
    });
  });
});
