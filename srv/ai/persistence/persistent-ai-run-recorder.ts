import { AiError } from '../errors.ts';
import type { AiRunRecorder, AiRunTelemetryEvent } from '../telemetry.ts';
import type { AiRunStore } from './ai-run-store.ts';

const DAY_MS = 24 * 60 * 60 * 1_000;

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
  requireNonEmpty(event.promptVersion, 'promptVersion');
  requireNonEmpty(event.schemaVersion, 'schemaVersion');
  if (!/^[a-f0-9]{64}$/.test(event.inputFingerprint)) {
    throw new AiError('AI_AUDIT_FAILED', 'AI audit fingerprint is invalid.', {
      details: { field: 'inputFingerprint' },
    });
  }
  requireTimestamp(event.startedAt, 'startedAt');
}

export class PersistentAiRunRecorder implements AiRunRecorder {
  constructor(
    private readonly store: AiRunStore,
    private readonly runRetentionDays: number,
  ) {}

  async record(event: AiRunTelemetryEvent): Promise<void> {
    try {
      validateCommonEvent(event);
      if (event.status === 'STARTED') {
        await this.store.insertStarted({
          ID: event.aiRunId,
          ...(event.planningRunId === undefined ? {} : { planningRunId: event.planningRunId }),
          status: 'STARTED',
          taskType: event.taskType,
          provider: event.provider,
          configuredModel: event.configuredModel,
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
