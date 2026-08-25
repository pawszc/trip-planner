import { AiError } from '../errors.ts';
import { AI_REFUSAL_CATEGORY_VALUES } from '../contracts.ts';
import {
  AI_PROVIDER_INCOMPLETE_REASON_VALUES,
  AI_PROVIDER_RESPONSE_STATUS_VALUES,
  AI_VALIDATION_FAILURE_STAGE_VALUES,
} from '../failure-execution-evidence.ts';
import type { AiRunRecorder, AiRunTelemetryEvent } from '../telemetry.ts';
import type { AiRunStore } from './ai-run-store.ts';

const DAY_MS = 24 * 60 * 60 * 1_000;
const CONFIGURED_EFFORTS = new Set(['none', 'low', 'medium', 'high', 'xhigh', 'max']);
const PROVIDER_RESPONSE_STATUSES = new Set<string>(AI_PROVIDER_RESPONSE_STATUS_VALUES);
const PROVIDER_INCOMPLETE_REASONS = new Set<string>(AI_PROVIDER_INCOMPLETE_REASON_VALUES);
const VALIDATION_FAILURE_STAGES = new Set<string>(AI_VALIDATION_FAILURE_STAGE_VALUES);
const REFUSAL_CATEGORIES = new Set<string>(AI_REFUSAL_CATEGORY_VALUES);
const SAFE_MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u;
const SAFE_PROVIDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,249}$/u;

function auditMappingFailure(message: string, cause?: unknown): AiError {
  return new AiError('AI_AUDIT_FAILED', message, cause === undefined ? {} : { cause });
}

function requireNonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new AiError('AI_AUDIT_FAILED', 'AI audit metadata is incomplete.', {
      details: { field },
    });
  }
}

function requireTimestamp(value: string | undefined, field: string): string {
  if (value === undefined || Number.isNaN(Date.parse(value))) {
    throw new AiError('AI_AUDIT_FAILED', 'AI audit timestamp is invalid.', {
      details: { field },
    });
  }
  return value;
}

export function calculateAiRunExpiresAt(startedAt: string, runRetentionDays: number): string {
  if (!Number.isSafeInteger(runRetentionDays) || runRetentionDays < 1 || runRetentionDays > 365) {
    throw new AiError('AI_AUDIT_FAILED', 'AI audit retention days are invalid.', {
      details: { field: 'AI_RUN_RETENTION_DAYS' },
    });
  }
  const startedAtMs = Date.parse(startedAt);
  if (Number.isNaN(startedAtMs)) {
    throw new AiError('AI_AUDIT_FAILED', 'AI audit startedAt is invalid.', {
      details: { field: 'startedAt' },
    });
  }
  return new Date(startedAtMs + runRetentionDays * DAY_MS).toISOString();
}

function validateCommonEvent(event: AiRunTelemetryEvent): void {
  requireNonEmpty(event.aiRunId, 'aiRunId');
  requireNonEmpty(event.configuredModel, 'configuredModel');
  if (!CONFIGURED_EFFORTS.has(event.configuredEffort)) {
    throw new AiError('AI_AUDIT_FAILED', 'AI audit configured effort is invalid.', {
      details: { field: 'configuredEffort' },
    });
  }
  if (event.provider === 'ANTHROPIC' && event.configuredEffort === 'none') {
    throw new AiError('AI_AUDIT_FAILED', 'AI audit configured effort is invalid.', {
      details: { field: 'configuredEffort' },
    });
  }
  requireNonEmpty(event.promptVersion, 'promptVersion');
  requireNonEmpty(event.schemaVersion, 'schemaVersion');
  if (!/^[a-f0-9]{64}$/.test(event.inputFingerprint)) {
    throw new AiError('AI_AUDIT_FAILED', 'AI audit fingerprint is invalid.', {
      details: { field: 'inputFingerprint' },
    });
  }
  requireTimestamp(event.startedAt, 'startedAt');
  if (
    !Number.isSafeInteger(event.configuredMaxOutputTokens) ||
    event.configuredMaxOutputTokens < 1 ||
    event.configuredMaxOutputTokens > 8_192
  ) {
    throw new AiError('AI_AUDIT_FAILED', 'AI audit configured token limit is invalid.', {
      details: { field: 'configuredMaxOutputTokens' },
    });
  }
  if (
    !Number.isSafeInteger(event.effectiveMaxOutputTokens) ||
    event.effectiveMaxOutputTokens < 1 ||
    event.effectiveMaxOutputTokens > event.configuredMaxOutputTokens
  ) {
    throw new AiError('AI_AUDIT_FAILED', 'AI audit effective token limit is invalid.', {
      details: { field: 'effectiveMaxOutputTokens' },
    });
  }
}

