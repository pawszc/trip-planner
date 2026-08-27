import {
  PROVIDER_OPERATION_VALUES,
  ProviderExecutionError,
  type ProviderFailureCategory,
  type ProviderOperation,
} from './provider-errors.ts';
import { isSha256Fingerprint } from './provider-fingerprint.ts';

export const PROVIDER_EXECUTION_POLICY_VERSION = 'provider-execution-policy-v1';

export interface ProviderExecutionPolicy {
  version: typeof PROVIDER_EXECUTION_POLICY_VERSION;
  timeoutMs: number;
  maxCallsPerRun: number;
  maxConcurrency: number;
  maxAttemptsPerCall: 1;
  rateLimitStrategy: 'FAIL_FAST';
  fallbackStrategy: 'NONE';
}

export const DEFAULT_PROVIDER_EXECUTION_POLICY: ProviderExecutionPolicy = Object.freeze({
  version: PROVIDER_EXECUTION_POLICY_VERSION,
  timeoutMs: 10_000,
  maxCallsPerRun: 25,
  maxConcurrency: 4,
  maxAttemptsPerCall: 1,
  rateLimitStrategy: 'FAIL_FAST',
  fallbackStrategy: 'NONE',
});

export type ProviderExecutionPolicyOverride = Partial<
  Pick<ProviderExecutionPolicy, 'timeoutMs' | 'maxCallsPerRun' | 'maxConcurrency'>
>;

export interface ProviderUpstreamAttemptOptions {
  signal: AbortSignal;
}

export interface ProviderUpstreamCallDescriptor<T> {
  queryFingerprint: string;
  resultFingerprint: (result: T) => string;
  resultCount: (result: T) => number;
}

/**
 * Adapter-facing run-scoped upstream seam. Every real network/transport attempt must pass through
 * `executeUpstream`; the adapter never receives an unbudgeted HTTP client from orchestration.
 */
export interface ProviderCallOptions {
  signal: AbortSignal;
  executeUpstream<T>(
    descriptor: ProviderUpstreamCallDescriptor<T>,
    invoke: (options: ProviderUpstreamAttemptOptions) => Promise<T>,
  ): Promise<T>;
}

export interface ProviderCallDescriptor<T> {
  providerKey: string;
  operation: ProviderOperation;
  destinationCode?: string | null;
  queryFingerprint: string;
  resultFingerprint: (result: T) => string;
  resultCount: (result: T) => number;
}

export const PROVIDER_CALL_AUDIT_STATUS_VALUES = [
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'BLOCKED',
] as const;
export type ProviderCallAuditStatus = (typeof PROVIDER_CALL_AUDIT_STATUS_VALUES)[number];

/** Closed, persistence-safe metadata. No request/response/error payload field exists. */
export interface ProviderCallAuditEvent {
  sequence: number;
  policyVersion: typeof PROVIDER_EXECUTION_POLICY_VERSION;
  providerKey: string;
  operation: ProviderOperation;
  destinationCode: string | null;
  status: ProviderCallAuditStatus;
  providerCallAttempted: boolean;
  attempts: 0 | 1;
  latencyMs: number;
  queryFingerprint: string;
  resultFingerprint: string | null;
  resultCount: number | null;
  failureCategory: ProviderFailureCategory | null;
  underlyingFailureCategory: ProviderFailureCategory | null;
  httpStatus: number | null;
  rateLimitRetryAfterMs: number | null;
  rateLimitLimit: number | null;
  rateLimitRemaining: number | null;
  rateLimitResetAt: string | null;
}

interface QueueWaiter {
  resolve: () => void;
  reject: (error: ProviderExecutionError) => void;
  descriptor: ProviderCallDescriptor<unknown>;
  sequence: number;
}

function executionPolicyError(): ProviderExecutionError {
  return new ProviderExecutionError({
    category: 'INVALID_EXECUTION_POLICY',
    providerKey: 'PROVIDER_EXECUTION_POLICY',
    operation: 'TRANSPORT_SEARCH',
    callSequence: 0,
    providerCallAttempted: false,
  });
}

