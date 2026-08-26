import { describe, expect, it } from 'vitest';
import {
  validateBoundStructuredAiOutput,
  validateStructuredAiOutput,
} from '../../srv/ai/contracts.ts';
import { buildGroundedOptionContext } from '../../srv/narratives/grounded-option-context.ts';
import { finalizeNarrativeOutput } from '../../srv/narratives/narrative-finalization.ts';
import { buildNarrativeGenerationView } from '../../srv/narratives/narrative-generation-view.ts';
import { buildNarrativeModelView } from '../../srv/narratives/narrative-model-view.ts';
import { createOptionNarrativeRequest } from '../../srv/narratives/option-narrative.ts';
import { groundedOptionContextInput } from '../fixtures/grounded-option.ts';

function exactSetup() {
  const context = buildGroundedOptionContext(structuredClone(groundedOptionContextInput));
  const modelView = buildNarrativeModelView(context);
  const generationView = buildNarrativeGenerationView(context, modelView);
  const fact = generationView.facts[0];
  if (fact === undefined) throw new Error('Missing exact generation fact.');
  const providerBlock = {
    kind: 'SUMMARY' as const,
    text: 'Exact provider-authored summary.',
    factReferences: [fact.factId],
  };
  return {
    context,
    modelView,
    generationView,
    providerBlock,
    request: createOptionNarrativeRequest(context, modelView, generationView),
  };
}

describe('narrative validation failure-stage taxonomy', () => {
  it('keeps malformed transport, request binding, and finalization policy failures distinct', () => {
    const { context, providerBlock, request } = exactSetup();

    expect(
      validateStructuredAiOutput(request, {
        contextFingerprint: context.fingerprint,
        blocks: [providerBlock],
      }),
    ).toEqual({
      success: false,
      validationFailureStage: 'TRANSPORT_SCHEMA_VALIDATION',
    });

    const otherInput = structuredClone(groundedOptionContextInput);
    otherInput.rankedOption.destinationCity = 'Wiedeń';
    const otherContext = buildGroundedOptionContext(otherInput);
    const injectedRequest = {
      ...request,
      input: buildNarrativeGenerationView(otherContext),
    };
    expect(validateStructuredAiOutput(injectedRequest, { blocks: [providerBlock] })).toEqual({
      success: false,
      validationFailureStage: 'CONTEXT_BINDING',
    });

    expect(
      validateStructuredAiOutput(request, {
        blocks: [
          {
            ...providerBlock,
            text: 'This fixture is a current live offer.',
          },
        ],
      }),
    ).toEqual({
      success: false,
      validationFailureStage: 'NARRATIVE_FINALIZATION',
    });
  });

  it('classifies bound-output binding separately from deterministic-tail failures', () => {
    const { context, modelView, generationView, providerBlock, request } = exactSetup();
    const finalized = finalizeNarrativeOutput({
      context,
      modelView,
      generationView,
      providerBlocks: [providerBlock],
    });

    expect(validateBoundStructuredAiOutput(request, finalized)).toEqual({
      success: true,
      output: finalized,
    });
    expect(
      validateBoundStructuredAiOutput(request, {
        ...finalized,
        contextFingerprint: 'f'.repeat(64),
      }),
    ).toEqual({
      success: false,
      validationFailureStage: 'CONTEXT_BINDING',
    });
    expect(
      validateBoundStructuredAiOutput(request, {
        ...finalized,
        blocks: finalized.blocks.slice(0, -1),
      }),
    ).toEqual({
      success: false,
      validationFailureStage: 'NARRATIVE_FINALIZATION',
    });
    expect(validateBoundStructuredAiOutput(request, { blocks: [] })).toEqual({
      success: false,
      validationFailureStage: 'NARRATIVE_FINALIZATION',
    });
  });
});