function validateOptionalTerminalMetadata(event: AiRunTelemetryEvent): void {
  if (event.refusal !== undefined) {
    const refusal = event.refusal as unknown;
    if (
      typeof refusal !== 'object' ||
      refusal === null ||
      Array.isArray(refusal) ||
      Object.keys(refusal).some((key) => key !== 'refused' && key !== 'category')
    ) {
      throw new AiError('AI_AUDIT_FAILED', 'AI audit refusal evidence is invalid.', {
        details: { field: 'refusal' },
      });
    }
    const { refused, category } = refusal as Record<string, unknown>;
    if (
      typeof refused !== 'boolean' ||
      (category !== undefined &&
        (typeof category !== 'string' || !REFUSAL_CATEGORIES.has(category))) ||
      (refused === false && category !== undefined)
    ) {
      throw new AiError('AI_AUDIT_FAILED', 'AI audit refusal evidence is invalid.', {
        details: { field: 'refusal' },
      });
    }
  }
  if (event.responseModel !== undefined && !SAFE_MODEL_PATTERN.test(event.responseModel)) {
    throw new AiError('AI_AUDIT_FAILED', 'AI audit response model is invalid.', {
      details: { field: 'responseModel' },
    });
  }
  for (const [field, value] of [
    ['providerRequestId', event.providerRequestId],
    ['providerResponseId', event.providerResponseId],
  ] as const) {
    if (value !== undefined && !SAFE_PROVIDER_ID_PATTERN.test(value)) {
      throw new AiError('AI_AUDIT_FAILED', 'AI audit provider identifier is invalid.', {
        details: { field },
      });
    }
  }
  if (
    event.providerResponseStatus !== undefined &&
    !PROVIDER_RESPONSE_STATUSES.has(event.providerResponseStatus)
  ) {
    throw new AiError('AI_AUDIT_FAILED', 'AI audit provider response status is invalid.', {
      details: { field: 'providerResponseStatus' },
    });
  }
  if (
    event.providerIncompleteReason !== undefined &&
    (!PROVIDER_INCOMPLETE_REASONS.has(event.providerIncompleteReason) ||
      event.providerResponseStatus !== 'INCOMPLETE')
  ) {
    throw new AiError('AI_AUDIT_FAILED', 'AI audit provider incomplete reason is invalid.', {
      details: { field: 'providerIncompleteReason' },
    });
  }
  if (
    event.latencyMs !== undefined &&
    (!Number.isSafeInteger(event.latencyMs) || event.latencyMs < 0)
  ) {
    throw new AiError('AI_AUDIT_FAILED', 'AI audit latency is invalid.', {
      details: { field: 'latencyMs' },
    });
  }
  if (
    event.attempts !== undefined &&
    (!Number.isSafeInteger(event.attempts) || event.attempts < 0)
  ) {
    throw new AiError('AI_AUDIT_FAILED', 'AI audit attempts are invalid.', {
      details: { field: 'attempts' },
    });
  }
  if (event.usage !== undefined) {
    const usageValues = [
      event.usage.inputTokens,
      event.usage.outputTokens,
      event.usage.totalTokens,
      event.usage.cacheReadTokens ?? 0,
      event.usage.cacheWriteTokens ?? 0,
      event.usage.reasoningTokens ?? 0,
    ];
    if (
      usageValues.some((value) => !Number.isSafeInteger(value) || value < 0) ||
      event.usage.totalTokens !== event.usage.inputTokens + event.usage.outputTokens
    ) {
      throw new AiError('AI_AUDIT_FAILED', 'AI audit usage is invalid.', {
        details: { field: 'usage' },
      });
    }
  }
  if (
    event.providerCallAttempted !== undefined &&
    typeof event.providerCallAttempted !== 'boolean'
  ) {
    throw new AiError('AI_AUDIT_FAILED', 'AI audit provider-call evidence is invalid.', {
      details: { field: 'providerCallAttempted' },
    });
  }
  if (
    event.validationFailureStage !== undefined &&
    !VALIDATION_FAILURE_STAGES.has(event.validationFailureStage)
  ) {
    throw new AiError('AI_AUDIT_FAILED', 'AI audit validation stage is invalid.', {
      details: { field: 'validationFailureStage' },
    });
  }
  if (
    event.status !== 'FAILED' &&
    (event.providerCallAttempted !== undefined || event.validationFailureStage !== undefined)
  ) {
    throw new AiError('AI_AUDIT_FAILED', 'AI failure evidence requires a FAILED audit event.', {
      details: {
        field:
          event.providerCallAttempted !== undefined
            ? 'providerCallAttempted'
            : 'validationFailureStage',
      },
    });
  }
  if (event.providerCallAttempted === false) {
    if (event.attempts !== 0) {
      throw new AiError('AI_AUDIT_FAILED', 'AI audit zero-call attempts are invalid.', {
        details: { field: 'attempts' },
      });
    }
    if (
      event.responseModel !== undefined ||
      event.providerRequestId !== undefined ||
      event.providerResponseId !== undefined ||
      event.providerResponseStatus !== undefined ||
      event.providerIncompleteReason !== undefined ||
      event.usage !== undefined ||
      event.refusal?.refused === true
    ) {
      throw new AiError(
        'AI_AUDIT_FAILED',
        'AI audit zero-call evidence contains provider response metadata.',
        { details: { field: 'providerCallAttempted' } },
      );
    }
  } else if (
    event.providerCallAttempted === true &&
    (event.attempts === undefined || event.attempts < 1)
  ) {
    throw new AiError('AI_AUDIT_FAILED', 'AI audit attempted-call count is invalid.', {
      details: { field: 'attempts' },
    });
  } else if (event.providerCallAttempted === undefined && event.attempts === 0) {
    throw new AiError('AI_AUDIT_FAILED', 'AI audit attempts are invalid.', {
      details: { field: 'attempts' },
    });
  }
  if (
    event.validationFailureStage === 'SCHEMA_CONSTRUCTION' &&
    event.providerCallAttempted !== false
  ) {
    throw new AiError('AI_AUDIT_FAILED', 'AI audit schema-construction evidence is invalid.', {
      details: { field: 'validationFailureStage' },
    });
  }
  if (
    event.validationFailureStage !== undefined &&
    event.validationFailureStage !== 'SCHEMA_CONSTRUCTION' &&
    (event.providerCallAttempted !== true || event.providerResponseStatus !== 'COMPLETED')
  ) {
    throw new AiError('AI_AUDIT_FAILED', 'AI audit post-response validation evidence is invalid.', {
      details: { field: 'validationFailureStage' },
    });
  }
}

