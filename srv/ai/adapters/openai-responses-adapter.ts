import { randomUUID } from 'node:crypto';
import OpenAI, { APIError } from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import type { ZodType } from 'zod';
import type { AiConfig, OpenAiReasoningEffort } from '../config.ts';
import { resolveMaxOutputTokens, validateAiExecutionProfile } from '../config.ts';
import {
  AiProvider,
  canonicalizeJson,
  createInputFingerprint,
  isValidAiRunId,
} from '../contracts.ts';
import type {
  AiCallResult,
  AiExecutionProfile,
  AiUsage,
  StructuredAiAdapter,
  StructuredAiRequest,
} from '../contracts.ts';
import { AiError, createMissingCredentialsError, normalizeProviderFailure } from '../errors.ts';
import type { ProviderFailureMetadata } from '../errors.ts';
import {
  parseAiFailureExecutionEvidence,
  type AiFailureExecutionEvidence,
  type AiProviderIncompleteReason,
  type AiProviderResponseStatus,
} from '../failure-execution-evidence.ts';

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
  responseStatus: OpenAiResponseStatus;
  incompleteReason?: OpenAiIncompleteReason;
  providerResponseId?: string;
  providerRequestId?: string;
  responseModel?: string;
  usage?: Readonly<Required<AiUsage>>;
  attempts: number;
  refused: boolean;
  responseErrorCode?: string;
}

export type OpenAiResponseStatus = AiProviderResponseStatus;
export type OpenAiIncompleteReason = AiProviderIncompleteReason;

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

function mapOpenAiUsage(usage: OpenAiUsagePayload): Readonly<Required<AiUsage>> {
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
        const refused = data.output.some(
          (item) =>
            item.type === 'message' && item.content.some((content) => content.type === 'refusal'),
        );
        const incompleteReason = mapOpenAiIncompleteReason(data.incomplete_details?.reason);
        const providerResponseId = safeProviderIdentifier(data.id);
        const providerRequestId = safeProviderIdentifier(requestId);
        const responseModel = safeModelIdentifier(data.model);
        const responseErrorCode = safeProviderCode(data.error?.code);
        return {
          outputParsed: data.output_parsed,
          responseStatus: mapOpenAiResponseStatus(data.status),
          ...(incompleteReason === undefined ? {} : { incompleteReason }),
          ...(providerResponseId === undefined ? {} : { providerResponseId }),
          ...(responseModel === undefined ? {} : { responseModel }),
          ...(data.usage === null || data.usage === undefined
            ? {}
            : { usage: mapOpenAiUsage(data.usage) }),
          attempts: Math.max(attempts, 1),
          refused,
          ...(providerRequestId === undefined ? {} : { providerRequestId }),
          ...(responseErrorCode === undefined ? {} : { responseErrorCode }),
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

function safeProviderIdentifier(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,249}$/u.test(value)
    ? value
    : undefined;
}

function safeModelIdentifier(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u.test(value)
    ? value
    : undefined;
}

function mapOpenAiResponseStatus(value: unknown): OpenAiResponseStatus {
  switch (value) {
    case 'completed':
      return 'COMPLETED';
    case 'incomplete':
      return 'INCOMPLETE';
    case 'failed':
      return 'FAILED';
    case 'cancelled':
      return 'CANCELLED';
    case 'queued':
      return 'QUEUED';
    case 'in_progress':
      return 'IN_PROGRESS';
    default:
      return 'UNKNOWN';
  }
}

function mapOpenAiIncompleteReason(value: unknown): OpenAiIncompleteReason | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === 'max_output_tokens') return 'MAX_OUTPUT_TOKENS';
  if (value === 'content_filter') return 'CONTENT_FILTER';
  return 'UNKNOWN';
}

function executionEvidence(
  response: OpenAiStructuredResponse<unknown>,
  configuredModel: string,
  latencyMs: number,
  refusalCategory?: AiFailureExecutionEvidence['refusalCategory'],
): AiFailureExecutionEvidence {
  return parseAiFailureExecutionEvidence({
    provider: AiProvider.OPENAI,
    configuredModel,
    ...(response.responseModel === undefined ? {} : { responseModel: response.responseModel }),
    providerResponseStatus: response.responseStatus,
    ...(response.incompleteReason === undefined
      ? {}
      : { providerIncompleteReason: response.incompleteReason }),
    ...(response.providerRequestId === undefined
      ? {}
      : { providerRequestId: response.providerRequestId }),
    ...(response.providerResponseId === undefined
      ? {}
      : { providerResponseId: response.providerResponseId }),
    ...(response.usage === undefined ? {} : { usage: response.usage }),
    attempts: response.attempts,
    latencyMs,
    ...(refusalCategory === undefined ? {} : { refusalCategory }),
  });
}

