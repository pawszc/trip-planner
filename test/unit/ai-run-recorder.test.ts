import { describe, expect, it } from 'vitest';
import { AiProvider, AiTaskType } from '../../srv/ai/contracts.js';
import { AiError } from '../../srv/ai/errors.js';
import {
  CapAiRunStore,
  type AiRunTransactionalDatabase,
} from '../../srv/ai/persistence/cap-ai-run-store.js';
import type {
  AiRunFailedUpdate,
  AiRunStartedRecord,
  AiRunStore,
  AiRunSucceededUpdate,
} from '../../srv/ai/persistence/ai-run-store.js';
import {
  PersistentAiRunRecorder,
  calculateAiRunExpiresAt,
} from '../../srv/ai/persistence/persistent-ai-run-recorder.js';
import { NoopAiRunRecorder } from '../../srv/ai/telemetry.js';
import type { AiRunTelemetryEvent } from '../../srv/ai/telemetry.js';

const fingerprint = 'a'.repeat(64);

function startedEvent(overrides: Partial<AiRunTelemetryEvent> = {}): AiRunTelemetryEvent {
  return {
    aiRunId: '00000000-0000-4000-8000-000000000020',
    status: 'STARTED',
    provider: AiProvider.OPENAI,
    configuredModel: 'gpt-5.6-luna',
    configuredEffort: 'none',
    configuredMaxOutputTokens: 512,
    effectiveMaxOutputTokens: 256,
    taskType: AiTaskType.DECIDE,
    promptVersion: 'prompt-v1',
    schemaVersion: 'schema-v1',
    inputFingerprint: fingerprint,
    startedAt: '2026-08-12T10:00:00.000Z',
    ...overrides,
  };
}

class RecordingStore implements AiRunStore {
  readonly started: AiRunStartedRecord[] = [];
  readonly succeeded: { ID: string; update: AiRunSucceededUpdate }[] = [];
  readonly failed: { ID: string; update: AiRunFailedUpdate }[] = [];
  readonly cleanupTimes: string[] = [];

  async insertStarted(record: AiRunStartedRecord): Promise<void> {
    this.started.push(record);
  }

  async completeSucceeded(ID: string, update: AiRunSucceededUpdate): Promise<void> {
    this.succeeded.push({ ID, update });
  }

  async completeFailed(ID: string, update: AiRunFailedUpdate): Promise<void> {
    this.failed.push({ ID, update });
  }

  async deleteExpired(now: string): Promise<number> {
    this.cleanupTimes.push(now);
    return 0;
  }
}

class FakeTransactionalDatabase implements AiRunTransactionalDatabase {
  readonly queries: object[] = [];
  transactionCount = 0;
  readonly results: unknown[] = [];

  async tx<T>(handler: (transaction: { run(query: object): Promise<unknown> }) => Promise<T>) {
    this.transactionCount += 1;
    return handler({
      run: async (query) => {
        this.queries.push(query);
        const result = this.results.shift();
        if (result instanceof Error) throw result;
        return result;
      },
    });
  }
}

