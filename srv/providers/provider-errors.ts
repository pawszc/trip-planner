import { parseStrictIsoDate } from '../validation/strict-iso-date.ts';

export const PROVIDER_FAILURE_CATEGORY_VALUES = [
  'CANCELLED',
  'TIMEOUT',
  'RATE_LIMITED',
  'UPSTREAM_4XX',
  'UPSTREAM_5XX',
  'NETWORK',
  'INVALID_SCHEMA',
  'PARTIAL_DESTINATION',
  'CALL_BUDGET_EXCEEDED',
  'INVALID_EXECUTION_POLICY',
] as const;
export type ProviderFailureCategory = (typeof PROVIDER_FAILURE_CATEGORY_VALUES)[number];

export const PROVIDER_OPERATION_VALUES = [
  'TRANSPORT_SEARCH',
  'ACCOMMODATION_SEARCH',
  'PLACES_SEARCH',
] as const;
export type ProviderOperation = (typeof PROVIDER_OPERATION_VALUES)[number];

export interface ProviderRateLimitEvidence {
  retryAfterMs: number | null;
  limit: number | null;
  remaining: number | null;
  resetAt: string | null;
}

export interface ProviderFailureEvidence {
  providerKey: string;
  operation: ProviderOperation;
  callSequence: number;
  providerCallAttempted: boolean;
  attempts: 0 | 1;
  latencyMs: number;
  httpStatus: number | null;
  destinationCode: string | null;
  underlyingCategory: ProviderFailureCategory | null;
  rateLimit: ProviderRateLimitEvidence | null;
}

export interface SafeProviderExecutionError {
  name: 'ProviderExecutionError';
  category: ProviderFailureCategory;
  message: string;
  retryable: boolean;
  evidence: ProviderFailureEvidence;
}

const CATEGORY_MESSAGES: Readonly<Record<ProviderFailureCategory, string>> = Object.freeze({
  CANCELLED: 'Provider call was cancelled.',
  TIMEOUT: 'Provider call exceeded the configured timeout.',
  RATE_LIMITED: 'Provider rate-limited the call.',
  UPSTREAM_4XX: 'Provider rejected the call.',
  UPSTREAM_5XX: 'Provider is temporarily unavailable.',
  NETWORK: 'Provider call failed before a valid result was available.',
  INVALID_SCHEMA: 'Provider result did not match the local schema.',
  PARTIAL_DESTINATION: 'A destination-scoped provider call failed.',
  CALL_BUDGET_EXCEEDED: 'Provider call budget was exceeded.',
  INVALID_EXECUTION_POLICY: 'Provider execution policy is invalid.',
});

const RETRYABLE_CATEGORIES = new Set<ProviderFailureCategory>([
  'TIMEOUT',
  'RATE_LIMITED',
  'UPSTREAM_5XX',
  'NETWORK',
]);

function safeNonNegativeInteger(value: unknown, fallback = 0): number {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : fallback;
}

function safeNullableNonNegativeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : null;
}

function safeHttpStatus(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 100 && (value as number) <= 599
    ? (value as number)
    : null;
}

function safeIdentifier(value: unknown, maximum: number): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length > 0 &&
    normalized.length <= maximum &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(normalized)
    ? normalized
    : null;
}

function safeIsoInstant(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?Z$/.exec(normalized);
  if (
    match === null ||
    parseStrictIsoDate(match[1] ?? '') === null ||
    Number(match[2]) > 23 ||
    Number(match[3]) > 59 ||
    Number(match[4]) > 59
  ) {
    return null;
  }
  return Number.isFinite(Date.parse(normalized)) ? normalized : null;
}

export interface ProviderExecutionErrorInput {
  category: ProviderFailureCategory;
  providerKey: string;
  operation: ProviderOperation;
  callSequence: number;
  providerCallAttempted: boolean;
  latencyMs?: number;
  httpStatus?: number | null;
  destinationCode?: string | null;
  underlyingCategory?: ProviderFailureCategory | null;
  rateLimit?: Partial<ProviderRateLimitEvidence> | null;
}

/**
 * Closed provider failure. It deliberately accepts no raw cause, response, headers or message,
 * so CAP-facing handling and persistence cannot accidentally serialize upstream content.
 */
export class ProviderExecutionError extends Error {
  public readonly category: ProviderFailureCategory;
  public readonly retryable: boolean;
  public readonly evidence: ProviderFailureEvidence;

  constructor(input: ProviderExecutionErrorInput) {
    const category = PROVIDER_FAILURE_CATEGORY_VALUES.includes(input.category)
      ? input.category
      : 'NETWORK';
    const operation = PROVIDER_OPERATION_VALUES.includes(input.operation)
      ? input.operation
      : 'TRANSPORT_SEARCH';
    const attempted = input.providerCallAttempted === true;
    const underlyingCategory =
      input.underlyingCategory !== null &&
      input.underlyingCategory !== undefined &&
      PROVIDER_FAILURE_CATEGORY_VALUES.includes(input.underlyingCategory)
        ? input.underlyingCategory
        : null;
    super(CATEGORY_MESSAGES[category]);
    this.name = 'ProviderExecutionError';
    this.category = category;
    this.retryable = RETRYABLE_CATEGORIES.has(category);
    this.evidence = Object.freeze({
      providerKey: safeIdentifier(input.providerKey, 160) ?? 'UNKNOWN_PROVIDER',
      operation,
      callSequence: safeNonNegativeInteger(input.callSequence),
      providerCallAttempted: attempted,
      attempts: attempted ? 1 : 0,
      latencyMs: safeNonNegativeInteger(input.latencyMs),
      httpStatus: safeHttpStatus(input.httpStatus),
      destinationCode: safeIdentifier(input.destinationCode, 12),
      underlyingCategory,
      rateLimit:
        input.rateLimit === null || input.rateLimit === undefined
          ? null
          : Object.freeze({
              retryAfterMs: safeNullableNonNegativeInteger(input.rateLimit.retryAfterMs),
              limit: safeNullableNonNegativeInteger(input.rateLimit.limit),
              remaining: safeNullableNonNegativeInteger(input.rateLimit.remaining),
              resetAt: safeIsoInstant(input.rateLimit.resetAt),
            }),
    });
  }

  public toSafeJSON(): SafeProviderExecutionError {
    return {
      name: 'ProviderExecutionError',
      category: this.category,
      message: this.message,
      retryable: this.retryable,
      evidence: this.evidence,
    };
  }

  public override toString(): string {
    return `${this.name} [${this.category}]: ${this.message}`;
  }
}

export interface ProviderHttpFailureMetadata {
  status?: number;
  rateLimit?: Partial<ProviderRateLimitEvidence>;
}

/** Maps only explicit transport metadata; raw thrown text never participates in classification. */
export function providerFailureFromHttpMetadata(
  input: Omit<ProviderExecutionErrorInput, 'category' | 'httpStatus' | 'rateLimit'> &
    ProviderHttpFailureMetadata,
): ProviderExecutionError {
  const status = safeHttpStatus(input.status);
  const category: ProviderFailureCategory =
    status === 429
      ? 'RATE_LIMITED'
      : status !== null && status >= 400 && status < 500
        ? 'UPSTREAM_4XX'
        : status !== null && status >= 500
          ? 'UPSTREAM_5XX'
          : 'NETWORK';
  return new ProviderExecutionError({
    ...input,
    category,
    httpStatus: status,
    rateLimit: category === 'RATE_LIMITED' ? (input.rateLimit ?? {}) : null,
  });
}
