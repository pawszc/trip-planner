import type { AiEffort, AiProvider, AiRefusalState, AiTaskType, AiUsage } from '../contracts.ts';
import type { AiErrorCode } from '../errors.ts';
import type {
  AiProviderIncompleteReason,
  AiProviderResponseStatus,
  AiValidationFailureStage,
} from '../failure-execution-evidence.ts';

export interface AiRunStartedRecord {
  ID: string;
  planningRunId?: string;
  status: 'STARTED';
  taskType: AiTaskType;
  provider: AiProvider;
  configuredModel: string;
  configuredEffort: AiEffort;
  configuredMaxOutputTokens: number;
  effectiveMaxOutputTokens: number;
  promptVersion: string;
  schemaVersion: string;
  inputFingerprint: string;
  startedAt: string;
  expiresAt: string;
  refusal: false;
}

export interface AiRunSucceededUpdate {
  status: 'SUCCEEDED';
  responseModel: string;
  completedAt: string;
  usage?: AiUsage;
  latencyMs?: number;
  attempts?: number;
  providerRequestId?: string;
  providerResponseId?: string;
  providerResponseStatus?: AiProviderResponseStatus;
  providerIncompleteReason?: AiProviderIncompleteReason;
  refusal: AiRefusalState;
  retryable: false;
}

export interface AiRunFailedUpdate {
  status: 'FAILED';
  responseModel?: string;
  completedAt: string;
  usage?: AiUsage;
  latencyMs?: number;
  attempts?: number;
  providerRequestId?: string;
  providerResponseId?: string;
  providerResponseStatus?: AiProviderResponseStatus;
  providerIncompleteReason?: AiProviderIncompleteReason;
  providerCallAttempted?: boolean;
  validationFailureStage?: AiValidationFailureStage;
  refusal: AiRefusalState;
  errorCode: AiErrorCode;
  retryable: boolean;
}

export interface AiRunStore {
  insertStarted(record: AiRunStartedRecord): Promise<void>;
  completeSucceeded(ID: string, update: AiRunSucceededUpdate): Promise<void>;
  completeFailed(ID: string, update: AiRunFailedUpdate): Promise<void>;
  deleteExpired(now: string): Promise<number>;
}