describe('persistent AI run recorder', () => {
  it('maps STARTED and calculates expiresAt from retention days', async () => {
    const store = new RecordingStore();
    const recorder = new PersistentAiRunRecorder(store, 30);

    await recorder.record(startedEvent({ planningRunId: 'planning-run-id' }));

    expect(store.started).toEqual([
      {
        ID: '00000000-0000-4000-8000-000000000020',
        planningRunId: 'planning-run-id',
        status: 'STARTED',
        taskType: AiTaskType.DECIDE,
        provider: AiProvider.OPENAI,
        configuredModel: 'gpt-5.6-luna',
        configuredEffort: 'none',
        configuredMaxOutputTokens: 512,
        effectiveMaxOutputTokens: 256,
        promptVersion: 'prompt-v1',
        schemaVersion: 'schema-v1',
        inputFingerprint: fingerprint,
        startedAt: '2026-08-12T10:00:00.000Z',
        expiresAt: '2026-09-11T10:00:00.000Z',
        refusal: false,
      },
    ]);
  });

  it('maps SUCCEEDED usage, response metadata and refusal state', async () => {
    const store = new RecordingStore();
    const recorder = new PersistentAiRunRecorder(store, 30);

    await recorder.record({
      ...startedEvent(),
      status: 'SUCCEEDED',
      responseModel: 'gpt-5.6-luna-2026-08-01',
      completedAt: '2026-08-12T10:00:01.000Z',
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        cacheReadTokens: 2,
        cacheWriteTokens: 1,
        reasoningTokens: 3,
      },
      latencyMs: 1_000,
      attempts: 2,
      providerRequestId: 'provider-request-id',
      refusal: { refused: false },
      retryable: false,
    });

    expect(store.succeeded).toEqual([
      {
        ID: '00000000-0000-4000-8000-000000000020',
        update: {
          status: 'SUCCEEDED',
          responseModel: 'gpt-5.6-luna-2026-08-01',
          completedAt: '2026-08-12T10:00:01.000Z',
          usage: {
            inputTokens: 10,
            outputTokens: 5,
            totalTokens: 15,
            cacheReadTokens: 2,
            cacheWriteTokens: 1,
            reasoningTokens: 3,
          },
          latencyMs: 1_000,
          attempts: 2,
          providerRequestId: 'provider-request-id',
          refusal: { refused: false },
          retryable: false,
        },
      },
    ]);
  });

  it('maps FAILED without a raw provider error', async () => {
    const store = new RecordingStore();
    const recorder = new PersistentAiRunRecorder(store, 30);

    await recorder.record({
      ...startedEvent({
        provider: AiProvider.ANTHROPIC,
        configuredModel: 'claude-sonnet-5',
        configuredEffort: 'low',
        configuredMaxOutputTokens: 1_600,
        effectiveMaxOutputTokens: 1_600,
      }),
      status: 'FAILED',
      completedAt: '2026-08-12T10:00:02.000Z',
      refusal: { refused: true, category: 'policy' },
      errorCode: 'MODEL_REFUSAL',
      retryable: false,
    });

    expect(store.failed).toEqual([
      {
        ID: '00000000-0000-4000-8000-000000000020',
        update: {
          status: 'FAILED',
          completedAt: '2026-08-12T10:00:02.000Z',
          refusal: { refused: true, category: 'policy' },
          errorCode: 'MODEL_REFUSAL',
          retryable: false,
        },
      },
    ]);
    expect(JSON.stringify(store.failed)).not.toContain('raw');
  });

  it('drops unexpected raw payload fields instead of mapping them to persistence', async () => {
    const store = new RecordingStore();
    const recorder = new PersistentAiRunRecorder(store, 30);
    const unsafeRuntimeEvent = {
      ...startedEvent(),
      instructions: 'private prompt',
      input: { private: 'grounded input' },
      output: { private: 'model output' },
      rawError: 'provider stack',
      credential: 'credential-value',
    } as AiRunTelemetryEvent;

    await recorder.record(unsafeRuntimeEvent);
    const persisted = JSON.stringify(store.started);

    expect(persisted).not.toMatch(/private prompt|grounded input|model output|provider stack/);
    expect(persisted).not.toContain('credential-value');
  });

  it.each([
    [{ status: 'SUCCEEDED', completedAt: '2026-08-12T10:00:01.000Z' }, 'responseModel'],
    [{ status: 'FAILED', completedAt: '2026-08-12T10:00:01.000Z' }, 'errorCode'],
    [{ inputFingerprint: 'bad' }, 'inputFingerprint'],
    [{ startedAt: 'not-a-date' }, 'startedAt'],
    [{ configuredEffort: 'unsupported' }, 'configuredEffort'],
    [{ configuredMaxOutputTokens: 0 }, 'configuredMaxOutputTokens'],
    [{ effectiveMaxOutputTokens: 513 }, 'effectiveMaxOutputTokens'],
  ] as const)('fails safely for incomplete audit metadata %#', async (overrides, field) => {
    const recorder = new PersistentAiRunRecorder(new RecordingStore(), 30);

    await expect(
      recorder.record({ ...startedEvent(), ...overrides } as AiRunTelemetryEvent),
    ).rejects.toMatchObject({ code: 'AI_AUDIT_FAILED', details: { field } });
  });

  it('validates retention and timestamps as safe bounded values', () => {
    expect(calculateAiRunExpiresAt('2026-08-12T10:00:00.000Z', 1)).toBe('2026-08-13T10:00:00.000Z');
    expect(() => calculateAiRunExpiresAt('invalid', 30)).toThrowError(
      expect.objectContaining({ code: 'AI_AUDIT_FAILED' }),
    );
    expect(() => calculateAiRunExpiresAt('2026-08-12T10:00:00.000Z', 0)).toThrowError(
      expect.objectContaining({ code: 'AI_AUDIT_FAILED' }),
    );
    expect(() => calculateAiRunExpiresAt('2026-08-12T10:00:00.000Z', 366)).toThrowError(
      expect.objectContaining({ code: 'AI_AUDIT_FAILED' }),
    );
  });

  it('NoopAiRunRecorder is asynchronous and always succeeds', async () => {
    const recorder = new NoopAiRunRecorder();
    const pending = recorder.record(startedEvent());

    expect(pending).toBeInstanceOf(Promise);
    await expect(pending).resolves.toBeUndefined();
  });

  it('preserves controlled store errors and hides arbitrary store failures', async () => {
    const controlledStore = new RecordingStore();
    controlledStore.insertStarted = async () => {
      throw new AiError('AI_AUDIT_FAILED', 'controlled');
    };
    const rawStore = new RecordingStore();
    rawStore.insertStarted = async () => {
      throw new Error('raw database failure');
    };

    await expect(
      new PersistentAiRunRecorder(controlledStore, 30).record(startedEvent()),
    ).rejects.toMatchObject({
      code: 'AI_AUDIT_FAILED',
      message: 'controlled',
    });
    await expect(
      new PersistentAiRunRecorder(rawStore, 30).record(startedEvent()),
    ).rejects.toMatchObject({
      code: 'AI_AUDIT_FAILED',
      message: 'The AI audit event could not be recorded safely.',
    });
  });
});