function safeDescriptor<T>(descriptor: ProviderCallDescriptor<T>): boolean {
  const safeIdentifier = (value: unknown, maximum: number): boolean =>
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximum &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
  return (
    safeIdentifier(descriptor.providerKey, 160) &&
    PROVIDER_OPERATION_VALUES.includes(descriptor.operation) &&
    (descriptor.destinationCode === undefined ||
      descriptor.destinationCode === null ||
      safeIdentifier(descriptor.destinationCode, 12)) &&
    isSha256Fingerprint(descriptor.queryFingerprint) &&
    typeof descriptor.resultFingerprint === 'function' &&
    typeof descriptor.resultCount === 'function'
  );
}

export function resolveProviderExecutionPolicy(
  override: ProviderExecutionPolicyOverride = {},
): ProviderExecutionPolicy {
  if (typeof override !== 'object' || override === null || Array.isArray(override)) {
    throw executionPolicyError();
  }
  const allowedOverrideKeys = new Set([
    'version',
    'timeoutMs',
    'maxCallsPerRun',
    'maxConcurrency',
    'maxAttemptsPerCall',
    'rateLimitStrategy',
    'fallbackStrategy',
  ]);
  if (Object.keys(override).some((key) => !allowedOverrideKeys.has(key))) {
    throw executionPolicyError();
  }
  const runtimePolicy = override as ProviderExecutionPolicyOverride &
    Partial<ProviderExecutionPolicy>;
  if (
    (runtimePolicy.version !== undefined &&
      runtimePolicy.version !== PROVIDER_EXECUTION_POLICY_VERSION) ||
    (runtimePolicy.maxAttemptsPerCall !== undefined && runtimePolicy.maxAttemptsPerCall !== 1) ||
    (runtimePolicy.rateLimitStrategy !== undefined &&
      runtimePolicy.rateLimitStrategy !== 'FAIL_FAST') ||
    (runtimePolicy.fallbackStrategy !== undefined && runtimePolicy.fallbackStrategy !== 'NONE')
  ) {
    throw executionPolicyError();
  }
  const policy: ProviderExecutionPolicy = {
    ...DEFAULT_PROVIDER_EXECUTION_POLICY,
    timeoutMs: override.timeoutMs ?? DEFAULT_PROVIDER_EXECUTION_POLICY.timeoutMs,
    maxCallsPerRun: override.maxCallsPerRun ?? DEFAULT_PROVIDER_EXECUTION_POLICY.maxCallsPerRun,
    maxConcurrency: override.maxConcurrency ?? DEFAULT_PROVIDER_EXECUTION_POLICY.maxConcurrency,
  };
  const boundedPositiveInteger = (value: number, maximum: number): boolean =>
    Number.isSafeInteger(value) && value > 0 && value <= maximum;
  if (
    !boundedPositiveInteger(policy.timeoutMs, DEFAULT_PROVIDER_EXECUTION_POLICY.timeoutMs) ||
    !boundedPositiveInteger(
      policy.maxCallsPerRun,
      DEFAULT_PROVIDER_EXECUTION_POLICY.maxCallsPerRun,
    ) ||
    !boundedPositiveInteger(policy.maxConcurrency, DEFAULT_PROVIDER_EXECUTION_POLICY.maxConcurrency)
  ) {
    throw executionPolicyError();
  }
  return Object.freeze(policy);
}

function elapsedMilliseconds(startedAt: number, now: () => number): number {
  const elapsed = Math.max(0, Math.floor(now() - startedAt));
  return Number.isSafeInteger(elapsed) ? elapsed : 0;
}

function normalizeResultCount(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError('Provider result count must be a non-negative safe integer.');
  }
  return value;
}

export interface ProviderExecutionScopeOptions {
  policy?: ProviderExecutionPolicyOverride;
  signal?: AbortSignal;
  now?: () => number;
}

