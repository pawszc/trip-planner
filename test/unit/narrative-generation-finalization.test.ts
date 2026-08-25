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

function unknownMissingContext() {
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

  it.each(['A"B', 'A\\B', 'A\nB', 'X', 'XY', 'XYZ'])(
    'rejects an escaped or short source-owned identifier that overlaps a KNOWN fact: %j',
    (identifier) => {
      const input: GroundedOptionContextInput = structuredClone(groundedOptionContextInput);
      input.rankedOption.destinationCity = `prefix-${identifier}-suffix`;
      input.sourceSnapshots[0]!.externalItemId = identifier;
      const context = buildGroundedOptionContext(input);

      expect(() => buildNarrativeGenerationView(context)).toThrow(
        /contains a value excluded from provider input/u,
      );
    },
  );

  it.each([
    ['ID', 'id'],
    ['sourceKey', 'sourceKey'],
    ['provider', 'provider'],
    ['externalItemId', 'externalItemId'],
    ['fetchedAt', 'fetchedAt'],
    ['sourceUrl', 'sourceUrl'],
    ['freshnessType', 'freshnessType'],
    ['fixtureVersion', 'fixtureVersion'],
    ['contexts', 'contexts'],
  ] as const)(
    'does not exempt a KNOWN fact that overlaps source-owned field %s',
    (_inputField, contextField) => {
      const input: GroundedOptionContextInput = structuredClone(groundedOptionContextInput);
      const sourceValue = buildGroundedOptionContext(input).sourceSnapshots[0]![contextField];
      input.rankedOption.destinationCity = sourceValue;
      const context = buildGroundedOptionContext(input);

      expect(() => buildNarrativeGenerationView(context)).toThrow(
        /contains a value excluded from provider input/u,
      );
    },
  );
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
    const provenanceFact = context.facts.find((fact) => fact.key.startsWith('provenance.'))!;

    expect(() =>
      finalizeNarrativeOutput({
        context,
        modelView,
        generationView,
        providerBlocks: [
          {
            kind: 'RISK',
            text: 'This fixture is a current live offer.',
            factReferences: [provenanceFact.factId],
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
      validationFailureStage: 'TRANSPORT_SCHEMA_VALIDATION',
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