describe('CAP AI run store boundary', () => {
  it('rejects an active CAP database transaction before acquiring another connection', async () => {
    const database = new FakeTransactionalDatabase();
    const store = new CapAiRunStore(
      () => database,
      () => true,
    );

    await expect(
      store.insertStarted({
        ID: '00000000-0000-4000-8000-000000000029',
        status: 'STARTED',
        taskType: AiTaskType.DECIDE,
        provider: AiProvider.OPENAI,
        configuredModel: 'gpt-5.6-luna',
        configuredEffort: 'none',
        configuredMaxOutputTokens: 512,
        effectiveMaxOutputTokens: 256,
        promptVersion: 'prompt-v1',
        schemaVersion: 'schema-v1',
        inputFingerprint: fingerprint,
        startedAt: '2026-08-12T10:00:00.000Z',
        expiresAt: '2026-09-11T10:00:00.000Z',
        refusal: false,
      }),
    ).rejects.toMatchObject({
      code: 'AI_AUDIT_FAILED',
      details: {
        operation: 'insertStarted',
        transactionBoundary: 'ACTIVE_CAP_DATABASE_TRANSACTION',
      },
    });
    expect(database.transactionCount).toBe(0);
  });

  it('maps STARTED to one short transaction without raw payload columns', async () => {
    const database = new FakeTransactionalDatabase();
    const store = new CapAiRunStore(() => database);

    await store.insertStarted({
      ID: '00000000-0000-4000-8000-000000000030',
      status: 'STARTED',
      taskType: AiTaskType.DECIDE,
      provider: AiProvider.OPENAI,
      configuredModel: 'gpt-5.6-luna',
      configuredEffort: 'none',
      configuredMaxOutputTokens: 512,
      effectiveMaxOutputTokens: 256,
      promptVersion: 'prompt-v1',
      schemaVersion: 'schema-v1',
      inputFingerprint: fingerprint,
      startedAt: '2026-08-12T10:00:00.000Z',
      expiresAt: '2026-09-11T10:00:00.000Z',
      refusal: false,
    });

    const cqn = JSON.stringify(database.queries[0]);
    expect(database.transactionCount).toBe(1);
    expect(cqn).toContain('trip.planner.AiRuns');
    expect(cqn).toContain('gpt-5.6-luna');
    expect(cqn).toContain('configuredEffort');
    expect(cqn).toContain('configuredMaxOutputTokens');
    expect(cqn).toContain('effectiveMaxOutputTokens');
    expect(cqn).not.toMatch(/instructions|promptText|rawError|credential|output/);
  });

  it('normalizes a duplicate STARTED insert as AI_AUDIT_FAILED', async () => {
    const database = new FakeTransactionalDatabase();
    database.results.push(new Error('duplicate primary key raw detail'));
    const store = new CapAiRunStore(() => database);

    await expect(
      store.insertStarted({
        ID: '00000000-0000-4000-8000-000000000031',
        status: 'STARTED',
        taskType: AiTaskType.SMOKE,
        provider: AiProvider.OPENAI,
        configuredModel: 'gpt-5.6-luna',
        configuredEffort: 'none',
        configuredMaxOutputTokens: 512,
        effectiveMaxOutputTokens: 256,
        promptVersion: 'prompt-v1',
        schemaVersion: 'schema-v1',
        inputFingerprint: fingerprint,
        startedAt: '2026-08-12T10:00:00.000Z',
        expiresAt: '2026-09-11T10:00:00.000Z',
        refusal: false,
      }),
    ).rejects.toMatchObject({ code: 'AI_AUDIT_FAILED' });
  });

  it.each([
    ['completeSucceeded', 'SUCCEEDED'],
    ['completeFailed', 'FAILED'],
  ] as const)('requires exactly one STARTED row for %s', async (method, terminalStatus) => {
    const database = new FakeTransactionalDatabase();
    database.results.push(0);
    const store = new CapAiRunStore(() => database);
    const ID = '00000000-0000-4000-8000-000000000032';

    const completion =
      method === 'completeSucceeded'
        ? store.completeSucceeded(ID, {
            status: 'SUCCEEDED',
            responseModel: 'snapshot',
            completedAt: '2026-08-12T10:00:01.000Z',
            refusal: { refused: false },
            retryable: false,
          })
        : store.completeFailed(ID, {
            status: 'FAILED',
            completedAt: '2026-08-12T10:00:01.000Z',
            refusal: { refused: false },
            errorCode: 'PROVIDER_ERROR',
            retryable: false,
          });

    await expect(completion).rejects.toMatchObject({ code: 'AI_AUDIT_FAILED' });
    const cqn = JSON.stringify(database.queries[0]);
    expect(cqn).toContain('STARTED');
    expect(cqn).toContain(terminalStatus);
    expect(database.transactionCount).toBe(1);
  });

  it('completes once and rejects a simulated repeated terminal transition', async () => {
    const database = new FakeTransactionalDatabase();
    database.results.push(1, 0);
    const store = new CapAiRunStore(() => database);
    const update: AiRunSucceededUpdate = {
      status: 'SUCCEEDED',
      responseModel: 'snapshot',
      completedAt: '2026-08-12T10:00:01.000Z',
      refusal: { refused: false },
      retryable: false,
    };

    await expect(store.completeSucceeded('run-id', update)).resolves.toBeUndefined();
    await expect(store.completeSucceeded('run-id', update)).rejects.toMatchObject({
      code: 'AI_AUDIT_FAILED',
    });
    expect(database.transactionCount).toBe(2);
  });

  it('uses a strict expiresAt less-than query for cleanup', async () => {
    const database = new FakeTransactionalDatabase();
    database.results.push(2);
    const store = new CapAiRunStore(() => database);

    await expect(store.deleteExpired('2026-09-01T00:00:00.000Z')).resolves.toBe(2);

    const cqn = JSON.stringify(database.queries[0]);
    expect(cqn).toContain('expiresAt');
    expect(cqn).toContain('2026-09-01T00:00:00.000Z');
    expect(cqn).toContain('"<"');
    expect(database.transactionCount).toBe(1);
  });
});
