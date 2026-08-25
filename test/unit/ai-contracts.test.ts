import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  AiTaskType,
  validateBoundStructuredAiOutput,
  validateStructuredAiOutput,
  type StructuredAiRequest,
} from '../../srv/ai/contracts.ts';

function request(
  validateOutput: StructuredAiRequest<{ ok: true }>['validateOutput'],
): StructuredAiRequest<{ ok: true }> {
  return {
    taskType: AiTaskType.JUDGE,
    promptVersion: 'test-prompt-v1',
    schemaVersion: 'test-schema-v1',
    schemaName: 'test_contract',
    instructions: 'Synthetic offline contract test.',
    input: {},
    outputSchema: z.object({ ok: z.literal(true) }).strict(),
    ...(validateOutput === undefined ? {} : { validateOutput }),
  };
}

describe('structured AI output validation composition', () => {
  it('never lets a staged validator bypass or replace the full output schema', () => {
    let stagedCalls = 0;
    const acceptsAnything = request(() => {
      stagedCalls += 1;
      return { success: true, output: { ok: true } };
    });
    expect(validateStructuredAiOutput(acceptsAnything, { ok: false })).toEqual({
      success: false,
      validationFailureStage: 'TRANSPORT_SCHEMA_VALIDATION',
    });
    expect(stagedCalls).toBe(0);

    const substitutesOutput = request(() => ({
      success: true,
      output: { ok: false } as unknown as { ok: true },
    }));
    expect(validateStructuredAiOutput(substitutesOutput, { ok: true })).toEqual({
      success: true,
      output: { ok: true },
    });

    const permissiveTransport = {
      ...substitutesOutput,
      providerOutputSchema: z.object({ ok: z.boolean() }).strict(),
    };
    expect(validateStructuredAiOutput(permissiveTransport, { ok: false })).toEqual({
      success: false,
      validationFailureStage: 'TRANSPORT_SCHEMA_VALIDATION',
    });
  });

  it('separates provider transport binding from the gateway final-output backstop', () => {
    const findingsOnlyTransport = {
      ...request(() => ({ success: true, output: { ok: true } })),
      providerOutputSchema: z.object({ findings: z.array(z.never()) }).strict(),
    };

    expect(validateStructuredAiOutput(findingsOnlyTransport, { findings: [] })).toEqual({
      success: true,
      output: { ok: true },
    });
    expect(validateStructuredAiOutput(findingsOnlyTransport, { ok: true })).toEqual({
      success: false,
      validationFailureStage: 'TRANSPORT_SCHEMA_VALIDATION',
    });
    expect(validateBoundStructuredAiOutput(findingsOnlyTransport, { ok: true })).toEqual({
      success: true,
      output: { ok: true },
    });
    expect(validateBoundStructuredAiOutput(findingsOnlyTransport, { findings: [] })).toEqual({
      success: false,
      validationFailureStage: 'TRANSPORT_SCHEMA_VALIDATION',
    });
  });

  it('preserves a controlled staged classification when both validators reject', () => {
    const contextFailure = request(() => ({
      success: false,
      validationFailureStage: 'CONTEXT_BINDING',
    }));
    expect(validateStructuredAiOutput(contextFailure, { ok: true })).toEqual({
      success: false,
      validationFailureStage: 'CONTEXT_BINDING',
    });
  });
});
