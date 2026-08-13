import { randomUUID } from 'node:crypto';
import type { AiConfig } from './config.ts';
import { isProfiledAiTaskType, validateAiExecutionProfile } from './config.ts';
import { createInputFingerprint, isValidAiRunId } from './contracts.ts';
import type {
  AiCallResult,
  AiExecutionProfile,
  AiProvider,
  StructuredAiAdapter,
  StructuredAiRequest,
} from './contracts.ts';
import { AiError } from './errors.ts';
import type { AiRunRecorder, AiRunTelemetryEvent } from './telemetry.ts';

function auditFailure(
  stage: 'STARTED' | 'SUCCEEDED' | 'FAILED',
  profile: AiExecutionProfile,
  cause: unknown,
  originalErrorCode?: string,
): AiError {
  const transactionBoundary =
    cause instanceof AiError && typeof cause.details.transactionBoundary === 'string'
      ? cause.details.transactionBoundary
      : undefined;
  return new AiError('AI_AUDIT_FAILED', 'The AI audit record could not be persisted safely.', {
    provider: profile.provider,
    model: profile.model,
    details:
      originalErrorCode === undefined
        ? { stage, ...(transactionBoundary === undefined ? {} : { transactionBoundary }) }
        : {
            originalErrorCode,
            ...(transactionBoundary === undefined ? {} : { transactionBoundary }),
          },
    cause,
  });
}

function adapterFailure(cause: unknown, profile: AiExecutionProfile): AiError {
  return cause instanceof AiError
    ? cause
    : new AiError('PROVIDER_ERROR', `${profile.provider} failed to complete the request.`, {
        provider: profile.provider,
        model: profile.model,
        cause,
      });
}

function metadataMismatch(profile: AiExecutionProfile, message: string): never {
  throw new AiError('PROVIDER_ERROR', message, {
    provider: profile.provider,
    model: profile.model,
  });
}

function validateResultMetadata<TOutput>(
  result: AiCallResult<TOutput>,
  request: StructuredAiRequest<TOutput>,
  profile: AiExecutionProfile,
  aiRunId: string,
  expectedFingerprint: string,
): void {
  if (result.provider !== profile.provider) {
    metadataMismatch(profile, 'The selected adapter returned a different provider.');
  }
  if (result.configuredModel !== profile.model) {
    metadataMismatch(profile, 'The selected adapter returned a different configured model.');
  }
  if (result.taskType !== request.taskType) {
    metadataMismatch(profile, 'The selected adapter returned a different task type.');
  }
  if (result.promptVersion !== request.promptVersion) {
    metadataMismatch(profile, 'The selected adapter returned a different prompt version.');
  }
  if (result.schemaVersion !== request.schemaVersion) {
    metadataMismatch(profile, 'The selected adapter returned a different schema version.');
  }
  if (result.inputFingerprint !== expectedFingerprint) {
    metadataMismatch(profile, 'The selected adapter returned a different input fingerprint.');
  }
  if (result.aiRunId !== aiRunId) {
    metadataMismatch(profile, 'The selected adapter returned a different AI run ID.');
  }
  if (result.responseModel.trim().length === 0) {
    metadataMismatch(profile, 'The selected adapter returned an empty response model.');
  }
}

function validateResultOutput<TOutput>(
  result: AiCallResult<TOutput>,
  request: StructuredAiRequest<TOutput>,
  profile: AiExecutionProfile,
): TOutput {
  const validation = request.outputSchema.safeParse(result.output);
  if (!validation.success) {
    throw new AiError(
      'INVALID_STRUCTURED_OUTPUT',
      'The AI adapter output failed gateway-level local schema validation.',
      { provider: profile.provider, model: profile.model },
    );
  }
  return validation.data;
}

export class AiGateway {
  private readonly adapters = new Map<AiProvider, StructuredAiAdapter>();
  private readonly config: AiConfig;
  private readonly recorder: AiRunRecorder;
  private readonly generateAiRunId: () => string;
  private readonly now: () => Date;

