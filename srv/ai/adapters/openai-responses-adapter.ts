import OpenAI, { APIError } from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import type { ZodType } from 'zod';
import type { AiConfig, OpenAiReasoningEffort } from '../config.ts';
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

const MODEL_ENVIRONMENT_VARIABLE = 'OPENAI_DECIDE_MODEL';
const CREDENTIAL_ENVIRONMENT_VARIABLE = 'OPENAI_API_KEY';

export interface OpenAiClientOptions {
  apiKey: string;
  timeoutMs: number;
  maxRetries: number;
  fetchImplementation?: typeof fetch;
}

export interface OpenAiStructuredRequest<TOutput> {
  model: string;
  instructions: string;
  input: string;
  schemaName: string;
  outputSchema: ZodType<TOutput>;
  maxOutputTokens: number;
  reasoningEffort: OpenAiReasoningEffort;
  store: false;
  tools: readonly [];
  toolChoice: 'none';
}

export interface OpenAiStructuredResponse<TOutput> {
  outputParsed: TOutput | null;
  model: string;
  usage: AiUsage;
  providerRequestId?: string;
  attempts: number;
  refused: boolean;
}

export interface OpenAiResponsesClient {
  execute<TOutput>(
    request: OpenAiStructuredRequest<TOutput>,
  ): Promise<OpenAiStructuredResponse<TOutput>>;
}

export type OpenAiClientFactory = (options: OpenAiClientOptions) => OpenAiResponsesClient;

class OpenAiStructuredOutputError extends Error {
  constructor(cause: unknown) {
    super('OpenAI returned output that could not be parsed with the configured schema.', { cause });
    this.name = 'OpenAiStructuredOutputError';
  }
}

interface OpenAiUsagePayload {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  input_tokens_details: { cached_tokens: number; cache_write_tokens: number };
  output_tokens_details: { reasoning_tokens: number };
}

function mapOpenAiUsage(usage: OpenAiUsagePayload): AiUsage {
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    totalTokens: usage.total_tokens,
    cacheReadTokens: usage.input_tokens_details.cached_tokens,
    cacheWriteTokens: usage.input_tokens_details.cache_write_tokens,
    reasoningTokens: usage.output_tokens_details.reasoning_tokens,
  };
}

export const createOpenAiSdkClient: OpenAiClientFactory = (options) => {
  let attempts = 0;
  const countedFetch: typeof fetch = async (input, init) => {
    attempts += 1;
    return (options.fetchImplementation ?? globalThis.fetch)(input, init);
  };
  const client = new OpenAI({
    apiKey: options.apiKey,
    timeout: options.timeoutMs,
    maxRetries: options.maxRetries,
    fetch: countedFetch,
  });

  return {
    async execute<TOutput>(
      request: OpenAiStructuredRequest<TOutput>,
    ): Promise<OpenAiStructuredResponse<TOutput>> {
      try {
        const pending = client.responses.parse({
          model: request.model,
          instructions: request.instructions,
          input: [{ role: 'user', content: request.input }],
          text: {
            format: zodTextFormat(request.outputSchema, request.schemaName),
          },
          max_output_tokens: request.maxOutputTokens,
          reasoning: { effort: request.reasoningEffort },
          store: request.store,
          tools: [...request.tools],
          tool_choice: request.toolChoice,
        });
        const { data, request_id: requestId } = await pending.withResponse();
        if (data.usage === null || data.usage === undefined) {
          throw new AiError('PROVIDER_ERROR', 'OpenAI omitted required usage metadata.', {
            provider: AiProvider.OPENAI,
            model: request.model,
          });
        }
        const refused = data.output.some(
          (item) =>
            item.type === 'message' && item.content.some((content) => content.type === 'refusal'),
        );
        return {
          outputParsed: data.output_parsed,
          model: data.model,
          usage: mapOpenAiUsage(data.usage),
          attempts: Math.max(attempts, 1),
          refused,
          ...(requestId === null ? {} : { providerRequestId: requestId }),
        };
      } catch (error) {
        if (
          error instanceof APIError ||
          isContentFilterError(error) ||
          isLengthFinishError(error) ||
          error instanceof AiError
        ) {
          throw error;
        }
        throw new OpenAiStructuredOutputError(error);
      }
    },
  };
};

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null;
}

function errorConstructorName(error: unknown): string {
  return error instanceof Error ? error.constructor.name : '';
}

