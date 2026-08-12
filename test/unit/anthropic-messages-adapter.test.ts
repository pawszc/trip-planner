import { describe, expect, it, vi } from 'vitest';
import { loadAiConfig } from '../../srv/ai/config.js';
import { AiProvider } from '../../srv/ai/contracts.js';
import { AiError } from '../../srv/ai/errors.js';
import {
  AnthropicMessagesAdapter,
  createAnthropicSdkClient,
} from '../../srv/ai/adapters/anthropic-messages-adapter.js';
import type {
  AnthropicClientFactory,
  AnthropicClientOptions,
  AnthropicStructuredRequest,
  AnthropicStructuredResponse,
} from '../../srv/ai/adapters/anthropic-messages-adapter.js';
import { createLiveSmokeRequest, liveSmokeSchema } from '../../srv/ai/schemas/live-smoke-schema.js';
import type { LiveSmokeOutput } from '../../srv/ai/schemas/live-smoke-schema.js';

const validOutput: LiveSmokeOutput = {
  ok: true,
  phase: '3a',
  check: 'structured-output',
};

const usage = {
  inputTokens: 14,
  outputTokens: 6,
  totalTokens: 20,
  cacheReadTokens: 2,
  cacheWriteTokens: 1,
  reasoningTokens: 0,
} as const;

function config(overrides: Readonly<Record<string, string | undefined>> = {}) {
  return loadAiConfig({
    ANTHROPIC_API_KEY: 'anthropic-test-credential',
    ...overrides,
  });
}

function successResponse(
  request: AnthropicStructuredRequest<unknown>,
): AnthropicStructuredResponse {
  return {
    textBlocks: [JSON.stringify(validOutput)],
    stopReason: 'end_turn',
    model: request.model,
    usage,
    providerRequestId: 'anthropic-request-id',
    attempts: 1,
  };
}

function successFactory(
  onOptions?: (options: AnthropicClientOptions) => void,
  onRequest?: (request: AnthropicStructuredRequest<unknown>) => void,
): AnthropicClientFactory {
  return (options) => {
    onOptions?.(options);
    return {
      async execute<TOutput>(request: AnthropicStructuredRequest<TOutput>) {
        onRequest?.(request);
        return successResponse(request);
      },
    };
  };
}

function throwingFactory(error: unknown): AnthropicClientFactory {
  return () => ({
    async execute() {
      throw error;
    },
  });
}

function responseFactory(overrides: Partial<AnthropicStructuredResponse>): AnthropicClientFactory {
  return () => ({
    async execute<TOutput>(request: AnthropicStructuredRequest<TOutput>) {
      return { ...successResponse(request), ...overrides };
    },
  });
}

