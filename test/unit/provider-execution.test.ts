import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_PROVIDER_EXECUTION_POLICY,
  PROVIDER_EXECUTION_POLICY_VERSION,
  ProviderExecutionScope,
  resolveProviderExecutionPolicy,
  type ProviderCallDescriptor,
  type ProviderExecutionPolicyOverride,
} from '../../srv/providers/provider-execution.js';
import { ProviderExecutionError } from '../../srv/providers/provider-errors.js';

const RESULT_FINGERPRINT = '2'.repeat(64);

function descriptor(id: number): ProviderCallDescriptor<{ id: number }> {
  return {
    providerKey: 'TRANSPORT_PRIMARY',
    operation: 'TRANSPORT_SEARCH',
    queryFingerprint: id.toString(16).padStart(64, '0'),
    resultFingerprint: () => RESULT_FINGERPRINT,
    resultCount: () => 1,
    destinationCode: null,
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('provider execution policy', () => {
  it('freezes the exact Phase 4B0 defaults including one attempt and no fallback', () => {
    expect(DEFAULT_PROVIDER_EXECUTION_POLICY).toStrictEqual({
      version: PROVIDER_EXECUTION_POLICY_VERSION,
      timeoutMs: 10_000,
      maxCallsPerRun: 25,
      maxConcurrency: 4,
      maxAttemptsPerCall: 1,
      rateLimitStrategy: 'FAIL_FAST',
      fallbackStrategy: 'NONE',
    });
    expect(Object.isFrozen(DEFAULT_PROVIDER_EXECUTION_POLICY)).toBe(true);

    const resolved = resolveProviderExecutionPolicy();
    expect(resolved).toStrictEqual(DEFAULT_PROVIDER_EXECUTION_POLICY);
    expect(Object.isFrozen(resolved)).toBe(true);
  });

  it('permits only positive bounded reductions of timeout, calls and concurrency', () => {
    expect(
      resolveProviderExecutionPolicy({
        timeoutMs: 250,
        maxCallsPerRun: 7,
        maxConcurrency: 2,
      }),
    ).toMatchObject({ timeoutMs: 250, maxCallsPerRun: 7, maxConcurrency: 2 });

    for (const override of [
      { timeoutMs: 10_001 },
      { maxCallsPerRun: 26 },
      { maxConcurrency: 5 },
      { timeoutMs: 0 },
      { maxCallsPerRun: 1.5 },
    ]) {
      expect(() => resolveProviderExecutionPolicy(override)).toThrowError(
        expect.objectContaining({ category: 'INVALID_EXECUTION_POLICY' }),
      );
    }
  });

  it('rejects runtime attempts to override fixed policy fields', () => {
    for (const override of [
      { maxAttemptsPerCall: 2 },
      { rateLimitStrategy: 'RETRY' },
      { fallbackStrategy: 'FIXTURE' },
      { version: 'provider-execution-policy-v2' },
    ]) {
      expect(() =>
        resolveProviderExecutionPolicy(override as unknown as ProviderExecutionPolicyOverride),
      ).toThrowError(expect.objectContaining({ category: 'INVALID_EXECUTION_POLICY' }));
    }
  });
});

describe('provider execution scope', () => {
  it('allows exactly 25 calls and blocks call 26 before invoking the provider', async () => {
    const scope = new ProviderExecutionScope();
    const invoke = vi.fn(async (_options, id: number) => ({ id }));

    expect(() => scope.assertCallBudget(25)).not.toThrow();
    expect(() => scope.assertCallBudget(26)).toThrowError(
      expect.objectContaining({
        category: 'CALL_BUDGET_EXCEEDED',
        evidence: expect.objectContaining({ providerCallAttempted: false, attempts: 0 }),
      }),
    );

    for (let id = 1; id <= 25; id += 1) {
      await scope.execute(descriptor(id), (options) => invoke(options, id));
    }
    await expect(
      scope.execute(descriptor(26), (options) => invoke(options, 26)),
    ).rejects.toMatchObject({
      category: 'CALL_BUDGET_EXCEEDED',
      evidence: { callSequence: 26, providerCallAttempted: false, attempts: 0 },
    });

    expect(invoke).toHaveBeenCalledTimes(25);
    expect(scope.getAuditEvents()).toHaveLength(26);
    expect(scope.getAuditEvents().at(-1)).toMatchObject({
      sequence: 26,
      status: 'BLOCKED',
      providerCallAttempted: false,
      attempts: 0,
      failureCategory: 'CALL_BUDGET_EXCEEDED',
    });
  });

  it('enforces max concurrency and admits queued calls in FIFO order', async () => {
    const scope = new ProviderExecutionScope({ policy: { maxConcurrency: 2 } });
    const gates = new Map([1, 2, 3, 4].map((id) => [id, deferred<{ id: number }>()]));
    const started: number[] = [];
    let active = 0;
    let maximumActive = 0;
    const execute = (id: number) =>
      scope.execute(descriptor(id), async () => {
        started.push(id);
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        try {
          return await gates.get(id)!.promise;
        } finally {
          active -= 1;
        }
      });
    const calls = [1, 2, 3, 4].map(execute);

    await vi.waitFor(() => expect(started).toStrictEqual([1, 2]));
    gates.get(2)!.resolve({ id: 2 });
    await vi.waitFor(() => expect(started).toStrictEqual([1, 2, 3]));
    gates.get(1)!.resolve({ id: 1 });
    await vi.waitFor(() => expect(started).toStrictEqual([1, 2, 3, 4]));
    gates.get(3)!.resolve({ id: 3 });
    gates.get(4)!.resolve({ id: 4 });

    await expect(Promise.all(calls)).resolves.toStrictEqual([
      { id: 1 },
      { id: 2 },
      { id: 3 },
      { id: 4 },
    ]);
    expect(maximumActive).toBe(2);
    expect(scope.getAuditEvents().map(({ sequence, status }) => ({ sequence, status }))).toEqual([
      { sequence: 1, status: 'SUCCEEDED' },
      { sequence: 2, status: 'SUCCEEDED' },
      { sequence: 3, status: 'SUCCEEDED' },
      { sequence: 4, status: 'SUCCEEDED' },
    ]);
  });

  it('times out an active call once, aborts its signal and records safe evidence', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-27T12:00:00.000Z'));
    const scope = new ProviderExecutionScope({ policy: { timeoutMs: 25 } });
    let providerSignal: AbortSignal | undefined;
    const call = scope.execute(descriptor(1), ({ signal }) => {
      providerSignal = signal;
      return new Promise(() => undefined);
    });
    const rejection = expect(call).rejects.toMatchObject({
      category: 'TIMEOUT',
      retryable: true,
      evidence: expect.objectContaining({ providerCallAttempted: true, attempts: 1 }),
    });

    await vi.advanceTimersByTimeAsync(25);
    await rejection;

    expect(providerSignal?.aborted).toBe(true);
    expect(scope.getAuditEvents()).toEqual([
      expect.objectContaining({
        sequence: 1,
        status: 'FAILED',
        providerCallAttempted: true,
        attempts: 1,
        failureCategory: 'TIMEOUT',
      }),
    ]);
  });

  it('cancels active and queued calls while distinguishing attempted calls', async () => {
    const controller = new AbortController();
    const scope = new ProviderExecutionScope({
      policy: { maxConcurrency: 1 },
      signal: controller.signal,
    });
    const activeGate = deferred<{ id: number }>();
    let activeSignal: AbortSignal | undefined;
    const first = scope.execute(descriptor(1), ({ signal }) => {
      activeSignal = signal;
      return activeGate.promise;
    });
    const queuedInvoke = vi.fn(async () => ({ id: 2 }));
    const second = scope.execute(descriptor(2), queuedInvoke);
    const firstRejection = expect(first).rejects.toMatchObject({
      category: 'CANCELLED',
      evidence: expect.objectContaining({ providerCallAttempted: true, attempts: 1 }),
    });
    const secondRejection = expect(second).rejects.toMatchObject({
      category: 'CANCELLED',
      evidence: expect.objectContaining({ providerCallAttempted: false, attempts: 0 }),
    });

    await vi.waitFor(() => expect(activeSignal).toBeDefined());
    controller.abort();
    await Promise.all([firstRejection, secondRejection]);

    expect(activeSignal?.aborted).toBe(true);
    expect(queuedInvoke).not.toHaveBeenCalled();
    expect(scope.getAuditEvents()).toEqual([
      expect.objectContaining({ sequence: 1, status: 'CANCELLED', providerCallAttempted: true }),
      expect.objectContaining({ sequence: 2, status: 'CANCELLED', providerCallAttempted: false }),
    ]);
  });

  it('records an immediate parent abort before provider invocation as unattempted', async () => {
    const controller = new AbortController();
    const scope = new ProviderExecutionScope({ signal: controller.signal });
    const invoke = vi.fn(async () => ({ id: 1 }));
    const call = scope.execute(descriptor(1), invoke);
    const rejection = expect(call).rejects.toMatchObject({
      category: 'CANCELLED',
      evidence: expect.objectContaining({ providerCallAttempted: false, attempts: 0 }),
    });

    controller.abort();
    await rejection;

    expect(invoke).not.toHaveBeenCalled();
    expect(scope.getAuditEvents()).toEqual([
      expect.objectContaining({
        sequence: 1,
        status: 'CANCELLED',
        providerCallAttempted: false,
        attempts: 0,
      }),
    ]);
  });

  it('cancels active and queued siblings when an over-budget call is blocked', async () => {
    const scope = new ProviderExecutionScope({
      policy: { maxCallsPerRun: 2, maxConcurrency: 1 },
    });
    const activeGate = deferred<{ id: number }>();
    const firstInvoke = vi.fn(() => activeGate.promise);
    const secondInvoke = vi.fn(async () => ({ id: 2 }));
    const thirdInvoke = vi.fn(async () => ({ id: 3 }));
    const first = scope.execute(descriptor(1), firstInvoke);
    const second = scope.execute(descriptor(2), secondInvoke);

    await vi.waitFor(() => expect(firstInvoke).toHaveBeenCalledTimes(1));
    const third = scope.execute(descriptor(3), thirdInvoke);

    await expect(third).rejects.toMatchObject({
      category: 'CALL_BUDGET_EXCEEDED',
      evidence: expect.objectContaining({ providerCallAttempted: false, attempts: 0 }),
    });
    await expect(first).rejects.toMatchObject({
      category: 'CANCELLED',
      evidence: expect.objectContaining({ providerCallAttempted: true, attempts: 1 }),
    });
    await expect(second).rejects.toMatchObject({
      category: 'CANCELLED',
      evidence: expect.objectContaining({ providerCallAttempted: false, attempts: 0 }),
    });

    expect(secondInvoke).not.toHaveBeenCalled();
    expect(thirdInvoke).not.toHaveBeenCalled();
    expect(scope.getAuditEvents()).toEqual([
      expect.objectContaining({ sequence: 1, status: 'CANCELLED' }),
      expect.objectContaining({ sequence: 2, status: 'CANCELLED' }),
      expect.objectContaining({ sequence: 3, status: 'BLOCKED' }),
    ]);
  });

  it('normalizes a synchronous raw throw to NETWORK without serializing raw data', async () => {
    const scope = new ProviderExecutionScope();
    const rawSentinel = 'RAW_SYNC_PROVIDER_THROW_SECRET_SENTINEL';
    const call = scope.execute(descriptor(1), () => {
      throw new Error(rawSentinel);
    });

    const error = await call.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderExecutionError);
    expect(error).toMatchObject({
      category: 'NETWORK',
      retryable: true,
      evidence: expect.objectContaining({ providerCallAttempted: true, attempts: 1 }),
    });
    expect(JSON.stringify((error as ProviderExecutionError).toSafeJSON())).not.toContain(
      rawSentinel,
    );
    expect(scope.getAuditEvents()).toEqual([
      expect.objectContaining({
        sequence: 1,
        status: 'FAILED',
        providerCallAttempted: true,
        attempts: 1,
        failureCategory: 'NETWORK',
        resultFingerprint: null,
        resultCount: null,
      }),
    ]);
  });

  it('classifies local result fingerprint/count failures as INVALID_SCHEMA', async () => {
    const scope = new ProviderExecutionScope();
    const invalidDescriptor: ProviderCallDescriptor<{ id: number }> = {
      ...descriptor(1),
      resultCount: () => {
        throw new Error('RAW_MAPPED_RESULT_SENTINEL');
      },
    };

    const error = await scope
      .execute(invalidDescriptor, async () => ({ id: 1 }))
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProviderExecutionError);
    expect(error).toMatchObject({
      category: 'INVALID_SCHEMA',
      evidence: expect.objectContaining({ providerCallAttempted: true, attempts: 1 }),
    });
    expect(JSON.stringify((error as ProviderExecutionError).toSafeJSON())).not.toContain(
      'RAW_MAPPED_RESULT_SENTINEL',
    );
    expect(scope.getAuditEvents()).toEqual([
      expect.objectContaining({ status: 'FAILED', failureCategory: 'INVALID_SCHEMA' }),
    ]);
  });
});