export class PersistentAiRunRecorder implements AiRunRecorder {
  private readonly store: AiRunStore;
  private readonly runRetentionDays: number;

  constructor(store: AiRunStore, runRetentionDays: number) {
    this.store = store;
    this.runRetentionDays = runRetentionDays;
  }

  async record(event: AiRunTelemetryEvent): Promise<void> {
    try {
      validateCommonEvent(event);
      validateOptionalTerminalMetadata(event);
      if (event.status === 'STARTED') {
        await this.store.insertStarted({
          ID: event.aiRunId,
          ...(event.planningRunId === undefined ? {} : { planningRunId: event.planningRunId }),
          status: 'STARTED',
          taskType: event.taskType,
          provider: event.provider,
          configuredModel: event.configuredModel,
          configuredEffort: event.configuredEffort,
          configuredMaxOutputTokens: event.configuredMaxOutputTokens,
          effectiveMaxOutputTokens: event.effectiveMaxOutputTokens,
          promptVersion: event.promptVersion,
          schemaVersion: event.schemaVersion,
          inputFingerprint: event.inputFingerprint,
          startedAt: event.startedAt,
          expiresAt: calculateAiRunExpiresAt(event.startedAt, this.runRetentionDays),
          refusal: false,
        });
        return;
      }

      const completedAt = requireTimestamp(event.completedAt, 'completedAt');
      const refusal = event.refusal ?? { refused: false };
      if (event.status === 'SUCCEEDED') {
        if (event.responseModel === undefined) {
          throw new AiError(
            'AI_AUDIT_FAILED',
            'Successful AI audit metadata has no response model.',
            {
              details: { field: 'responseModel' },
            },
          );
        }
        requireNonEmpty(event.responseModel, 'responseModel');
        await this.store.completeSucceeded(event.aiRunId, {
          status: 'SUCCEEDED',
          responseModel: event.responseModel,
          completedAt,
          ...(event.usage === undefined ? {} : { usage: event.usage }),
          ...(event.latencyMs === undefined ? {} : { latencyMs: event.latencyMs }),
          ...(event.attempts === undefined ? {} : { attempts: event.attempts }),
          ...(event.providerRequestId === undefined
            ? {}
            : { providerRequestId: event.providerRequestId }),
          ...(event.providerResponseId === undefined
            ? {}
            : { providerResponseId: event.providerResponseId }),
          ...(event.providerResponseStatus === undefined
            ? {}
            : { providerResponseStatus: event.providerResponseStatus }),
          ...(event.providerIncompleteReason === undefined
            ? {}
            : { providerIncompleteReason: event.providerIncompleteReason }),
          refusal,
          retryable: false,
        });
        return;
      }

      if (event.errorCode === undefined || event.retryable === undefined) {
        throw new AiError('AI_AUDIT_FAILED', 'Failed AI audit metadata is incomplete.', {
          details: { field: event.errorCode === undefined ? 'errorCode' : 'retryable' },
        });
      }
      await this.store.completeFailed(event.aiRunId, {
        status: 'FAILED',
        completedAt,
        ...(event.responseModel === undefined ? {} : { responseModel: event.responseModel }),
        ...(event.usage === undefined ? {} : { usage: event.usage }),
        ...(event.latencyMs === undefined ? {} : { latencyMs: event.latencyMs }),
        ...(event.attempts === undefined ? {} : { attempts: event.attempts }),
        ...(event.providerRequestId === undefined
          ? {}
          : { providerRequestId: event.providerRequestId }),
        ...(event.providerResponseId === undefined
          ? {}
          : { providerResponseId: event.providerResponseId }),
        ...(event.providerResponseStatus === undefined
          ? {}
          : { providerResponseStatus: event.providerResponseStatus }),
        ...(event.providerIncompleteReason === undefined
          ? {}
          : { providerIncompleteReason: event.providerIncompleteReason }),
        ...(event.providerCallAttempted === undefined
          ? {}
          : { providerCallAttempted: event.providerCallAttempted }),
        ...(event.validationFailureStage === undefined
          ? {}
          : { validationFailureStage: event.validationFailureStage }),
        refusal,
        errorCode: event.errorCode,
        retryable: event.retryable,
      });
    } catch (cause) {
      if (cause instanceof AiError && cause.code === 'AI_AUDIT_FAILED') throw cause;
      throw auditMappingFailure('The AI audit event could not be recorded safely.', cause);
    }
  }
}
