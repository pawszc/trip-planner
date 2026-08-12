import type { AiErrorCode } from './errors.ts';
import type { AiProvider, AiRefusalState, AiTaskType, AiUsage } from './contracts.ts';

export type AiRunStatus = 'STARTED' | 'SUCCEEDED' | 'FAILED';

/** Deliberately excludes raw input, prompts, output and provider response bodies. */
export interface AiRunTelemetryEvent {
  status: AiRunStatus;
  provider: AiProvider;
  model: string;
  taskType: AiTaskType;
  promptVersion: string;
  schemaVersion: string;
  inputFingerprint: string;
  latencyMs?: number;
  attempts?: number;
  usage?: AiUsage;
  providerRequestId?: string;
  refusal?: AiRefusalState;
  errorCode?: AiErrorCode;
}

export interface AiRunRecorder {
  record(event: AiRunTelemetryEvent): void;
}

export class NoopAiRunRecorder implements AiRunRecorder {
  record(): void {}
}
