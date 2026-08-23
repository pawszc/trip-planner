import { AiProvider, type AiUsage } from './contracts.ts';

export const AI_PROVIDER_RESPONSE_STATUS_VALUES = [
  'COMPLETED',
  'INCOMPLETE',
  'FAILED',
  'CANCELLED',
  'QUEUED',
  'IN_PROGRESS',
  'UNKNOWN',
] as const;

export type AiProviderResponseStatus = (typeof AI_PROVIDER_RESPONSE_STATUS_VALUES)[number];

export const AI_PROVIDER_INCOMPLETE_REASON_VALUES = [
  'MAX_OUTPUT_TOKENS',
  'CONTENT_FILTER',
  'UNKNOWN',
] as const;

export type AiProviderIncompleteReason = (typeof AI_PROVIDER_INCOMPLETE_REASON_VALUES)[number];

export const AI_FAILURE_REFUSAL_CATEGORY_VALUES = [
  'content_filter',
  'model_refusal',
  'unknown',
] as const;

export type AiFailureRefusalCategory = (typeof AI_FAILURE_REFUSAL_CATEGORY_VALUES)[number];

export interface AiFailureExecutionEvidence {
  readonly provider: AiProvider;
  readonly configuredModel: string;
  readonly responseModel?: string;
  readonly providerResponseStatus?: AiProviderResponseStatus;
  readonly providerIncompleteReason?: AiProviderIncompleteReason;
  readonly providerRequestId?: string;
  readonly providerResponseId?: string;
  readonly usage?: Readonly<Required<AiUsage>>;
  readonly attempts?: number;
  readonly latencyMs?: number;
  readonly refusalCategory?: AiFailureRefusalCategory;
}

const EVIDENCE_KEYS = new Set([
  'provider',
  'configuredModel',
  'responseModel',
  'providerResponseStatus',
  'providerIncompleteReason',
  'providerRequestId',
  'providerResponseId',
  'usage',
  'attempts',
  'latencyMs',
  'refusalCategory',
]);
const USAGE_KEYS = new Set([
  'inputTokens',
  'outputTokens',
  'totalTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'reasoningTokens',
]);
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u;
const PROVIDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,249}$/u;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireExactKeys(record: Readonly<Record<string, unknown>>, allowed: Set<string>): void {
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    throw new TypeError('AI failure execution evidence contains a forbidden field.');
  }
}

function requireSafeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`AI failure execution evidence ${field} is invalid.`);
  }
  return value as number;
}

function optionalPattern(value: unknown, pattern: RegExp, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new TypeError(`AI failure execution evidence ${field} is invalid.`);
  }
  return value;
}

function parseUsage(value: unknown): Readonly<Required<AiUsage>> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new TypeError('AI failure execution evidence usage is invalid.');
  }
  requireExactKeys(value, USAGE_KEYS);
  const usage = {
    inputTokens: requireSafeInteger(value.inputTokens, 'usage.inputTokens'),
    outputTokens: requireSafeInteger(value.outputTokens, 'usage.outputTokens'),
    totalTokens: requireSafeInteger(value.totalTokens, 'usage.totalTokens'),
    cacheReadTokens: requireSafeInteger(value.cacheReadTokens, 'usage.cacheReadTokens'),
    cacheWriteTokens: requireSafeInteger(value.cacheWriteTokens, 'usage.cacheWriteTokens'),
    reasoningTokens: requireSafeInteger(value.reasoningTokens, 'usage.reasoningTokens'),
  };
  if (usage.totalTokens !== usage.inputTokens + usage.outputTokens) {
    throw new TypeError('AI failure execution evidence usage total is inconsistent.');
  }
  return Object.freeze(usage);
}

function optionalClosedValue<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
): T | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new TypeError(`AI failure execution evidence ${field} is invalid.`);
  }
  return value as T;
}

/**
 * Runtime-enforced allowlist for terminal provider metadata. Unknown fields and raw content are
 * rejected instead of being copied into errors, telemetry or persistence.
 */
export function parseAiFailureExecutionEvidence(value: unknown): AiFailureExecutionEvidence {
  if (!isRecord(value)) {
    throw new TypeError('AI failure execution evidence must be an object.');
  }
  requireExactKeys(value, EVIDENCE_KEYS);
  if (value.provider !== AiProvider.OPENAI && value.provider !== AiProvider.ANTHROPIC) {
    throw new TypeError('AI failure execution evidence provider is invalid.');
  }
  const configuredModel = optionalPattern(value.configuredModel, MODEL_PATTERN, 'configuredModel');
  if (configuredModel === undefined) {
    throw new TypeError('AI failure execution evidence configuredModel is required.');
  }
  const responseModel = optionalPattern(value.responseModel, MODEL_PATTERN, 'responseModel');
  const providerRequestId = optionalPattern(
    value.providerRequestId,
    PROVIDER_ID_PATTERN,
    'providerRequestId',
  );
  const providerResponseId = optionalPattern(
    value.providerResponseId,
    PROVIDER_ID_PATTERN,
    'providerResponseId',
  );
  const providerResponseStatus = optionalClosedValue(
    value.providerResponseStatus,
    AI_PROVIDER_RESPONSE_STATUS_VALUES,
    'providerResponseStatus',
  );
  const providerIncompleteReason = optionalClosedValue(
    value.providerIncompleteReason,
    AI_PROVIDER_INCOMPLETE_REASON_VALUES,
    'providerIncompleteReason',
  );
  const refusalCategory = optionalClosedValue(
    value.refusalCategory,
    AI_FAILURE_REFUSAL_CATEGORY_VALUES,
    'refusalCategory',
  );
  if (providerIncompleteReason !== undefined && providerResponseStatus !== 'INCOMPLETE') {
    throw new TypeError(
      'AI failure execution evidence providerIncompleteReason requires INCOMPLETE status.',
    );
  }
  const usage = parseUsage(value.usage);
  const attempts =
    value.attempts === undefined ? undefined : requireSafeInteger(value.attempts, 'attempts');
  const latencyMs =
    value.latencyMs === undefined ? undefined : requireSafeInteger(value.latencyMs, 'latencyMs');

  return Object.freeze({
    provider: value.provider,
    configuredModel,
    ...(responseModel === undefined ? {} : { responseModel }),
    ...(providerResponseStatus === undefined ? {} : { providerResponseStatus }),
    ...(providerIncompleteReason === undefined ? {} : { providerIncompleteReason }),
    ...(providerRequestId === undefined ? {} : { providerRequestId }),
    ...(providerResponseId === undefined ? {} : { providerResponseId }),
    ...(usage === undefined ? {} : { usage }),
    ...(attempts === undefined ? {} : { attempts }),
    ...(latencyMs === undefined ? {} : { latencyMs }),
    ...(refusalCategory === undefined ? {} : { refusalCategory }),
  });
}