/** Run-scoped FIFO budget/concurrency/timeout boundary. It never retries or falls back. */
export class ProviderExecutionScope {
  public readonly policy: ProviderExecutionPolicy;
  private readonly rootController = new AbortController();
  private readonly now: () => number;
  private readonly externalSignal: AbortSignal | undefined;
  private readonly externalAbortListener: (() => void) | undefined;
  private readonly queue: QueueWaiter[] = [];
  private readonly events: ProviderCallAuditEvent[] = [];
  private activeCalls = 0;
  private reservedCalls = 0;

  constructor(options: ProviderExecutionScopeOptions = {}) {
    this.policy = resolveProviderExecutionPolicy(options.policy);
    this.now = options.now ?? (() => Date.now());
    this.externalSignal = options.signal;
    this.externalAbortListener =
      options.signal !== undefined && !options.signal.aborted ? () => this.cancel() : undefined;
    if (options.signal?.aborted) {
      this.rootController.abort();
    } else if (options.signal !== undefined && this.externalAbortListener !== undefined) {
      options.signal.addEventListener('abort', this.externalAbortListener, { once: true });
    }
  }

  public assertCallBudget(plannedCalls: number): void {
    if (
      !Number.isSafeInteger(plannedCalls) ||
      plannedCalls < 0 ||
      plannedCalls > this.policy.maxCallsPerRun
    ) {
      throw new ProviderExecutionError({
        category: 'CALL_BUDGET_EXCEEDED',
        providerKey: 'PROVIDER_EXECUTION_SCOPE',
        operation: 'TRANSPORT_SEARCH',
        callSequence: 0,
        providerCallAttempted: false,
      });
    }
  }

  public cancel(): void {
    if (!this.rootController.signal.aborted) {
      this.rootController.abort();
    }
    this.drainCancelledQueue();
  }

  /** Releases the optional parent-signal listener after the run has settled. */
  public dispose(): void {
    if (this.externalSignal !== undefined && this.externalAbortListener !== undefined) {
      this.externalSignal.removeEventListener('abort', this.externalAbortListener);
    }
  }

  public getAuditEvents(): readonly ProviderCallAuditEvent[] {
    return Object.freeze(
      [...this.events]
        .sort((left, right) => left.sequence - right.sequence)
        .map((event) => Object.freeze({ ...event })),
    );
  }

  public get signal(): AbortSignal {
    return this.rootController.signal;
  }

