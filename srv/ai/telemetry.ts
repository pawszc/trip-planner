import type {
  AiEffort,
  AiProvider,
  AiRefusalState,
  AiTaskType,
  AiUsage,
  ProfiledAiTaskType,
} from './contracts.ts';
import type { AiErrorCode } from './errors.ts';
import type {
  AiProviderIncompleteReason,
  AiProviderResponseStatus,
  AiValidationFailureStage,
} from './failure-execution-evidence.ts';

export type AiRunStatus = 'STARTED' | 'SUCCEEDED' | 'FAILED';

/** Deliberately excludes raw input, instructions, prompts, output, errors and response bodies. */
export interface AiRunTelemetryEvent {
  aiRunId: string;
  planningRunId?: string;
  status: AiRunStatus;
  provider: AiProvider;
  configuredModel: string;
  configuredEffort: AiEffort;
  configuredMaxOutputTokens: number;
  effectiveMaxOutputTokens: number;
  responseModel?: string;
  taskType: AiTaskType;
  promptVersion: string;
  schemaVersion: string;
  inputFingerprint: string;
  startedAt: string;
  completedAt?: string;
  latencyMs?: number;
  attempts?: number;
  usage?: AiUsage;
  providerRequestId?: string;
  providerResponseId?: string;
  providerResponseStatus?: AiProviderResponseStatus;
  providerIncompleteReason?: AiProviderIncompleteReason;
  providerCallAttempted?: boolean;
  validationFailureStage?: AiValidationFailureStage;
  refusal?: AiRefusalState;
  errorCode?: AiErrorCode;
  retryable?: boolean;
}

export interface AiRunRecorder {
  record(event: AiRunTelemetryEvent): Promise<void>;
}

export const AI_PRE_START_FAILURE_CODE_VALUES = [
  'AI_DISABLED',
  'INVALID_AI_CONFIGURATION',
  'UNSUPPORTED_AI_PROVIDER',
  'AI_AUDIT_FAILED',
] as const satisfies readonly AiErrorCode[];

export type AiPreStartFailureCode = (typeof AI_PRE_START_FAILURE_CODE_VALUES)[number];
export type NarrativeAiTaskType = Extract<ProfiledAiTaskType, 'GENERATE' | 'JUDGE'>;

/**
 * Closed operational evidence for a narrative call that never reached durable AiRuns.STARTED.
 * There is intentionally no slot for an AiRun ID, prompt/input/output, error text or cause.
 */
export interface AiPreStartFailureSignal {
  readonly eventType: 'AI_PRE_START_FAILURE';
  readonly stage: 'BEFORE_DURABLE_STARTED';
  readonly taskType: NarrativeAiTaskType;
  readonly failureCode: AiPreStartFailureCode;
  readonly planningRunId?: string;
  readonly rankedOptionId?: string;
  readonly promptVersion: string;
  readonly schemaVersion: string;
  readonly inputFingerprint?: string;
  readonly providerCallAttempted: false;
  readonly occurredAt: string;
}

export interface AiOperationalSignalSink {
  emit(signal: AiPreStartFailureSignal): Promise<void>;
}

export class NoopAiOperationalSignalSink implements AiOperationalSignalSink {
  emit(..._arguments: [AiPreStartFailureSignal]): Promise<void> {
    void _arguments;
    return Promise.resolve();
  }
}

/** Default production sink: emits only the closed, privacy-safe signal to operational stderr. */
export class ConsoleAiOperationalSignalSink implements AiOperationalSignalSink {
  emit(signal: AiPreStartFailureSignal): Promise<void> {
    console.error(JSON.stringify(signal));
    return Promise.resolve();
  }
}

export class NoopAiRunRecorder implements AiRunRecorder {
  record(..._arguments: [AiRunTelemetryEvent]): Promise<void> {
    void _arguments;
    return Promise.resolve();
  }
}