describe('Anthropic Messages adapter', () => {
  it('passes model, output_config, effort, limits, timeout and retries', async () => {
    let clientOptions: AnthropicClientOptions | undefined;
    let captured:
      | {
          model: string;
          input: string;
          maxOutputTokens: number;
          effort: string;
          thinking: string;
          tools: readonly [];
        }
      | undefined;
    const adapter = new AnthropicMessagesAdapter(
      config({ AI_TIMEOUT_MS: '40000', AI_MAX_RETRIES: '2', AI_MAX_OUTPUT_TOKENS: '80' }),
      successFactory(
        (options) => {
          clientOptions = options;
        },
        (request) => {
          captured = {
            model: request.model,
            input: request.input,
            maxOutputTokens: request.maxOutputTokens,
            effort: request.effort,
            thinking: request.thinking,
            tools: request.tools,
          };
        },
      ),
    );

    const result = await adapter.call(createLiveSmokeRequest(AiProvider.ANTHROPIC));

    expect(clientOptions).toMatchObject({ timeoutMs: 40_000, maxRetries: 2 });
    expect(clientOptions?.apiKey).toBeTruthy();
    expect(captured).toEqual({
      model: 'claude-sonnet-5',
      input: '{"check":"structured-output","ok":true,"phase":"3a"}',
      maxOutputTokens: 80,
      effort: 'low',
      thinking: 'disabled',
      tools: [],
    });
    expect(result).toMatchObject({
      output: validOutput,
      provider: AiProvider.ANTHROPIC,
      model: 'claude-sonnet-5',
      usage,
      attempts: 1,
      providerRequestId: 'anthropic-request-id',
      refusal: { refused: false },
    });
    expect(result.inputFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it('measures latency using an injected test clock', async () => {
    const times = [200, 245];
    const adapter = new AnthropicMessagesAdapter(
      config(),
      successFactory(),
      () => times.shift() ?? 245,
    );

    const result = await adapter.call(createLiveSmokeRequest(AiProvider.ANTHROPIC));

    expect(result.latencyMs).toBe(45);
  });

  it('accepts end_turn with exactly one non-empty valid text block', async () => {
    const result = await new AnthropicMessagesAdapter(
      config(),
      responseFactory({
        stopReason: 'end_turn',
        textBlocks: ['   ', JSON.stringify(validOutput), ''],
      }),
    ).call(createLiveSmokeRequest(AiProvider.ANTHROPIC));

    expect(result.output).toEqual(validOutput);
  });

  it('requires the Anthropic credential only when a call would create a client', async () => {
    const factory = vi.fn<AnthropicClientFactory>();
    const adapter = new AnthropicMessagesAdapter(loadAiConfig({}), factory);

    await expect(adapter.call(createLiveSmokeRequest(AiProvider.ANTHROPIC))).rejects.toMatchObject({
      code: 'MISSING_CREDENTIALS',
      details: { credentialEnvironmentVariable: 'ANTHROPIC_API_KEY' },
    });
    expect(factory).not.toHaveBeenCalled();
  });

  it('maps refusal stop_reason to MODEL_REFUSAL and preserves only its safe category', async () => {
    await expect(
      new AnthropicMessagesAdapter(
        config(),
        responseFactory({ stopReason: 'refusal', refusalCategory: 'general_harms' }),
      ).call(createLiveSmokeRequest(AiProvider.ANTHROPIC)),
    ).rejects.toMatchObject({ code: 'MODEL_REFUSAL', details: { category: 'general_harms' } });
  });

  it.each([
    ['max_tokens', 'output token limit'],
    ['model_context_window_exceeded', 'context window limit'],
  ] as const)('rejects interrupted %s output before parsing JSON', async (stopReason, message) => {
    await expect(
      new AnthropicMessagesAdapter(
        config(),
        responseFactory({ stopReason, textBlocks: [JSON.stringify(validOutput)] }),
      ).call(createLiveSmokeRequest(AiProvider.ANTHROPIC)),
    ).rejects.toMatchObject({
      code: 'INVALID_STRUCTURED_OUTPUT',
      message: expect.stringContaining(message),
      details: { stopReason },
    });
  });

  it.each(['pause_turn', 'tool_use', 'stop_sequence'] as const)(
    'rejects unfinished %s output in a controlled way',
    async (stopReason) => {
      await expect(
        new AnthropicMessagesAdapter(
          config(),
          responseFactory({ stopReason, textBlocks: [JSON.stringify(validOutput)] }),
        ).call(createLiveSmokeRequest(AiProvider.ANTHROPIC)),
      ).rejects.toMatchObject({
        code: 'INVALID_STRUCTURED_OUTPUT',
        details: { stopReason },
      });
    },
  );

  it('rejects a null stop_reason in a controlled way', async () => {
    await expect(
      new AnthropicMessagesAdapter(config(), responseFactory({ stopReason: null })).call(
        createLiveSmokeRequest(AiProvider.ANTHROPIC),
      ),
    ).rejects.toMatchObject({
      code: 'INVALID_STRUCTURED_OUTPUT',
      details: { stopReason: 'null' },
    });
  });

  it('rejects a future unknown stop_reason before parsing output', async () => {
    const futureStopReason = 'future_stop_reason' as AnthropicStructuredResponse['stopReason'];

    await expect(
      new AnthropicMessagesAdapter(
        config(),
        responseFactory({ stopReason: futureStopReason }),
      ).call(createLiveSmokeRequest(AiProvider.ANTHROPIC)),
    ).rejects.toMatchObject({
      code: 'INVALID_STRUCTURED_OUTPUT',
      details: { stopReason: 'future_stop_reason' },
    });
  });

  it('returns EMPTY_MODEL_OUTPUT for zero non-empty text blocks after end_turn', async () => {
    await expect(
      new AnthropicMessagesAdapter(
        config(),
        responseFactory({ stopReason: 'end_turn', textBlocks: ['', '   ', '\n'] }),
      ).call(createLiveSmokeRequest(AiProvider.ANTHROPIC)),
    ).rejects.toMatchObject({ code: 'EMPTY_MODEL_OUTPUT' });
  });

  it('rejects more than one non-empty text block without joining or selecting one', async () => {
    await expect(
      new AnthropicMessagesAdapter(
        config(),
        responseFactory({
          stopReason: 'end_turn',
          textBlocks: [JSON.stringify(validOutput), '   ', JSON.stringify(validOutput)],
        }),
      ).call(createLiveSmokeRequest(AiProvider.ANTHROPIC)),
    ).rejects.toMatchObject({
      code: 'INVALID_STRUCTURED_OUTPUT',
      details: { textBlockCount: 2 },
    });
  });

  it('does not expose a truncated response body in stopReason details', async () => {
    const rawResponseBody = `${JSON.stringify(validOutput)}-private-provider-response`;
    let error: AiError | undefined;

    try {
      await new AnthropicMessagesAdapter(
        config(),
        responseFactory({ stopReason: 'max_tokens', textBlocks: [rawResponseBody] }),
      ).call(createLiveSmokeRequest(AiProvider.ANTHROPIC));
    } catch (caught) {
      if (caught instanceof AiError) {
        error = caught;
      }
    }

    expect(error?.code).toBe('INVALID_STRUCTURED_OUTPUT');
    expect(error?.details).toEqual({ stopReason: 'max_tokens' });
    expect(JSON.stringify(error?.toSafeJSON())).not.toContain(rawResponseBody);
  });

  it('never accepts syntactically valid JSON when stop_reason is max_tokens', async () => {
    await expect(
      new AnthropicMessagesAdapter(
        config(),
        responseFactory({
          stopReason: 'max_tokens',
          textBlocks: [JSON.stringify(validOutput)],
        }),
      ).call(createLiveSmokeRequest(AiProvider.ANTHROPIC)),
    ).rejects.toMatchObject({
      code: 'INVALID_STRUCTURED_OUTPUT',
      details: { stopReason: 'max_tokens' },
    });
  });

  it('rejects invalid JSON without exposing the response body', async () => {
    const invalidJson = 'not-json-with-private-response-data';
    const factory: AnthropicClientFactory = () => ({
      async execute<TOutput>(request: AnthropicStructuredRequest<TOutput>) {
        return { ...successResponse(request), textBlocks: [invalidJson] };
      },
    });

    let error: AiError | undefined;
    try {
      await new AnthropicMessagesAdapter(config(), factory).call(
        createLiveSmokeRequest(AiProvider.ANTHROPIC),
      );
    } catch (caught) {
      if (caught instanceof AiError) {
        error = caught;
      }
    }

    expect(error?.code).toBe('INVALID_STRUCTURED_OUTPUT');
    expect(JSON.stringify(error?.toSafeJSON())).not.toContain(invalidJson);
  });

  it('revalidates JSON through the original Zod schema locally', async () => {
    const factory: AnthropicClientFactory = () => ({
      async execute<TOutput>(request: AnthropicStructuredRequest<TOutput>) {
        return {
          ...successResponse(request),
          textBlocks: [JSON.stringify({ ok: false, phase: '3a', check: 'structured-output' })],
        };
      },
    });

    await expect(
      new AnthropicMessagesAdapter(config(), factory).call(
        createLiveSmokeRequest(AiProvider.ANTHROPIC),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_STRUCTURED_OUTPUT' });
  });

  it.each([
    [Object.assign(new Error('unauthorized'), { status: 401 }), 'AUTHENTICATION_FAILED'],
    [Object.assign(new Error('forbidden model'), { status: 403 }), 'MODEL_ACCESS_DENIED'],
    [
      Object.assign(new Error('not found'), { status: 404, type: 'not_found_error' }),
      'MODEL_ACCESS_DENIED',
    ],
    [Object.assign(new Error('rate limit'), { status: 429 }), 'RATE_LIMITED'],
    [new Error('APIConnectionTimeoutError: timed out'), 'AI_TIMEOUT'],
    [new Error('fetch failed: ECONNREFUSED'), 'PROVIDER_UNAVAILABLE'],
    [Object.assign(new Error('overloaded'), { status: 529 }), 'PROVIDER_UNAVAILABLE'],
  ] as const)('normalizes provider failure to %s', async (providerError, code) => {
    await expect(
      new AnthropicMessagesAdapter(config(), throwingFactory(providerError)).call(
        createLiveSmokeRequest(AiProvider.ANTHROPIC),
      ),
    ).rejects.toMatchObject({
      code,
      provider: AiProvider.ANTHROPIC,
      model: 'claude-sonnet-5',
    });
  });

  it('never includes the API key or raw provider message in a safe error', async () => {
    const credential = 'sk-' + 'ant-' + 'abcdefghijklmnopqrstuvwxyz1234567890';
    const adapter = new AnthropicMessagesAdapter(
      config({ ANTHROPIC_API_KEY: credential }),
      throwingFactory(new Error(`connection failed x-api-key: ${credential}`)),
    );

    let error: AiError | undefined;
    try {
      await adapter.call(createLiveSmokeRequest(AiProvider.ANTHROPIC));
    } catch (caught) {
      if (caught instanceof AiError) {
        error = caught;
      }
    }

    expect(error).toBeDefined();
    expect(JSON.stringify(error?.toSafeJSON())).not.toContain(credential);
    expect(String(error)).not.toContain(credential);
  });
});

describe('official Anthropic SDK transport', () => {
  it('uses Messages output_config.format with Zod, low effort and no tools offline', async () => {
    let requestBody: Record<string, unknown> | undefined;
    const fetchImplementation: typeof fetch = async (_input, init) => {
      if (typeof init?.body !== 'string') {
        throw new Error('Expected the SDK request body to be JSON text.');
      }
      requestBody = JSON.parse(init.body) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          id: 'msg_test',
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-5',
          content: [{ type: 'text', text: JSON.stringify(validOutput), citations: null }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          stop_details: null,
          container: null,
          usage: {
            input_tokens: 11,
            output_tokens: 6,
            cache_creation: null,
            cache_creation_input_tokens: 1,
            cache_read_input_tokens: 2,
            inference_geo: null,
            output_tokens_details: { thinking_tokens: 0 },
            server_tool_use: null,
            service_tier: 'standard',
          },
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json', 'request-id': 'req_sdk_test' },
        },
      );
    };
    const client = createAnthropicSdkClient({
      apiKey: 'anthropic-test-credential',
      timeoutMs: 30_000,
      maxRetries: 1,
      fetchImplementation,
    });

    const response = await client.execute({
      model: 'claude-sonnet-5',
      instructions: 'Return structured output.',
      input: JSON.stringify(validOutput),
      outputSchema: liveSmokeSchema,
      maxOutputTokens: 128,
      effort: 'low',
      thinking: 'disabled',
      tools: [],
    });

    expect(response).toMatchObject({
      textBlocks: [JSON.stringify(validOutput)],
      stopReason: 'end_turn',
      providerRequestId: 'req_sdk_test',
      attempts: 1,
      usage,
    });
    expect(requestBody).toMatchObject({
      model: 'claude-sonnet-5',
      max_tokens: 128,
      output_config: {
        effort: 'low',
        format: { type: 'json_schema' },
      },
      thinking: { type: 'disabled' },
      tools: [],
    });
    expect(requestBody).not.toHaveProperty('output_format');
  });
});
