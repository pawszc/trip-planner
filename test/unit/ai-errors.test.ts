import { describe, expect, it } from 'vitest';
import { AiProvider } from '../../srv/ai/contracts.js';
import { AI_ERROR_CODE_VALUES, AiError, normalizeProviderFailure } from '../../srv/ai/errors.js';
import {
  AI_VALIDATION_FAILURE_STAGE_VALUES,
  parseAiFailureExecutionEvidence,
} from '../../srv/ai/failure-execution-evidence.js';

const modelContext = {
  provider: AiProvider.OPENAI,
  model: 'gpt-configured',
  modelEnvironmentVariable: 'AI_DECIDE_MODEL',
} as const;

describe('normalized AI errors', () => {
  it('keeps the privacy-safe validation-stage catalog closed', () => {
    expect(AI_VALIDATION_FAILURE_STAGE_VALUES).toEqual([
      'SCHEMA_CONSTRUCTION',
      'RESPONSE_JSON_PARSE',
      'TRANSPORT_SCHEMA_VALIDATION',
      'CONTEXT_BINDING',
      'DIMENSION_BINDING',
      'FINDING_BINDING',
    ]);
  });

  it('keeps the required error catalog closed and complete', () => {
    expect(AI_ERROR_CODE_VALUES).toEqual([
      'AI_DISABLED',
      'LIVE_AI_NOT_ENABLED',
      'MISSING_CREDENTIALS',
      'INVALID_AI_CONFIGURATION',
      'UNSUPPORTED_AI_PROVIDER',
      'AI_AUDIT_FAILED',
      'AUTHENTICATION_FAILED',
      'MODEL_ACCESS_DENIED',
      'RATE_LIMITED',
      'AI_TIMEOUT',
      'PROVIDER_UNAVAILABLE',
      'PROVIDER_ERROR',
      'MODEL_REFUSAL',
      'INCOMPLETE_MODEL_OUTPUT',
      'EMPTY_MODEL_OUTPUT',
      'INVALID_STRUCTURED_OUTPUT',
    ]);
  });

  it.each([
    [401, 'AUTHENTICATION_FAILED', false],
    [403, 'MODEL_ACCESS_DENIED', false],
    [404, 'MODEL_ACCESS_DENIED', false],
    [429, 'RATE_LIMITED', true],
    [500, 'PROVIDER_UNAVAILABLE', true],
    [503, 'PROVIDER_UNAVAILABLE', true],
    [400, 'PROVIDER_ERROR', false],
  ] as const)('maps HTTP %i to %s', (status, code, retryable) => {
    const error = normalizeProviderFailure({
      ...modelContext,
      metadata: { status },
      cause: new Error('raw provider body must stay private'),
    });

    expect(error).toMatchObject({ code, retryable, provider: AiProvider.OPENAI });
    expect(error.toSafeJSON()).not.toHaveProperty('cause');
  });

  it('maps model access hints and explains the local model-only change', () => {
    const error = normalizeProviderFailure({
      ...modelContext,
      metadata: { status: 400, isModelAccessError: true, providerCode: 'model_not_found' },
      cause: new Error('hidden'),
    });

    expect(error.code).toBe('MODEL_ACCESS_DENIED');
    expect(error.details).toMatchObject({
      configuredModel: 'gpt-configured',
      modelEnvironmentVariable: 'AI_DECIDE_MODEL',
      providerCode: 'model_not_found',
    });
    expect(error.details.nextStep).toContain('local .env');
  });

  it('distinguishes timeout, connection and quota metadata', () => {
    const timeout = normalizeProviderFailure({
      ...modelContext,
      metadata: { isTimeout: true },
      cause: new Error('hidden'),
    });
    const connection = normalizeProviderFailure({
      ...modelContext,
      metadata: { isConnectionError: true },
      cause: new Error('hidden'),
    });
    const quota = normalizeProviderFailure({
      ...modelContext,
      metadata: { status: 429, isQuotaError: true },
      cause: new Error('hidden'),
    });

    expect(timeout).toMatchObject({ code: 'AI_TIMEOUT', retryable: true });
    expect(connection).toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: true });
    expect(quota.details.quotaRelated).toBe(true);
  });

  it('retains the original cause without serializing stack, raw body or credentials', () => {
    const credential = 'sk-' + 'proj-' + 'abcdefghijklmnopqrstuvwxyz1234567890';
    const cause = new Error(`Authorization: Bearer ${credential}`);
    const error = new AiError('PROVIDER_ERROR', `Provider failed with ${credential}`, {
      provider: AiProvider.OPENAI,
      details: { OPENAI_API_KEY: credential, note: `x-api-key: ${credential}` },
      cause,
    });
    const serialized = JSON.stringify(error.toSafeJSON());

    expect(error.cause).toBe(cause);
    expect(serialized).not.toContain(credential);
    expect(serialized).not.toContain('stack');
    expect(error.message).toContain('[REDACTED]');
    expect(error.details.OPENAI_API_KEY).toBe('[REDACTED]');
  });

  it('serializes only the closed failure-evidence allowlist', () => {
    const evidence = parseAiFailureExecutionEvidence({
      provider: 'OPENAI',
      configuredModel: 'gpt-5.6-luna',
      providerCallAttempted: true,
      responseModel: 'gpt-5.6-luna-2026-08-01',
      providerResponseStatus: 'INCOMPLETE',
      providerIncompleteReason: 'MAX_OUTPUT_TOKENS',
      providerRequestId: 'req_safe',
      providerResponseId: 'resp_safe',
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        cacheReadTokens: 2,
        cacheWriteTokens: 3,
        reasoningTokens: 1,
      },
      attempts: 1,
      latencyMs: 20,
    });
    const rawSentinels = [
      'sk-proj-abcdefghijklmnopqrstuvwxyz1234567890',
      'PROMPT_SENTINEL',
      'CANDIDATE_SENTINEL',
      'RAW_PROVIDER_MESSAGE_SENTINEL',
      'https://private.example.test/item',
      'EXTERNAL_ITEM_ID_SENTINEL',
    ];
    const error = new AiError('INCOMPLETE_MODEL_OUTPUT', 'Terminal response was incomplete.', {
      provider: AiProvider.OPENAI,
      model: 'gpt-5.6-luna',
      executionEvidence: evidence,
      cause: new Error(rawSentinels.join(' ')),
    });
    const serialized = JSON.stringify(error.toSafeJSON());

    expect(error.executionEvidence).toEqual(evidence);
    for (const sentinel of rawSentinels) expect(serialized).not.toContain(sentinel);
    expect(serialized).not.toContain('cause');
    expect(serialized).not.toContain('stack');
  });

  it('rejects forbidden evidence fields and unsafe provider identifiers', () => {
    expect(() =>
      parseAiFailureExecutionEvidence({
        provider: 'OPENAI',
        configuredModel: 'gpt-5.6-luna',
        providerCallAttempted: false,
        attempts: 0,
        prompt: 'PROMPT_SENTINEL',
      }),
    ).toThrow(/forbidden field/i);
    expect(() =>
      parseAiFailureExecutionEvidence({
        provider: 'OPENAI',
        configuredModel: 'gpt-5.6-luna',
        providerCallAttempted: true,
        attempts: 1,
        providerResponseId: 'https://private.example.test/item',
      }),
    ).toThrow(/providerResponseId/i);
  });

  it('distinguishes exact zero-call schema failures from completed post-response validation', () => {
    expect(
      parseAiFailureExecutionEvidence({
        provider: 'OPENAI',
        configuredModel: 'gpt-5.6-luna',
        providerCallAttempted: false,
        validationFailureStage: 'SCHEMA_CONSTRUCTION',
        attempts: 0,
        latencyMs: 3,
      }),
    ).toEqual({
      provider: 'OPENAI',
      configuredModel: 'gpt-5.6-luna',
      providerCallAttempted: false,
      validationFailureStage: 'SCHEMA_CONSTRUCTION',
      attempts: 0,
      latencyMs: 3,
    });

    expect(
      parseAiFailureExecutionEvidence({
        provider: 'OPENAI',
        configuredModel: 'gpt-5.6-luna',
        providerCallAttempted: true,
        validationFailureStage: 'CONTEXT_BINDING',
        responseModel: 'gpt-5.6-luna-snapshot',
        providerResponseStatus: 'COMPLETED',
        attempts: 1,
      }),
    ).toMatchObject({
      providerCallAttempted: true,
      validationFailureStage: 'CONTEXT_BINDING',
      providerResponseStatus: 'COMPLETED',
      attempts: 1,
    });
  });

  it('rejects inconsistent provider-call accounting and validation stages', () => {
    expect(() =>
      parseAiFailureExecutionEvidence({
        provider: 'OPENAI',
        configuredModel: 'gpt-5.6-luna',
        providerCallAttempted: false,
        attempts: 1,
      }),
    ).toThrow(/attempts/i);
    expect(() =>
      parseAiFailureExecutionEvidence({
        provider: 'OPENAI',
        configuredModel: 'gpt-5.6-luna',
        providerCallAttempted: false,
        attempts: 0,
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
        },
      }),
    ).toThrow(/response metadata/i);
    expect(() =>
      parseAiFailureExecutionEvidence({
        provider: 'OPENAI',
        configuredModel: 'gpt-5.6-luna',
        providerCallAttempted: true,
        validationFailureStage: 'DIMENSION_BINDING',
        providerResponseStatus: 'INCOMPLETE',
        attempts: 1,
      }),
    ).toThrow(/completed provider response/i);
  });
});
