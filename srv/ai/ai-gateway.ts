import { randomUUID } from 'node:crypto';
import type { AiConfig } from './config.ts';
import {
  isProfiledAiTaskType,
  resolveMaxOutputTokens,
  validateAiExecutionProfile,
} from './config.ts';
import {
  AI_REFUSAL_CATEGORY_VALUES,
  createInputFingerprint,
  isValidAiRunId,
  validateBoundStructuredAiOutput,
  type AiRefusalCategory,
} from './contracts.ts';
import type {
  AiCallResult,
  AiExecutionProfile,
  AiProvider,
  AiTaskType,
  StructuredAiAdapter,
  StructuredAiRequest,
} from './contracts.ts';
import { AiError } from './errors.ts';
import {
  parseAiFailureExecutionEvidence,
  type AiFailureExecutionEvidence,
} from './failure-execution-evidence.ts';
import {
  AI_PRE_START_FAILURE_CODE_VALUES,
  NoopAiOperationalSignalSink,
  type AiOperationalSignalSink,
  type AiPreStartFailureCode,
  type AiPreStartFailureSignal,
  type AiRunRecorder,
  type AiRunTelemetryEvent,
  type NarrativeAiTaskType,
} from './telemetry.ts';

const SAFE_OPERATIONAL_VERSION_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/iu;
const SHA_256_PATTERN = /^[0-9a-f]{64}$/u;
const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const FALLBACK_OPERATIONAL_INSTANT = '1970-01-01T00:00:00.000Z';
const AI_PRE_START_FAILURE_CODES = new Set<string>(AI_PRE_START_FAILURE_CODE_VALUES);
const AI_REFUSAL_CATEGORIES = new Set<unknown>(AI_REFUSAL_CATEGORY_VALUES);

function safeRefusalCategory(value: unknown): AiRefusalCategory {
  return AI_REFUSAL_CATEGORIES.has(value) ? (value as AiRefusalCategory) : 'unknown';
}

function isNarrativeAiTaskType(taskType: AiTaskType): taskType is NarrativeAiTaskType {
  return taskType === 'GENERATE' || taskType === 'JUDGE';
}

function safeOperationalVersion(value: unknown): string {
  return typeof value === 'string' && SAFE_OPERATIONAL_VERSION_PATTERN.test(value)
    ? value
    : 'unavailable';
}

function safeOperationalId(value: unknown): string | undefined {
  return typeof value === 'string' && isValidAiRunId(value) ? value : undefined;
}

function safeOperationalInstant(value: string | undefined, now: () => Date): string {
  if (value !== undefined && ISO_INSTANT_PATTERN.test(value)) return value;
  try {
    const instant = now().toISOString();
    return ISO_INSTANT_PATTERN.test(instant) ? instant : FALLBACK_OPERATIONAL_INSTANT;
  } catch {
    return FALLBACK_OPERATIONAL_INSTANT;
  }
}

function preStartFailureCode(cause: unknown): AiPreStartFailureCode {
  return cause instanceof AiError && AI_PRE_START_FAILURE_CODES.has(cause.code)
    ? (cause.code as AiPreStartFailureCode)
    : 'INVALID_AI_CONFIGURATION';
}

function normalizePreStartFailure(cause: unknown): AiError {
  return cause instanceof AiError
    ? cause
    : new AiError(
        'INVALID_AI_CONFIGURATION',
        'The AI request could not be initialized safely before durable audit.',
        { cause },
      );
}

function auditFailure(
  stage: 'STARTED' | 'SUCCEEDED' | 'FAILED',
  profile: AiExecutionProfile,
  cause: unknown,
  originalErrorCode?: string,
  aiRunId?: string,
): AiError {
  const transactionBoundary =
    cause instanceof AiError && typeof cause.details.transactionBoundary === 'string'
      ? cause.details.transactionBoundary
      : undefined;
  return new AiError('AI_AUDIT_FAILED', 'The AI audit record could not be persisted safely.', {
    provider: profile.provider,
    model: profile.model,
    ...(stage !== 'STARTED'
      ? {}
      : {
          executionEvidence: {
            provider: profile.provider,
            configuredModel: profile.model,
            providerCallAttempted: false,
            attempts: 0,
          },
        }),
    details:
      originalErrorCode === undefined
        ? {
            stage,
            ...(aiRunId === undefined ? {} : { aiRunId }),
            ...(transactionBoundary === undefined ? {} : { transactionBoundary }),
          }
        : {
            originalErrorCode,
            ...(aiRunId === undefined ? {} : { aiRunId }),
            ...(transactionBoundary === undefined ? {} : { transactionBoundary }),
          },
    cause,
  });
}

function withDurableAiRunId(error: AiError, aiRunId: string): AiError {
  return new AiError(error.code, error.message, {
    ...(error.provider === undefined ? {} : { provider: error.provider }),
    ...(error.model === undefined ? {} : { model: error.model }),
    retryable: error.retryable,
    details: { ...error.details, aiRunId },
    ...(error.executionEvidence === undefined
      ? {}
      : { executionEvidence: error.executionEvidence }),
    cause: error,
  });
}