  constructor(
    config: AiConfig,
    adapters: readonly StructuredAiAdapter[],
    recorder: AiRunRecorder,
    generateAiRunId: () => string = randomUUID,
    now: () => Date = () => new Date(),
  ) {
    this.config = config;
    this.recorder = recorder;
    this.generateAiRunId = generateAiRunId;
    this.now = now;
    for (const adapter of adapters) {
      if (this.adapters.has(adapter.provider)) {
        throw new AiError('INVALID_AI_CONFIGURATION', 'AI adapter providers must be unique.', {
          provider: adapter.provider,
          details: { field: 'adapters' },
        });
      }
      this.adapters.set(adapter.provider, adapter);
    }
  }

  async call<TOutput>(request: StructuredAiRequest<TOutput>): Promise<AiCallResult<TOutput>> {
    if (!isProfiledAiTaskType(request.taskType)) {
      throw new AiError(
        'INVALID_AI_CONFIGURATION',
        'Operator smoke calls must use the dedicated live-smoke path.',
        { details: { taskType: request.taskType } },
      );
    }

    const profile = this.config.taskProfiles[request.taskType];
    validateAiExecutionProfile(profile);
    const adapter = this.adapters.get(profile.provider);

    // Keep AI_DISABLED ahead of fingerprinting, ID creation, recorder writes and adapter calls.
    if (!this.config.enabled) {
      throw new AiError('AI_DISABLED', 'AI calls are disabled by configuration.', {
        provider: profile.provider,
        model: profile.model,
        details: { field: 'AI_ENABLED' },
      });
    }
    if (adapter === undefined) {
      throw new AiError(
        'UNSUPPORTED_AI_PROVIDER',
        'No adapter is configured for the selected task profile.',
        { provider: profile.provider, model: profile.model },
      );
    }

    const aiRunId = this.generateAiRunId().trim();
    if (!isValidAiRunId(aiRunId)) {
      throw new AiError('INVALID_AI_CONFIGURATION', 'The AI run ID generator returned no UUID.', {
        provider: profile.provider,
        model: profile.model,
        details: { field: 'aiRunId' },
      });
    }
    const inputFingerprint = createInputFingerprint(request.input);
    const startedAt = this.now().toISOString();
    const commonEvent = {
      aiRunId,
      ...(request.planningRunId === undefined ? {} : { planningRunId: request.planningRunId }),
      provider: profile.provider,
      configuredModel: profile.model,
      taskType: request.taskType,
      promptVersion: request.promptVersion,
      schemaVersion: request.schemaVersion,
      inputFingerprint,
      startedAt,
    } as const;

    try {
      await this.recorder.record({ ...commonEvent, status: 'STARTED' });
    } catch (cause) {
      throw auditFailure('STARTED', profile, cause);
    }

    let result: AiCallResult<TOutput>;
    try {
      const executionRequest: StructuredAiRequest<TOutput> = { ...request, aiRunId };
      result = await adapter.call(executionRequest, profile);
      validateResultMetadata(result, executionRequest, profile, aiRunId, inputFingerprint);
      result = {
        ...result,
        output: validateResultOutput(result, executionRequest, profile),
      };
    } catch (cause) {
      const error = adapterFailure(cause, profile);
      const failureEvent: AiRunTelemetryEvent = {
        ...commonEvent,
        status: 'FAILED',
        completedAt: this.now().toISOString(),
        errorCode: error.code,
        retryable: error.retryable,
        ...(error.code === 'MODEL_REFUSAL'
          ? {
              refusal: {
                refused: true,
                ...(typeof error.details.category === 'string'
                  ? { category: error.details.category }
                  : {}),
              },
            }
          : {}),
      };
      try {
        await this.recorder.record(failureEvent);
      } catch (recorderCause) {
        throw auditFailure('FAILED', profile, recorderCause, error.code);
      }
      throw error;
    }

    const successEvent: AiRunTelemetryEvent = {
      ...commonEvent,
      status: 'SUCCEEDED',
      responseModel: result.responseModel,
      completedAt: this.now().toISOString(),
      latencyMs: result.latencyMs,
      attempts: result.attempts,
      usage: result.usage,
      refusal: result.refusal,
      retryable: false,
      ...(result.providerRequestId === undefined
        ? {}
        : { providerRequestId: result.providerRequestId }),
    };
    try {
      await this.recorder.record(successEvent);
    } catch (cause) {
      throw auditFailure('SUCCEEDED', profile, cause);
    }

    return result;
  }
}