  public async execute<T>(
    descriptor: ProviderCallDescriptor<T>,
    invoke: (options: ProviderUpstreamAttemptOptions) => Promise<T>,
  ): Promise<T> {
    if (!safeDescriptor(descriptor)) {
      throw executionPolicyError();
    }
    const sequence = ++this.reservedCalls;
    if (sequence > this.policy.maxCallsPerRun) {
      const error = new ProviderExecutionError({
        category: 'CALL_BUDGET_EXCEEDED',
        providerKey: descriptor.providerKey,
        operation: descriptor.operation,
        callSequence: sequence,
        providerCallAttempted: false,
        destinationCode: descriptor.destinationCode ?? null,
      });
      this.recordFailure(descriptor, error, 'BLOCKED');
      this.cancel();
      throw error;
    }

    try {
      await this.acquire(descriptor, sequence);
    } catch (error) {
      const safeError =
        error instanceof ProviderExecutionError
          ? error
          : this.createError(descriptor, sequence, 'CANCELLED', false, 0);
      this.recordFailure(descriptor, safeError, 'CANCELLED');
      throw safeError;
    }

    const startedAt = this.now();
    const callController = new AbortController();
    let timedOut = false;
    let providerCallAttempted = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let rejectCancelledListener: (() => void) | undefined;
    const cancelActive = (): void => callController.abort();
    this.rootController.signal.addEventListener('abort', cancelActive, { once: true });

    try {
      if (this.rootController.signal.aborted) {
        throw this.createError(descriptor, sequence, 'CANCELLED', false, 0);
      }
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          callController.abort();
          reject(
            this.createError(
              descriptor,
              sequence,
              'TIMEOUT',
              providerCallAttempted,
              elapsedMilliseconds(startedAt, this.now),
            ),
          );
        }, this.policy.timeoutMs);
      });
      const cancellation = new Promise<never>((_resolve, reject) => {
        const rejectCancelled = (): void => {
          reject(
            this.createError(
              descriptor,
              sequence,
              'CANCELLED',
              providerCallAttempted,
              elapsedMilliseconds(startedAt, this.now),
            ),
          );
        };
        rejectCancelledListener = rejectCancelled;
        if (this.rootController.signal.aborted) rejectCancelled();
        else this.rootController.signal.addEventListener('abort', rejectCancelled, { once: true });
      });
      const result = await Promise.race([
        Promise.resolve().then(() => {
          if (this.rootController.signal.aborted) {
            throw this.createError(descriptor, sequence, 'CANCELLED', false, 0);
          }
          providerCallAttempted = true;
          return invoke({ signal: callController.signal });
        }),
        timeout,
        cancellation,
      ]);
      let resultFingerprint: string;
      let resultCount: number;
      try {
        resultFingerprint = descriptor.resultFingerprint(result);
        resultCount = normalizeResultCount(descriptor.resultCount(result));
      } catch {
        throw this.createError(
          descriptor,
          sequence,
          'INVALID_SCHEMA',
          true,
          elapsedMilliseconds(startedAt, this.now),
        );
      }
      if (!isSha256Fingerprint(resultFingerprint)) {
        throw this.createError(
          descriptor,
          sequence,
          'INVALID_SCHEMA',
          true,
          elapsedMilliseconds(startedAt, this.now),
        );
      }
      this.events.push({
        sequence,
        policyVersion: this.policy.version,
        providerKey: descriptor.providerKey,
        operation: descriptor.operation,
        destinationCode: descriptor.destinationCode ?? null,
        status: 'SUCCEEDED',
        providerCallAttempted: true,
        attempts: 1,
        latencyMs: elapsedMilliseconds(startedAt, this.now),
        queryFingerprint: descriptor.queryFingerprint,
        resultFingerprint,
        resultCount,
        failureCategory: null,
        underlyingFailureCategory: null,
        httpStatus: null,
        rateLimitRetryAfterMs: null,
        rateLimitLimit: null,
        rateLimitRemaining: null,
        rateLimitResetAt: null,
      });
      return result;
    } catch (error) {
      const attempted =
        providerCallAttempted ||
        (error instanceof ProviderExecutionError && error.evidence.providerCallAttempted);
      const latencyMs = attempted ? elapsedMilliseconds(startedAt, this.now) : 0;
      let safeError: ProviderExecutionError;
      if (error instanceof ProviderExecutionError) {
        const category =
          descriptor.destinationCode !== undefined &&
          descriptor.destinationCode !== null &&
          error.category !== 'CANCELLED' &&
          error.category !== 'PARTIAL_DESTINATION'
            ? 'PARTIAL_DESTINATION'
            : error.category;
        safeError = new ProviderExecutionError({
          category,
          providerKey: descriptor.providerKey,
          operation: descriptor.operation,
          callSequence: sequence,
          providerCallAttempted: attempted,
          latencyMs,
          httpStatus: error.evidence.httpStatus,
          destinationCode: descriptor.destinationCode ?? null,
          underlyingCategory:
            category === 'PARTIAL_DESTINATION'
              ? error.category === 'PARTIAL_DESTINATION'
                ? error.evidence.underlyingCategory
                : error.category
              : error.evidence.underlyingCategory,
          rateLimit: error.evidence.rateLimit,
        });
      } else {
        const underlyingCategory = timedOut
          ? 'TIMEOUT'
          : this.rootController.signal.aborted
            ? 'CANCELLED'
            : 'NETWORK';
        const destinationFailure =
          descriptor.destinationCode !== undefined &&
          descriptor.destinationCode !== null &&
          underlyingCategory !== 'CANCELLED';
        safeError = new ProviderExecutionError({
          category: destinationFailure ? 'PARTIAL_DESTINATION' : underlyingCategory,
          providerKey: descriptor.providerKey,
          operation: descriptor.operation,
          callSequence: sequence,
          providerCallAttempted: attempted,
          latencyMs,
          destinationCode: descriptor.destinationCode ?? null,
          underlyingCategory: destinationFailure ? underlyingCategory : null,
        });
      }
      this.recordFailure(
        descriptor,
        safeError,
        safeError.category === 'CANCELLED' ? 'CANCELLED' : 'FAILED',
      );
      if (safeError.category !== 'CANCELLED') this.cancel();
      throw safeError;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      this.rootController.signal.removeEventListener('abort', cancelActive);
      if (rejectCancelledListener !== undefined) {
        this.rootController.signal.removeEventListener('abort', rejectCancelledListener);
      }
      this.release();
    }
  }

  private createError<T>(
    descriptor: ProviderCallDescriptor<T>,
    sequence: number,
    category: ProviderFailureCategory,
    providerCallAttempted: boolean,
    latencyMs: number,
  ): ProviderExecutionError {
    return new ProviderExecutionError({
      category,
      providerKey: descriptor.providerKey,
      operation: descriptor.operation,
      callSequence: sequence,
      providerCallAttempted,
      latencyMs,
      destinationCode: descriptor.destinationCode ?? null,
    });
  }

  private acquire<T>(descriptor: ProviderCallDescriptor<T>, sequence: number): Promise<void> {
    if (this.rootController.signal.aborted) {
      return Promise.reject(this.createError(descriptor, sequence, 'CANCELLED', false, 0));
    }
    if (this.activeCalls < this.policy.maxConcurrency) {
      this.activeCalls += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      this.queue.push({
        resolve,
        reject,
        descriptor: descriptor as ProviderCallDescriptor<unknown>,
        sequence,
      });
    });
  }

  private release(): void {
    this.activeCalls = Math.max(0, this.activeCalls - 1);
    if (this.rootController.signal.aborted) {
      this.drainCancelledQueue();
      return;
    }
    const next = this.queue.shift();
    if (next !== undefined) {
      this.activeCalls += 1;
      next.resolve();
    }
  }

  private drainCancelledQueue(): void {
    for (const waiter of this.queue.splice(0)) {
      waiter.reject(this.createError(waiter.descriptor, waiter.sequence, 'CANCELLED', false, 0));
    }
  }

  private recordFailure<T>(
    descriptor: ProviderCallDescriptor<T>,
    error: ProviderExecutionError,
    status: Extract<ProviderCallAuditStatus, 'FAILED' | 'CANCELLED' | 'BLOCKED'>,
  ): void {
    this.events.push({
      sequence: error.evidence.callSequence,
      policyVersion: this.policy.version,
      providerKey: descriptor.providerKey,
      operation: descriptor.operation,
      destinationCode: descriptor.destinationCode ?? null,
      status,
      providerCallAttempted: error.evidence.providerCallAttempted,
      attempts: error.evidence.attempts,
      latencyMs: error.evidence.latencyMs,
      queryFingerprint: descriptor.queryFingerprint,
      resultFingerprint: null,
      resultCount: null,
      failureCategory: error.category,
      underlyingFailureCategory: error.evidence.underlyingCategory,
      httpStatus: error.evidence.httpStatus,
      rateLimitRetryAfterMs: error.evidence.rateLimit?.retryAfterMs ?? null,
      rateLimitLimit: error.evidence.rateLimit?.limit ?? null,
      rateLimitRemaining: error.evidence.rateLimit?.remaining ?? null,
      rateLimitResetAt: error.evidence.rateLimit?.resetAt ?? null,
    });
  }
}