function providerTerminalError(
  response: OpenAiStructuredResponse<unknown>,
  configuredModel: string,
  evidence: AiFailureExecutionEvidence,
): AiError {
  return new AiError('PROVIDER_ERROR', 'OpenAI returned a non-success terminal response.', {
    provider: AiProvider.OPENAI,
    model: configuredModel,
    details: {
      responseStatus: response.responseStatus,
      ...(response.responseErrorCode === undefined
        ? {}
        : { providerCode: response.responseErrorCode }),
    },
    executionEvidence: evidence,
  });
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
  private readonly config: AiConfig;
  private readonly clientFactory: OpenAiClientFactory;
  private readonly now: () => number;

  constructor(
    config: AiConfig,
    clientFactory: OpenAiClientFactory = createOpenAiSdkClient,
    now: () => number = () => Date.now(),
  ) {
    this.config = config;
    this.clientFactory = clientFactory;
    this.now = now;
  }

  async call<TOutput>(
    request: StructuredAiRequest<TOutput>,
    profile: AiExecutionProfile,
  ): Promise<AiCallResult<TOutput>> {
    validateRequestMetadata(request);
    validateAiExecutionProfile(profile);
    if (profile.provider !== this.provider) {
      throw new AiError('UNSUPPORTED_AI_PROVIDER', 'The profile targets a different AI provider.', {
        provider: profile.provider,
        model: profile.model,
      });
    }
    if (profile.taskType !== request.taskType) {
      throw new AiError(
        'INVALID_AI_CONFIGURATION',
        'The profile task does not match the request.',
        {
          provider: this.provider,
          model: profile.model,
          details: { field: 'profile.taskType' },
        },
      );
    }
    const aiRunId = request.aiRunId?.trim() ?? randomUUID();
    if (!isValidAiRunId(aiRunId)) {
      throw new AiError('INVALID_AI_CONFIGURATION', 'aiRunId must be a UUID.', {
        provider: this.provider,
        model: profile.model,
        details: { field: 'aiRunId' },
      });
    }
    const apiKey = this.config.providers[AiProvider.OPENAI].apiKey;
    if (apiKey === undefined) {
      throw createMissingCredentialsError(
        this.provider,
        profile.model,
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
        model: profile.model,
        instructions: request.instructions,
        input: canonicalizeJson(request.input),
        schemaName: request.schemaName,
        outputSchema: request.outputSchema,
        maxOutputTokens: resolveMaxOutputTokens(request.maxOutputTokens, profile.maxOutputTokens),
        reasoningEffort: profile.effort,
        store: false,
        tools: [],
        toolChoice: 'none',
      });

      const latencyMs = Math.max(0, Math.round(this.now() - startedAt));

      if (
        response.responseStatus === 'INCOMPLETE' &&
        response.incompleteReason === 'MAX_OUTPUT_TOKENS'
      ) {
        const evidence = executionEvidence(response, profile.model, latencyMs);
        throw new AiError(
          'INCOMPLETE_MODEL_OUTPUT',
          'OpenAI reached the configured output limit before completing structured output.',
          {
            provider: this.provider,
            model: profile.model,
            retryable: false,
            executionEvidence: evidence,
          },
        );
      }
      if (
        response.responseStatus === 'INCOMPLETE' &&
        response.incompleteReason === 'CONTENT_FILTER'
      ) {
        const evidence = executionEvidence(response, profile.model, latencyMs, 'content_filter');
        throw new AiError('MODEL_REFUSAL', 'OpenAI filtered the structured output response.', {
          provider: this.provider,
          model: profile.model,
          retryable: false,
          details: { category: 'content_filter' },
          executionEvidence: evidence,
        });
      }
      if (response.responseStatus !== 'COMPLETED') {
        const evidence = executionEvidence(response, profile.model, latencyMs);
        throw providerTerminalError(response, profile.model, evidence);
      }

      if (response.refused) {
        const evidence = executionEvidence(response, profile.model, latencyMs, 'model_refusal');
        throw new AiError('MODEL_REFUSAL', 'OpenAI refused the structured output request.', {
          provider: this.provider,
          model: profile.model,
          details: { category: 'model_refusal' },
          executionEvidence: evidence,
        });
      }
      if (response.outputParsed === null) {
        const evidence = executionEvidence(response, profile.model, latencyMs);
        throw new AiError('EMPTY_MODEL_OUTPUT', 'OpenAI returned no parsed structured output.', {
          provider: this.provider,
          model: profile.model,
          executionEvidence: evidence,
        });
      }
      const evidence = executionEvidence(response, profile.model, latencyMs);
      const locallyValidated = request.outputSchema.safeParse(response.outputParsed);
      if (!locallyValidated.success) {
        throw new AiError(
          'INVALID_STRUCTURED_OUTPUT',
          'OpenAI output failed local schema validation.',
          {
            provider: this.provider,
            model: profile.model,
            executionEvidence: evidence,
            cause: locallyValidated.error,
          },
        );
      }
      if (response.responseModel === undefined) {
        throw new AiError('PROVIDER_ERROR', 'OpenAI returned an empty response model.', {
          provider: this.provider,
          model: profile.model,
          executionEvidence: evidence,
        });
      }
      if (response.usage === undefined) {
        throw new AiError('PROVIDER_ERROR', 'OpenAI omitted required usage metadata.', {
          provider: this.provider,
          model: profile.model,
          executionEvidence: evidence,
        });
      }

      return {
        aiRunId,
        output: locallyValidated.data,
        provider: this.provider,
        configuredModel: profile.model,
        responseModel: response.responseModel,
        taskType: request.taskType,
        promptVersion: request.promptVersion,
        schemaVersion: request.schemaVersion,
        inputFingerprint,
        usage: response.usage,
        latencyMs,
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
          { provider: this.provider, model: profile.model, cause: error },
        );
      }
      if (isContentFilterError(error)) {
        throw new AiError('MODEL_REFUSAL', 'OpenAI refused the structured output request.', {
          provider: this.provider,
          model: profile.model,
          cause: error,
        });
      }
      if (isLengthFinishError(error)) {
        throw new AiError('INCOMPLETE_MODEL_OUTPUT', 'OpenAI did not complete structured output.', {
          provider: this.provider,
          model: profile.model,
          retryable: false,
          cause: error,
        });
      }
      throw normalizeProviderFailure({
        provider: this.provider,
        model: profile.model,
        modelEnvironmentVariable: `AI_${request.taskType}_MODEL`,
        metadata: openAiFailureMetadata(error),
        cause: error,
      });
    }
  }
}
