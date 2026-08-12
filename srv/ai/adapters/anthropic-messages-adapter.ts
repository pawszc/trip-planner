import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { StopReason } from '@anthropic-ai/sdk/resources/messages';
import type { ZodType } from 'zod';
import type { AiConfig, AnthropicEffort } from '../config.ts';
import { resolveMaxOutputTokens } from '../config.ts';
import { AiProvider, canonicalizeJson, createInputFingerprint } from '../contracts.ts';
import type {
  AiCallResult,
  AiUsage,
  StructuredAiAdapter,
  StructuredAiRequest,
} from '../contracts.ts';
import { AiError, createMissingCredentialsError, normalizeProviderFailure } from '../errors.ts';
import type { ProviderFailureMetadata } from '../errors.ts';

const MODEL_ENVIRONMENT_VARIABLE = 'ANTHROPIC_GENERATE_MODEL';
const CREDENTIAL_ENVIRONMENT_VARIABLE = 'ANTHROPIC_API_KEY';

export interface AnthropicClientOptions {
  apiKey: string;
  timeoutMs: number;
  maxRetries: number;
  fetchImplementation?: typeof fetch;
}

export interface AnthropicStructuredRequest<TOutput> {
  model: string;
  instructions: string;
  input: string;
  outputSchema: ZodType<TOutput>;
  maxOutputTokens: number;
  effort: AnthropicEffort;
  thinking: 'disabled';
  tools: readonly [];
}

export interface AnthropicStructuredResponse {
  textBlocks: readonly string[];
  stopReason: StopReason | null;
  model: string;
  usage: AiUsage;
  providerRequestId?: string;
  attempts: number;
  refusalCategory?: string;
}

export interface AnthropicMessagesClient {
  execute<TOutput>(
    request: AnthropicStructuredRequest<TOutput>,
  ): Promise<AnthropicStructuredResponse>;
}

export type AnthropicClientFactory = (options: AnthropicClientOptions) => AnthropicMessagesClient;

export const createAnthropicSdkClient: AnthropicClientFactory = (options) => {
  let attempts = 0;
  const countedFetch: typeof fetch = async (input, init) => {
    attempts += 1;
    return (options.fetchImplementation ?? globalThis.fetch)(input, init);
  };
  const client = new Anthropic({
    apiKey: options.apiKey,
    timeout: options.timeoutMs,
    maxRetries: options.maxRetries,
    fetch: countedFetch,
  });

  return {
    async execute<TOutput>(
      request: AnthropicStructuredRequest<TOutput>,
    ): Promise<AnthropicStructuredResponse> {
      const pending = client.messages.create({
        model: request.model,
        max_tokens: request.maxOutputTokens,
        system: request.instructions,
        messages: [{ role: 'user', content: request.input }],
        output_config: {
          effort: request.effort,
          format: zodOutputFormat(request.outputSchema),
        },
        thinking: { type: request.thinking },
        tools: [...request.tools],
      });
      const { data, request_id: requestId } = await pending.withResponse();
      const cacheReadTokens = data.usage.cache_read_input_tokens ?? 0;
      const cacheWriteTokens = data.usage.cache_creation_input_tokens ?? 0;
      const inputTokens = data.usage.input_tokens + cacheReadTokens + cacheWriteTokens;
      const refusalCategory = data.stop_details?.category ?? undefined;
      return {
        textBlocks: data.content
          .filter((block) => block.type === 'text')
          .map((block) => block.text),
        stopReason: data.stop_reason,
        model: data.model,
        usage: {
          inputTokens,
          outputTokens: data.usage.output_tokens,
          totalTokens: inputTokens + data.usage.output_tokens,
          cacheReadTokens,
          cacheWriteTokens,
          ...(data.usage.output_tokens_details === null
            ? {}
            : { reasoningTokens: data.usage.output_tokens_details.thinking_tokens }),
        },
        attempts: Math.max(attempts, 1),
        ...(refusalCategory === undefined ? {} : { refusalCategory }),
        ...(requestId === null || requestId === undefined ? {} : { providerRequestId: requestId }),
      };
    },
  };
};

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null;
}

function safeProviderCode(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(value) ? value : undefined;
}

function anthropicFailureMetadata(error: unknown): ProviderFailureMetadata {
  const record = isRecord(error) ? error : undefined;
  const status = typeof record?.status === 'number' ? record.status : undefined;
  const providerCode = safeProviderCode(record?.type);
  const name = error instanceof Error ? error.constructor.name : '';
  const message = error instanceof Error ? error.message : '';
  const classifier = `${name} ${providerCode ?? ''} ${message}`;

  return {
    ...(status === undefined ? {} : { status }),
    ...(providerCode === undefined ? {} : { providerCode }),
    isTimeout: /timeout|timed out|ETIMEDOUT/i.test(classifier),
    isConnectionError: /connection|fetch failed|ECONN(?:RESET|REFUSED)/i.test(classifier),
    isModelAccessError:
      status === 403 ||
      status === 404 ||
      /model[_ -]?(?:not[_ -]?found|access|permission|unavailable)|not_found_error/i.test(
        classifier,
      ),
    isQuotaError: /quota|billing|credit/i.test(classifier),
  };
}