function failureEvidenceForProfile(error: AiError, profile: AiExecutionProfile) {
  const evidence = error.executionEvidence;
  return evidence !== undefined &&
    evidence.provider === profile.provider &&
    evidence.configuredModel === profile.model
    ? evidence
    : undefined;
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
  const validation = validateBoundStructuredAiOutput(request, result.output);
  if (!validation.success) {
    let executionEvidence: AiFailureExecutionEvidence;
    try {
      executionEvidence = parseAiFailureExecutionEvidence({
        provider: result.provider,
        configuredModel: result.configuredModel,
        providerCallAttempted: true,
        validationFailureStage: validation.validationFailureStage,
        responseModel: result.responseModel,
        providerResponseStatus: 'COMPLETED',
        ...(result.providerRequestId === undefined
          ? {}
          : { providerRequestId: result.providerRequestId }),
        ...(result.providerResponseId === undefined
          ? {}
          : { providerResponseId: result.providerResponseId }),
        usage: {
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          totalTokens: result.usage.totalTokens,
          cacheReadTokens: result.usage.cacheReadTokens ?? 0,
          cacheWriteTokens: result.usage.cacheWriteTokens ?? 0,
          reasoningTokens: result.usage.reasoningTokens ?? 0,
        },
        attempts: result.attempts,
        latencyMs: result.latencyMs,
      });
    } catch {
      metadataMismatch(
        profile,
        'The selected adapter returned invalid completed-response accounting metadata.',
      );
    }
    throw new AiError(
      'INVALID_STRUCTURED_OUTPUT',
      'The AI adapter output failed gateway-level controlled local validation.',
      {
        provider: profile.provider,
        model: profile.model,
        details: { validationFailureStage: validation.validationFailureStage },
        executionEvidence,
      },
    );
  }
  return validation.output;
}

export class AiGateway {
  private readonly adapters = new Map<AiProvider, StructuredAiAdapter>();
  private readonly config: AiConfig;
  private readonly recorder: AiRunRecorder;
  private readonly generateAiRunId: () => string;
  private readonly now: () => Date;
  private readonly operationalSignalSink: AiOperationalSignalSink;

