import { describe, expect, it, vi } from 'vitest';
import { loadAiConfig } from '../../srv/ai/config.js';
import { AiProvider, AiTaskType } from '../../srv/ai/contracts.js';
import type { AiExecutionProfile, StructuredAiRequest } from '../../srv/ai/contracts.js';
import { AiError } from '../../srv/ai/errors.js';
import {
  OpenAiResponsesAdapter,
  createOpenAiSdkClient,
} from '../../srv/ai/adapters/openai-responses-adapter.js';
import type {
  OpenAiClientFactory,
  OpenAiClientOptions,
  OpenAiStructuredRequest,
  OpenAiStructuredResponse,
} from '../../srv/ai/adapters/openai-responses-adapter.js';
import { createLiveSmokeRequest, liveSmokeSchema } from '../../srv/ai/schemas/live-smoke-schema.js';
import type { LiveSmokeOutput } from '../../srv/ai/schemas/live-smoke-schema.js';

const validOutput: LiveSmokeOutput = {
  ok: true,
  phase: '3b1',
  check: 'structured-output',
};

const usage = {
  inputTokens: 11,
  outputTokens: 7,
  totalTokens: 18,
  cacheReadTokens: 2,
  cacheWriteTokens: 1,
  reasoningTokens: 0,
} as const;

function config(overrides: Readonly<Record<string, string | undefined>> = {}) {
  return loadAiConfig({
    OPENAI_API_KEY: 'openai-test-credential',
    ...overrides,
  });
}

function profile(overrides: Partial<AiExecutionProfile> = {}): AiExecutionProfile {
  return {
    taskType: AiTaskType.SMOKE,
    provider: AiProvider.OPENAI,
    model: 'gpt-profile-model',
    effort: 'high',
    maxOutputTokens: 64,
    ...overrides,
  };
}

function callAdapter(
  adapter: OpenAiResponsesAdapter,
  executionProfile: AiExecutionProfile = profile(),
  request: StructuredAiRequest<LiveSmokeOutput> = createLiveSmokeRequest(),
) {
  return adapter.call(request, executionProfile);
}

function successResponse<TOutput>(
  request: OpenAiStructuredRequest<TOutput>,
): OpenAiStructuredResponse<TOutput> {
  return {
    outputParsed: request.outputSchema.parse(validOutput),
    responseStatus: 'COMPLETED',
    providerResponseId: 'resp_adapter_test',
    responseModel: `${request.model}-snapshot`,
    usage,
    providerRequestId: 'openai-request-id',
    attempts: 1,
    refused: false,
  };
}

function successFactory(
  onOptions?: (options: OpenAiClientOptions) => void,
  onRequest?: (request: OpenAiStructuredRequest<unknown>) => void,
): OpenAiClientFactory {
  return (options) => {
    onOptions?.(options);
    return {
      async execute<TOutput>(request: OpenAiStructuredRequest<TOutput>) {
        onRequest?.(request);
        return successResponse(request);
      },
    };
  };
}

function throwingFactory(error: unknown): OpenAiClientFactory {
  return () => ({
    async execute() {
      throw error;
    },
  });
}

