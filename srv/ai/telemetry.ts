import type { AiEffort, AiProvider, AiRefusalState, AiTaskType, AiUsage } from './contracts.ts';
import type { AiErrorCode } from './errors.ts';

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
  refusal?: AiRefusalState;
  errorCode?: AiErrorCode;
  retryable?: boolean;
}

export interface AiRunRecorder {
  record(event: AiRunTelemetryEvent): Promise<void>;
}

export class NoopAiRunRecorder implements AiRunRecorder {
  record(..._arguments: [AiRunTelemetryEvent]): Promise<void> {
    void _arguments;
    return Promise.resolve();
  }
}