  constructor(
    config: AiConfig,
    adapters: readonly StructuredAiAdapter[],
    recorder: AiRunRecorder,
    generateAiRunId: () => string = randomUUID,
    now: () => Date = () => new Date(),
    operationalSignalSink: AiOperationalSignalSink = new NoopAiOperationalSignalSink(),
  ) {
    this.config = config;
    this.recorder = recorder;
    this.generateAiRunId = generateAiRunId;
    this.now = now;
    this.operationalSignalSink = operationalSignalSink;
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

  private async emitPreStartFailure<TOutput>(
    request: StructuredAiRequest<TOutput>,
    cause: unknown,
    inputFingerprint: string | undefined,
    startedAt: string | undefined,
  ): Promise<void> {
    if (!isNarrativeAiTaskType(request.taskType)) return;

    const planningRunId = safeOperationalId(request.planningRunId);
    const rankedOptionId = safeOperationalId(request.rankedOptionId);
    const signal: AiPreStartFailureSignal = Object.freeze({
      eventType: 'AI_PRE_START_FAILURE',
      stage: 'BEFORE_DURABLE_STARTED',
      taskType: request.taskType,
      failureCode: preStartFailureCode(cause),
      ...(planningRunId === undefined ? {} : { planningRunId }),
      ...(rankedOptionId === undefined ? {} : { rankedOptionId }),
      promptVersion: safeOperationalVersion(request.promptVersion),
      schemaVersion: safeOperationalVersion(request.schemaVersion),
      ...(inputFingerprint !== undefined && SHA_256_PATTERN.test(inputFingerprint)
        ? { inputFingerprint }
        : {}),
      providerCallAttempted: false,
      occurredAt: safeOperationalInstant(startedAt, this.now),
    });

    try {
      await this.operationalSignalSink.emit(signal);
    } catch {
      // Operational reporting must never expose or replace the original fail-closed outcome.
    }
  }

  async call<TOutput>(request: StructuredAiRequest<TOutput>): Promise<AiCallResult<TOutput>> {
    let inputFingerprint: string | undefined;
    let startedAt: string | undefined;
    let prepared:
      | {
          readonly profile: AiExecutionProfile;
          readonly adapter: StructuredAiAdapter;
          readonly aiRunId: string;
          readonly commonEvent: Readonly<
            Pick<
              AiRunTelemetryEvent,
              | 'aiRunId'
              | 'planningRunId'
              | 'provider'
              | 'configuredModel'
              | 'configuredEffort'
              | 'configuredMaxOutputTokens'
              | 'effectiveMaxOutputTokens'
              | 'taskType'
              | 'promptVersion'
              | 'schemaVersion'
              | 'inputFingerprint'
              | 'startedAt'
            >
          >;
        }
      | undefined;
    try {
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

      // The gateway owns the effective cap. A request may only reduce the configured profile,
      // and the exact value is fixed before durable STARTED and before the adapter sees it.
      const effectiveMaxOutputTokens = resolveMaxOutputTokens(
        request.maxOutputTokens,
        profile.maxOutputTokens,
      );
      inputFingerprint = createInputFingerprint(request.input);
      const aiRunId = this.generateAiRunId().trim();
      if (!isValidAiRunId(aiRunId)) {
        throw new AiError('INVALID_AI_CONFIGURATION', 'The AI run ID generator returned no UUID.', {
          provider: profile.provider,
          model: profile.model,
          details: { field: 'aiRunId' },
        });
      }
      startedAt = this.now().toISOString();
      const commonEvent = {
        aiRunId,
        ...(request.planningRunId === undefined ? {} : { planningRunId: request.planningRunId }),
        provider: profile.provider,
        configuredModel: profile.model,
        configuredEffort: profile.effort,
        configuredMaxOutputTokens: profile.maxOutputTokens,
        effectiveMaxOutputTokens,
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
      prepared = { profile, adapter, aiRunId, commonEvent };
    } catch (cause) {
      await this.emitPreStartFailure(request, cause, inputFingerprint, startedAt);
      throw normalizePreStartFailure(cause);
    }

    if (prepared === undefined) {
      throw new AiError(
        'AI_AUDIT_FAILED',
        'The AI request did not retain durable STARTED evidence.',
      );
    }

    const { profile, adapter, aiRunId, commonEvent } = prepared;

    let result: AiCallResult<TOutput>;
    try {
      const executionRequest: StructuredAiRequest<TOutput> = {
        ...request,
        aiRunId,
        maxOutputTokens: commonEvent.effectiveMaxOutputTokens,
      };
      result = await adapter.call(executionRequest, profile);
      validateResultMetadata(
        result,
        executionRequest,
        profile,
        aiRunId,
        commonEvent.inputFingerprint,
      );
      result = {
        ...result,
        output: validateResultOutput(result, executionRequest, profile),
      };
    } catch (cause) {
      const error = adapterFailure(cause, profile);
      const executionEvidence = failureEvidenceForProfile(error, profile);
      const failureEvent: AiRunTelemetryEvent = {
        ...commonEvent,
        status: 'FAILED',
        completedAt: this.now().toISOString(),
        errorCode: error.code,
        retryable: error.retryable,
        ...(executionEvidence?.responseModel === undefined
          ? {}
          : { responseModel: executionEvidence.responseModel }),
        ...(executionEvidence?.usage === undefined ? {} : { usage: executionEvidence.usage }),
        ...(executionEvidence?.latencyMs === undefined
          ? {}
          : { latencyMs: executionEvidence.latencyMs }),
        ...(executionEvidence?.attempts === undefined
          ? {}
          : { attempts: executionEvidence.attempts }),
        ...(executionEvidence?.providerRequestId === undefined
          ? {}
          : { providerRequestId: executionEvidence.providerRequestId }),
        ...(executionEvidence?.providerResponseId === undefined
          ? {}
          : { providerResponseId: executionEvidence.providerResponseId }),
        ...(executionEvidence?.providerResponseStatus === undefined
          ? {}
          : { providerResponseStatus: executionEvidence.providerResponseStatus }),
        ...(executionEvidence?.providerIncompleteReason === undefined
          ? {}
          : { providerIncompleteReason: executionEvidence.providerIncompleteReason }),
        ...(executionEvidence?.providerCallAttempted === undefined
          ? {}
          : { providerCallAttempted: executionEvidence.providerCallAttempted }),
        ...(executionEvidence?.validationFailureStage === undefined
          ? {}
          : { validationFailureStage: executionEvidence.validationFailureStage }),
        ...(error.code === 'MODEL_REFUSAL'
          ? {
              refusal: {
                refused: true,
                ...(executionEvidence?.refusalCategory === undefined
                  ? { category: safeRefusalCategory(error.details.category) }
                  : { category: executionEvidence.refusalCategory }),
              },
            }
          : {}),
      };
      try {
        await this.recorder.record(failureEvent);
      } catch (recorderCause) {
        throw auditFailure('FAILED', profile, recorderCause, error.code, aiRunId);
      }
      throw withDurableAiRunId(error, aiRunId);
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
      ...(result.providerResponseId === undefined
        ? {}
        : { providerResponseId: result.providerResponseId }),
    };
    try {
      await this.recorder.record(successEvent);
    } catch (cause) {
      throw auditFailure('SUCCEEDED', profile, cause, undefined, aiRunId);
    }

    return result;
  }
}