function validateRequestMetadata<TOutput>(request: StructuredAiRequest<TOutput>): void {
  for (const [field, value] of [
    ['promptVersion', request.promptVersion],
    ['schemaVersion', request.schemaVersion],
    ['schemaName', request.schemaName],
    ['instructions', request.instructions],
  ] as const) {
    if (value.trim().length === 0) {
      throw new AiError('INVALID_AI_CONFIGURATION', `${field} must not be empty.`, {
        provider: AiProvider.ANTHROPIC,
        details: { field },
      });
    }
  }
}

function normalizeStopReason(stopReason: StopReason | null): string {
  return stopReason ?? 'null';
}

function incompleteOutputMessage(stopReason: StopReason | null): string {
  if (stopReason === 'max_tokens') {
    return 'Anthropic structured output was interrupted by the output token limit before completion.';
  }
  if (stopReason === 'model_context_window_exceeded') {
    return 'Anthropic structured output was interrupted by the context window limit before completion.';
  }
  return 'Anthropic structured output did not finish with end_turn.';
}

export class AnthropicMessagesAdapter implements StructuredAiAdapter {
  readonly provider = AiProvider.ANTHROPIC;
  readonly model: string;

  constructor(
    private readonly config: AiConfig,
    private readonly clientFactory: AnthropicClientFactory = createAnthropicSdkClient,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.model = config.anthropic.model;
  }

  async call<TOutput>(request: StructuredAiRequest<TOutput>): Promise<AiCallResult<TOutput>> {
    validateRequestMetadata(request);
    if (request.provider !== undefined && request.provider !== this.provider) {
      throw new AiError('UNSUPPORTED_AI_PROVIDER', 'The request targets a different AI provider.', {
        provider: request.provider,
        model: this.model,
      });
    }
    const apiKey = this.config.anthropic.apiKey;
    if (apiKey === undefined) {
      throw createMissingCredentialsError(
        this.provider,
        this.model,
        CREDENTIAL_ENVIRONMENT_VARIABLE,
      );
    }

    const inputFingerprint = createInputFingerprint(request.input);
    const startedAt = this.now();
    try {
      const client = this.clientFactory({
        apiKey,
        timeoutMs: this.config.timeoutMs,
        maxRetries: this.config.maxRetries,
      });
      const response = await client.execute({
        model: this.model,
        instructions: request.instructions,
        input: canonicalizeJson(request.input),
        outputSchema: request.outputSchema,
        maxOutputTokens: resolveMaxOutputTokens(
          request.maxOutputTokens,
          this.config.maxOutputTokens,
        ),
        effort: this.config.anthropic.effort,
        thinking: 'disabled',
        tools: [],
      });

      if (response.stopReason === 'refusal') {
        throw new AiError('MODEL_REFUSAL', 'Anthropic refused the structured output request.', {
          provider: this.provider,
          model: this.model,
          details:
            response.refusalCategory === undefined ? {} : { category: response.refusalCategory },
        });
      }

      if (response.stopReason !== 'end_turn') {
        throw new AiError(
          'INVALID_STRUCTURED_OUTPUT',
          incompleteOutputMessage(response.stopReason),
          {
            provider: this.provider,
            model: this.model,
            details: { stopReason: normalizeStopReason(response.stopReason) },
          },
        );
      }

      const textBlocks = response.textBlocks.filter((block) => block.trim().length > 0);
      if (textBlocks.length === 0) {
        throw new AiError('EMPTY_MODEL_OUTPUT', 'Anthropic returned no text output block.', {
          provider: this.provider,
          model: this.model,
        });
      }
      if (textBlocks.length > 1) {
        throw new AiError(
          'INVALID_STRUCTURED_OUTPUT',
          'Anthropic returned more than one non-empty text output block.',
          {
            provider: this.provider,
            model: this.model,
            details: { textBlockCount: textBlocks.length },
          },
        );
      }
      const text = textBlocks[0]!;

      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (cause) {
        throw new AiError('INVALID_STRUCTURED_OUTPUT', 'Anthropic output was not valid JSON.', {
          provider: this.provider,
          model: this.model,
          cause,
        });
      }
      const locallyValidated = request.outputSchema.safeParse(parsed);
      if (!locallyValidated.success) {
        throw new AiError(
          'INVALID_STRUCTURED_OUTPUT',
          'Anthropic output failed local schema validation.',
          { provider: this.provider, model: this.model, cause: locallyValidated.error },
        );
      }

      return {
        output: locallyValidated.data,
        provider: this.provider,
        model: response.model,
        taskType: request.taskType,
        promptVersion: request.promptVersion,
        schemaVersion: request.schemaVersion,
        inputFingerprint,
        usage: response.usage,
        latencyMs: Math.max(0, Math.round(this.now() - startedAt)),
        attempts: response.attempts,
        refusal: { refused: false },
        ...(response.providerRequestId === undefined
          ? {}
          : { providerRequestId: response.providerRequestId }),
      };
    } catch (error) {
      if (error instanceof AiError) {
        throw error;
      }
      throw normalizeProviderFailure({
        provider: this.provider,
        model: this.model,
        modelEnvironmentVariable: MODEL_ENVIRONMENT_VARIABLE,
        metadata: anthropicFailureMetadata(error),
        cause: error,
      });
    }
  }
}