function isContentFilterError(error: unknown): boolean {
  return errorConstructorName(error) === 'ContentFilterFinishReasonError';
}

function isLengthFinishError(error: unknown): boolean {
  return errorConstructorName(error) === 'LengthFinishReasonError';
}

function safeProviderCode(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(value) ? value : undefined;
}

function openAiFailureMetadata(error: unknown): ProviderFailureMetadata {
  const record = isRecord(error) ? error : undefined;
  const status = typeof record?.status === 'number' ? record.status : undefined;
  const providerCode = safeProviderCode(record?.code);
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
      /model[_ -]?(?:not[_ -]?found|access|permission|unavailable)|unsupported[_ -]?model/i.test(
        classifier,
      ),
    isQuotaError: /quota|billing|credit|insufficient_quota/i.test(classifier),
  };
}

function validateRequestMetadata<TOutput>(request: StructuredAiRequest<TOutput>): void {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(request.schemaName)) {
    throw new AiError(
      'INVALID_AI_CONFIGURATION',
      'schemaName must contain 1-64 letters, digits, underscores or hyphens.',
      { provider: AiProvider.OPENAI, details: { field: 'schemaName' } },
    );
  }
  for (const [field, value] of [
    ['promptVersion', request.promptVersion],
    ['schemaVersion', request.schemaVersion],
    ['instructions', request.instructions],
  ] as const) {
    if (value.trim().length === 0) {
      throw new AiError('INVALID_AI_CONFIGURATION', `${field} must not be empty.`, {
        provider: AiProvider.OPENAI,
        details: { field },
      });
    }
  }
}

export class OpenAiResponsesAdapter implements StructuredAiAdapter {
  readonly provider = AiProvider.OPENAI;
  readonly model: string;

  constructor(
    private readonly config: AiConfig,
    private readonly clientFactory: OpenAiClientFactory = createOpenAiSdkClient,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.model = config.openai.model;
  }

  async call<TOutput>(request: StructuredAiRequest<TOutput>): Promise<AiCallResult<TOutput>> {
    validateRequestMetadata(request);
    if (request.provider !== undefined && request.provider !== this.provider) {
      throw new AiError('UNSUPPORTED_AI_PROVIDER', 'The request targets a different AI provider.', {
        provider: request.provider,
        model: this.model,
      });
    }
    const apiKey = this.config.openai.apiKey;
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
        schemaName: request.schemaName,
        outputSchema: request.outputSchema,
        maxOutputTokens: resolveMaxOutputTokens(
          request.maxOutputTokens,
          this.config.maxOutputTokens,
        ),
        reasoningEffort: this.config.openai.reasoningEffort,
        store: false,
        tools: [],
        toolChoice: 'none',
      });

      if (response.refused) {
        throw new AiError('MODEL_REFUSAL', 'OpenAI refused the structured output request.', {
          provider: this.provider,
          model: this.model,
        });
      }
      if (response.outputParsed === null) {
        throw new AiError('EMPTY_MODEL_OUTPUT', 'OpenAI returned no parsed structured output.', {
          provider: this.provider,
          model: this.model,
        });
      }
      const locallyValidated = request.outputSchema.safeParse(response.outputParsed);
      if (!locallyValidated.success) {
        throw new AiError(
          'INVALID_STRUCTURED_OUTPUT',
          'OpenAI output failed local schema validation.',
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
      if (error instanceof OpenAiStructuredOutputError) {
        throw new AiError(
          'INVALID_STRUCTURED_OUTPUT',
          'OpenAI output failed structured output parsing.',
          { provider: this.provider, model: this.model, cause: error },
        );
      }
      if (isContentFilterError(error)) {
        throw new AiError('MODEL_REFUSAL', 'OpenAI refused the structured output request.', {
          provider: this.provider,
          model: this.model,
          cause: error,
        });
      }
      if (isLengthFinishError(error)) {
        throw new AiError('EMPTY_MODEL_OUTPUT', 'OpenAI did not complete structured output.', {
          provider: this.provider,
          model: this.model,
          cause: error,
        });
      }
      throw normalizeProviderFailure({
        provider: this.provider,
        model: this.model,
        modelEnvironmentVariable: MODEL_ENVIRONMENT_VARIABLE,
        metadata: openAiFailureMetadata(error),
        cause: error,
      });
    }
  }
}