describe('OpenAI Responses adapter', () => {
  it('passes model, structured-output settings, limits, timeout and retries', async () => {
    let clientOptions: OpenAiClientOptions | undefined;
    let captured:
      | {
          model: string;
          input: string;
          schemaName: string;
          maxOutputTokens: number;
          reasoningEffort: string;
          store: boolean;
          tools: readonly [];
          toolChoice: string;
        }
      | undefined;
    const adapter = new OpenAiResponsesAdapter(
      config({ AI_TIMEOUT_MS: '45000', AI_MAX_RETRIES: '2' }),
      successFactory(
        (options) => {
          clientOptions = options;
        },
        (request) => {
          captured = {
            model: request.model,
            input: request.input,
            schemaName: request.schemaName,
            maxOutputTokens: request.maxOutputTokens,
            reasoningEffort: request.reasoningEffort,
            store: request.store,
            tools: request.tools,
            toolChoice: request.toolChoice,
          };
        },
      ),
    );

    const result = await callAdapter(adapter);

    expect(clientOptions).toMatchObject({ timeoutMs: 45_000, maxRetries: 2 });
    expect(clientOptions?.apiKey).toBeTruthy();
    expect(captured).toEqual({
      model: 'gpt-profile-model',
      input: '{"check":"structured-output","ok":true,"phase":"3b1"}',
      schemaName: 'phase_3b1_live_smoke',
      maxOutputTokens: 64,
      reasoningEffort: 'high',
      store: false,
      tools: [],
      toolChoice: 'none',
    });
    expect(result).toMatchObject({
      output: validOutput,
      provider: AiProvider.OPENAI,
      configuredModel: 'gpt-profile-model',
      responseModel: 'gpt-profile-model-snapshot',
      usage,
      attempts: 1,
      providerRequestId: 'openai-request-id',
      refusal: { refused: false },
    });
    expect(result.inputFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it('measures latency using an injected monotonic test clock', async () => {
    const times = [100, 137];
    const adapter = new OpenAiResponsesAdapter(
      config(),
      successFactory(),
      () => times.shift() ?? 137,
    );

    const result = await callAdapter(adapter);

    expect(result.latencyMs).toBe(37);
  });

  it('lets a request lower but never raise the profile token limit', async () => {
    const captured: number[] = [];
    const adapter = new OpenAiResponsesAdapter(
      config(),
      successFactory(undefined, (request) => captured.push(request.maxOutputTokens)),
    );

    await callAdapter(adapter, profile({ maxOutputTokens: 100 }), {
      ...createLiveSmokeRequest(),
      maxOutputTokens: 32,
    });
    await callAdapter(adapter, profile({ maxOutputTokens: 100 }), {
      ...createLiveSmokeRequest(),
      maxOutputTokens: 200,
    });

    expect(captured).toEqual([32, 100]);
  });

  it('rejects a profile for another provider before creating a client', async () => {
    const factory = vi.fn<OpenAiClientFactory>();
    const adapter = new OpenAiResponsesAdapter(config(), factory);

    await expect(
      callAdapter(adapter, profile({ provider: AiProvider.ANTHROPIC })),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_AI_PROVIDER' });
    expect(factory).not.toHaveBeenCalled();
  });

  it('requires the OpenAI credential only when a call would create a client', async () => {
    const factory = vi.fn<OpenAiClientFactory>();
    const adapter = new OpenAiResponsesAdapter(loadAiConfig({}), factory);

    await expect(callAdapter(adapter)).rejects.toMatchObject({
      code: 'MISSING_CREDENTIALS',
      details: { credentialEnvironmentVariable: 'OPENAI_API_KEY' },
    });
    expect(factory).not.toHaveBeenCalled();
  });

  it('classifies terminal response states and preserves safe execution evidence', async () => {
    const refusalFactory: OpenAiClientFactory = () => ({
      async execute<TOutput>(request: OpenAiStructuredRequest<TOutput>) {
        return { ...successResponse(request), refused: true };
      },
    });
    const emptyFactory: OpenAiClientFactory = () => ({
      async execute<TOutput>(request: OpenAiStructuredRequest<TOutput>) {
        return { ...successResponse(request), outputParsed: null };
      },
    });
    const incompleteFactory: OpenAiClientFactory = () => ({
      async execute<TOutput>(request: OpenAiStructuredRequest<TOutput>) {
        return {
          ...successResponse(request),
          responseStatus: 'INCOMPLETE',
          incompleteReason: 'MAX_OUTPUT_TOKENS',
          outputParsed: null,
        };
      },
    });
    const filteredFactory: OpenAiClientFactory = () => ({
      async execute<TOutput>(request: OpenAiStructuredRequest<TOutput>) {
        return {
          ...successResponse(request),
          responseStatus: 'INCOMPLETE',
          incompleteReason: 'CONTENT_FILTER',
          outputParsed: null,
        };
      },
    });

    await expect(
      callAdapter(new OpenAiResponsesAdapter(config(), refusalFactory)),
    ).rejects.toMatchObject({ code: 'MODEL_REFUSAL' });
    await expect(
      callAdapter(new OpenAiResponsesAdapter(config(), emptyFactory)),
    ).rejects.toMatchObject({
      code: 'EMPTY_MODEL_OUTPUT',
      executionEvidence: {
        providerResponseStatus: 'COMPLETED',
        attempts: 1,
        usage,
      },
    });
    await expect(
      callAdapter(new OpenAiResponsesAdapter(config(), incompleteFactory)),
    ).rejects.toMatchObject({
      code: 'INCOMPLETE_MODEL_OUTPUT',
      retryable: false,
      executionEvidence: {
        providerResponseStatus: 'INCOMPLETE',
        providerIncompleteReason: 'MAX_OUTPUT_TOKENS',
        attempts: 1,
        usage,
      },
    });
    await expect(
      callAdapter(new OpenAiResponsesAdapter(config(), filteredFactory)),
    ).rejects.toMatchObject({
      code: 'MODEL_REFUSAL',
      details: { category: 'content_filter' },
      executionEvidence: {
        providerResponseStatus: 'INCOMPLETE',
        providerIncompleteReason: 'CONTENT_FILTER',
        refusalCategory: 'content_filter',
      },
    });
  });

  it('locally validates parsed output with the original Zod schema', async () => {
    const invalidFactory: OpenAiClientFactory = () => ({
      async execute<TOutput>(request: OpenAiStructuredRequest<TOutput>) {
        return {
          ...successResponse(request),
          outputParsed: { ok: false, phase: '3b1', check: 'structured-output' } as TOutput,
        };
      },
    });

    await expect(
      callAdapter(new OpenAiResponsesAdapter(config(), invalidFactory)),
    ).rejects.toMatchObject({ code: 'INVALID_STRUCTURED_OUTPUT' });
  });

  it('rejects an empty response model from OpenAI', async () => {
    const emptyModelFactory: OpenAiClientFactory = () => ({
      async execute<TOutput>(request: OpenAiStructuredRequest<TOutput>) {
        return { ...successResponse(request), responseModel: '' };
      },
    });

    await expect(
      callAdapter(new OpenAiResponsesAdapter(config(), emptyModelFactory)),
    ).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
  });

  it.each([
    [Object.assign(new Error('unauthorized'), { status: 401 }), 'AUTHENTICATION_FAILED'],
    [Object.assign(new Error('forbidden model'), { status: 403 }), 'MODEL_ACCESS_DENIED'],
    [
      Object.assign(new Error('model_not_found'), { status: 400, code: 'model_not_found' }),
      'MODEL_ACCESS_DENIED',
    ],
    [Object.assign(new Error('rate limit'), { status: 429 }), 'RATE_LIMITED'],
    [new Error('APIConnectionTimeoutError: timed out'), 'AI_TIMEOUT'],
    [new Error('fetch failed: ECONNRESET'), 'PROVIDER_UNAVAILABLE'],
    [Object.assign(new Error('server error'), { status: 503 }), 'PROVIDER_UNAVAILABLE'],
  ] as const)('normalizes provider failure to %s', async (providerError, code) => {
    await expect(
      callAdapter(new OpenAiResponsesAdapter(config(), throwingFactory(providerError))),
    ).rejects.toMatchObject({ code, provider: AiProvider.OPENAI, model: 'gpt-profile-model' });
  });

  it('never includes the API key or raw provider message in a safe error', async () => {
    const credential = 'sk-' + 'proj-' + 'abcdefghijklmnopqrstuvwxyz1234567890';
    const adapter = new OpenAiResponsesAdapter(
      config({ OPENAI_API_KEY: credential }),
      throwingFactory(new Error(`fetch failed Authorization: Bearer ${credential}`)),
    );

    let error: AiError | undefined;
    try {
      await callAdapter(adapter);
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

describe('official OpenAI SDK transport', () => {
  function sdkFactoryFor(payload: Readonly<Record<string, unknown>>): OpenAiClientFactory {
    return (options) =>
      createOpenAiSdkClient({
        ...options,
        fetchImplementation: async () =>
          new Response(JSON.stringify(payload), {
            status: 200,
            headers: { 'content-type': 'application/json', 'x-request-id': 'req_sdk_terminal' },
          }),
      });
  }

  function terminalPayload(overrides: Readonly<Record<string, unknown>>) {
    return {
      id: 'resp_sdk_terminal',
      object: 'response',
      created_at: 1,
      status: 'completed',
      model: 'gpt-profile-model-snapshot',
      output: [],
      usage: {
        input_tokens: 11,
        output_tokens: 7,
        total_tokens: 18,
        input_tokens_details: { cached_tokens: 2, cache_write_tokens: 1 },
        output_tokens_details: { reasoning_tokens: 0 },
      },
      ...overrides,
    };
  }

  async function terminalAdapterError(payload: Readonly<Record<string, unknown>>) {
    try {
      await callAdapter(new OpenAiResponsesAdapter(config(), sdkFactoryFor(payload)));
    } catch (error) {
      if (error instanceof AiError) return error;
      throw error;
    }
    throw new Error('Expected terminal SDK response to fail locally.');
  }

  it('classifies SDK incomplete max-output responses with complete safe evidence', async () => {
    const error = await terminalAdapterError(
      terminalPayload({
        status: 'incomplete',
        incomplete_details: { reason: 'max_output_tokens' },
      }),
    );

    expect(error).toMatchObject({
      code: 'INCOMPLETE_MODEL_OUTPUT',
      retryable: false,
      executionEvidence: {
        provider: 'OPENAI',
        configuredModel: 'gpt-profile-model',
        responseModel: 'gpt-profile-model-snapshot',
        providerResponseStatus: 'INCOMPLETE',
        providerIncompleteReason: 'MAX_OUTPUT_TOKENS',
        providerRequestId: 'req_sdk_terminal',
        providerResponseId: 'resp_sdk_terminal',
        attempts: 1,
        usage,
      },
    });
  });

  it('classifies SDK content-filter incompletes as refusal', async () => {
    const error = await terminalAdapterError(
      terminalPayload({
        status: 'incomplete',
        incomplete_details: { reason: 'content_filter' },
      }),
    );

    expect(error).toMatchObject({
      code: 'MODEL_REFUSAL',
      details: { category: 'content_filter' },
      executionEvidence: {
        providerResponseStatus: 'INCOMPLETE',
        providerIncompleteReason: 'CONTENT_FILTER',
        refusalCategory: 'content_filter',
      },
    });
  });

  it('keeps EMPTY_MODEL_OUTPUT specific to SDK completed responses without parsed output', async () => {
    const error = await terminalAdapterError(terminalPayload({ status: 'completed' }));

    expect(error).toMatchObject({
      code: 'EMPTY_MODEL_OUTPUT',
      executionEvidence: { providerResponseStatus: 'COMPLETED', attempts: 1, usage },
    });
  });

  it('maps SDK failed responses to a controlled provider error without raw message text', async () => {
    const rawMessage = 'RAW_PROVIDER_MESSAGE_SENTINEL';
    const error = await terminalAdapterError(
      terminalPayload({
        status: 'failed',
        error: { code: 'server_error', message: rawMessage },
      }),
    );

    expect(error).toMatchObject({
      code: 'PROVIDER_ERROR',
      details: { responseStatus: 'FAILED', providerCode: 'server_error' },
      executionEvidence: { providerResponseStatus: 'FAILED', attempts: 1, usage },
    });
    expect(JSON.stringify(error.toSafeJSON())).not.toContain(rawMessage);
  });

  it('uses responses.parse with zodTextFormat and a tool-free, non-stored payload offline', async () => {
    let requestBody: Record<string, unknown> | undefined;
    const fetchImplementation: typeof fetch = async (_input, init) => {
      if (typeof init?.body !== 'string') {
        throw new Error('Expected the SDK request body to be JSON text.');
      }
      requestBody = JSON.parse(init.body) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          id: 'resp_test',
          object: 'response',
          created_at: 1,
          status: 'completed',
          model: 'gpt-5.6-luna',
          output: [
            {
              id: 'msg_test',
              type: 'message',
              role: 'assistant',
              status: 'completed',
              content: [
                {
                  type: 'output_text',
                  text: JSON.stringify(validOutput),
                  annotations: [],
                  logprobs: [],
                },
              ],
            },
          ],
          usage: {
            input_tokens: 11,
            output_tokens: 7,
            total_tokens: 18,
            input_tokens_details: { cached_tokens: 2, cache_write_tokens: 1 },
            output_tokens_details: { reasoning_tokens: 0 },
          },
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json', 'x-request-id': 'req_sdk_test' },
        },
      );
    };
    const client = createOpenAiSdkClient({
      apiKey: 'openai-test-credential',
      timeoutMs: 30_000,
      maxRetries: 1,
      fetchImplementation,
    });

    const response = await client.execute({
      model: 'gpt-5.6-luna',
      instructions: 'Return structured output.',
      input: JSON.stringify(validOutput),
      schemaName: 'phase_3b1_live_smoke',
      outputSchema: liveSmokeSchema,
      maxOutputTokens: 128,
      reasoningEffort: 'none',
      store: false,
      tools: [],
      toolChoice: 'none',
    });

    expect(response).toMatchObject({
      outputParsed: validOutput,
      responseStatus: 'COMPLETED',
      providerResponseId: 'resp_test',
      responseModel: 'gpt-5.6-luna',
      providerRequestId: 'req_sdk_test',
      attempts: 1,
      usage,
    });
    expect(requestBody).toMatchObject({
      model: 'gpt-5.6-luna',
      store: false,
      max_output_tokens: 128,
      reasoning: { effort: 'none' },
      tools: [],
      tool_choice: 'none',
      text: {
        format: {
          type: 'json_schema',
          name: 'phase_3b1_live_smoke',
          strict: true,
        },
      },
    });
  });
});
