import { randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { Request } from '@sap/cds';
import { loadAiConfig } from '../../srv/ai/config.js';
import { createPersistentAiGateway } from '../../srv/ai/create-persistent-ai-gateway.js';
import { AiProvider, AiTaskType, createInputFingerprint } from '../../srv/ai/contracts.js';
import type {
  AiCallResult,
  AiExecutionProfile,
  StructuredAiAdapter,
  StructuredAiRequest,
} from '../../srv/ai/contracts.js';
import { AiError } from '../../srv/ai/errors.js';
import { CapAiRunStore } from '../../srv/ai/persistence/cap-ai-run-store.js';
import { PersistentAiRunRecorder } from '../../srv/ai/persistence/persistent-ai-run-recorder.js';
import type { AiRunTelemetryEvent } from '../../srv/ai/telemetry.js';
import { referenceTripRequestODataPayload } from '../fixtures/trip-request.js';

process.env.CDS_TYPESCRIPT = 'true';
const { default: cds } = await import('@sap/cds');
// Make a pool-starvation regression fail deterministically instead of leaving the test process hung.
const sqliteTestDatabase = cds.env.requires.db as {
  pool?: Readonly<Record<string, unknown>> & { acquireTimeoutMillis?: number };
};
sqliteTestDatabase.pool = {
  ...sqliteTestDatabase.pool,
  acquireTimeoutMillis: 1_000,
};
const test = cds
  .test('serve', 'all', '--from', 'db,srv,test/fixtures/ai-transaction-service.cds', '--in-memory')
  .in(process.cwd());
const { GET, POST } = test;

const fingerprint = 'b'.repeat(64);
const store = new CapAiRunStore();
const recorder = new PersistentAiRunRecorder(store, 30);
const gatewayOutputSchema = z.object({ decision: z.literal('ok') }).strict();
const TRANSACTION_PROBE_ENTITY = 'trip.planner.test.TransactionProbeWrites';

interface TransactionObservation {
  adapterCalls: number;
  startedSeenByAdapter?: PersistedAiRun;
  errorCode?: string;
  transactionBoundary?: string;
}

const transactionObservations = new Map<string, TransactionObservation>();

interface PersistedAiRun {
  ID: string;
  planningRun_ID: string | null;
  status: 'STARTED' | 'SUCCEEDED' | 'FAILED';
  taskType: 'DECIDE' | 'GENERATE' | 'JUDGE' | 'SMOKE';
  provider: 'OPENAI' | 'ANTHROPIC';
  configuredModel: string;
  responseModel: string | null;
  promptVersion: string;
  schemaVersion: string;
  inputFingerprint: string;
  startedAt: string;
  completedAt: string | null;
  expiresAt: string;
  inputTokens: number | string | null;
  outputTokens: number | string | null;
  totalTokens: number | string | null;
  cacheReadTokens: number | string | null;
  cacheWriteTokens: number | string | null;
  reasoningTokens: number | string | null;
  latencyMs: number | null;
  attempts: number | null;
  providerRequestId: string | null;
  refusal: boolean;
  refusalCategory: string | null;
  errorCode: string | null;
  retryable: boolean | null;
}

function startedEvent(
  aiRunId = randomUUID(),
  overrides: Partial<AiRunTelemetryEvent> = {},
): AiRunTelemetryEvent {
  return {
    aiRunId,
    status: 'STARTED',
    provider: AiProvider.OPENAI,
    configuredModel: 'gpt-5.6-luna',
    taskType: AiTaskType.DECIDE,
    promptVersion: 'prompt-v1',
    schemaVersion: 'schema-v1',
    inputFingerprint: fingerprint,
    startedAt: '2026-08-12T10:00:00.000Z',
    ...overrides,
  };
}

async function readAiRun(ID: string): Promise<PersistedAiRun | undefined> {
  return (await cds.db.run(cds.ql.SELECT.one.from('trip.planner.AiRuns').where({ ID }))) as
    PersistedAiRun | undefined;
}

async function readAllAiRuns(): Promise<PersistedAiRun[]> {
  return (await cds.db.run(cds.ql.SELECT.from('trip.planner.AiRuns'))) as PersistedAiRun[];
}

async function readAiRunInIndependentTransaction(ID: string): Promise<PersistedAiRun | undefined> {
  return cds.db.tx(async (transaction) =>
    transaction.run(cds.ql.SELECT.one.from('trip.planner.AiRuns').where({ ID })),
  ) as Promise<PersistedAiRun | undefined>;
}

async function readTransactionProbe(marker: string): Promise<unknown | undefined> {
  return cds.db.run(cds.ql.SELECT.one.from(TRANSACTION_PROBE_ENTITY).where({ marker }));
}

class SqliteVisibilityAdapter implements StructuredAiAdapter {
  readonly provider = AiProvider.OPENAI;

  constructor(private readonly observation: TransactionObservation) {}

  async call<TOutput>(
    request: StructuredAiRequest<TOutput>,
    profile: AiExecutionProfile,
  ): Promise<AiCallResult<TOutput>> {
    this.observation.adapterCalls += 1;
    this.observation.startedSeenByAdapter = await readAiRunInIndependentTransaction(
      request.aiRunId!,
    );

    return {
      aiRunId: request.aiRunId!,
      output: request.outputSchema.parse({ decision: 'ok' }),
      provider: this.provider,
      configuredModel: profile.model,
      responseModel: 'gpt-5.6-luna-sqlite-snapshot',
      taskType: request.taskType,
      promptVersion: request.promptVersion,
      schemaVersion: request.schemaVersion,
      inputFingerprint: createInputFingerprint(request.input),
      usage: {
        inputTokens: 21,
        outputTokens: 8,
        totalTokens: 29,
        cacheReadTokens: 3,
        reasoningTokens: 2,
      },
      latencyMs: 19,
      attempts: 1,
      providerRequestId: 'offline-sqlite-adapter-request',
      refusal: { refused: false },
    };
  }
}

function gatewayRequest(): StructuredAiRequest<{ decision: 'ok' }> {
  return {
    taskType: AiTaskType.DECIDE,
    promptVersion: 'sqlite-composition-prompt-v1',
    schemaVersion: 'sqlite-composition-schema-v1',
    schemaName: 'sqlite_composition_result',
    instructions: 'Return only the grounded test decision.',
    input: { fixture: 'offline-cap-sqlite' },
    outputSchema: gatewayOutputSchema,
  };
}

function createSqliteGateway(aiRunId: string, observation: TransactionObservation) {
  return createPersistentAiGateway(loadAiConfig({ AI_ENABLED: 'true' }), {
    adapters: [new SqliteVisibilityAdapter(observation)],
    generateAiRunId: () => aiRunId,
    now: (() => {
      const times = [new Date('2026-08-12T11:00:00.000Z'), new Date('2026-08-12T11:00:01.000Z')];
      return () => times.shift() ?? new Date('2026-08-12T11:00:02.000Z');
    })(),
  });
}

async function executeGatewayInTestHandler(request: Request): Promise<string> {
  const aiRunId = String(request.data.aiRunId ?? '');
  const mode = String(request.data.mode ?? '');
  const observation: TransactionObservation = { adapterCalls: 0 };
  transactionObservations.set(aiRunId, observation);
  const gateway = createSqliteGateway(aiRunId, observation);

  if (mode === 'ACTIVE_REQUEST_TRANSACTION') {
    const transaction = cds.tx(request);
    await transaction.run(cds.ql.SELECT.from(TRANSACTION_PROBE_ENTITY));
    await transaction.run(
      cds.ql.INSERT.into(TRANSACTION_PROBE_ENTITY).entries({
        ID: randomUUID(),
        marker: aiRunId,
      }),
    );
    try {
      const result = await gateway.call(gatewayRequest());
      return result.output.decision;
    } catch (error) {
      if (error instanceof AiError) {
        observation.errorCode = error.code;
        const transactionBoundary = error.details.transactionBoundary;
        if (typeof transactionBoundary === 'string') {
          observation.transactionBoundary = transactionBoundary;
        }
      }
      throw error;
    }
  }

  if (mode === 'SAFE_BOUNDARY' || mode === 'SAFE_BOUNDARY_ROLLBACK') {
    // The read phase is an explicit short root transaction and releases SQLite's sole
    // connection before audit STARTED and the adapter are allowed to run.
    await cds.db.tx(async (transaction) =>
      transaction.run(cds.ql.SELECT.from(TRANSACTION_PROBE_ENTITY)),
    );
    const result = await gateway.call(gatewayRequest());

    // Product persistence starts only after the terminal audit has committed.
    const transaction = cds.tx(request);
    await transaction.run(
      cds.ql.INSERT.into(TRANSACTION_PROBE_ENTITY).entries({
        ID: randomUUID(),
        marker: aiRunId,
      }),
    );
    if (mode === 'SAFE_BOUNDARY_ROLLBACK') {
      return request.reject({
        status: 500,
        code: 'INTENTIONAL_PRODUCT_ROLLBACK',
        message: 'Intentional rollback after a completed offline AI execution.',
      });
    }
    return result.output.decision;
  }

  return request.reject(400, 'Unknown test transaction mode.');
}

async function withHardTimeout<T>(operation: Promise<T>, timeoutMs = 5_000): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(
      () => reject(new Error(`CAP/SQLite transaction test exceeded ${timeoutMs} ms.`)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([operation, deadline]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function createPlanningRun(): Promise<string> {
  const created = await POST('/trip-planner/TripRequests', referenceTripRequestODataPayload);
  const tripRequestId = String(created.data.ID);
  await POST(
    `/trip-planner/TripRequests(${tripRequestId})/TripPlannerService.confirmConstraints`,
    {},
  );
  const planned = await POST(
    `/trip-planner/TripRequests(${tripRequestId})/TripPlannerService.startPlanning`,
    {},
  );
  return String(planned.data.ID);
}

beforeAll(async () => {
  await test;
  const transactionService = cds.services['trip.planner.test.AiTransactionTestService'];
  if (!transactionService) {
    throw new Error('The test-only AI transaction service was not loaded.');
  }
  transactionService.on('executeGateway', executeGatewayInTestHandler);
});

beforeEach(async () => {
  await test.data.reset();
  transactionObservations.clear();
});

describe('internal CAP AiRuns persistence', () => {
  it('STARTED inserts exactly one internal AiRuns record', async () => {
    const event = startedEvent('00000000-0000-4000-8000-000000000101');

    await recorder.record(event);

    const records = await readAllAiRuns();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      ID: event.aiRunId,
      planningRun_ID: null,
      status: 'STARTED',
      taskType: 'DECIDE',
      provider: 'OPENAI',
      configuredModel: 'gpt-5.6-luna',
      responseModel: null,
      promptVersion: 'prompt-v1',
      schemaVersion: 'schema-v1',
      inputFingerprint: fingerprint,
      startedAt: '2026-08-12T10:00:00.000Z',
      completedAt: null,
      expiresAt: '2026-09-11T10:00:00.000Z',
      refusal: false,
    });
  });

  it('SUCCEEDED updates the same record with response metadata and usage', async () => {
    const event = startedEvent('00000000-0000-4000-8000-000000000102');
    await recorder.record(event);

    await recorder.record({
      ...event,
      status: 'SUCCEEDED',
      responseModel: 'gpt-5.6-luna-2026-08-01',
      completedAt: '2026-08-12T10:00:01.250Z',
      usage: {
        inputTokens: 100,
        outputTokens: 40,
        totalTokens: 140,
        cacheReadTokens: 15,
        cacheWriteTokens: 5,
        reasoningTokens: 10,
      },
      latencyMs: 1_250,
      attempts: 2,
      providerRequestId: 'openai-request-id',
      refusal: { refused: false },
      retryable: false,
    });

    const records = await readAllAiRuns();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      ID: event.aiRunId,
      status: 'SUCCEEDED',
      provider: 'OPENAI',
      taskType: 'DECIDE',
      configuredModel: 'gpt-5.6-luna',
      responseModel: 'gpt-5.6-luna-2026-08-01',
      inputFingerprint: fingerprint,
      promptVersion: 'prompt-v1',
      schemaVersion: 'schema-v1',
      startedAt: '2026-08-12T10:00:00.000Z',
      completedAt: '2026-08-12T10:00:01.250Z',
      expiresAt: '2026-09-11T10:00:00.000Z',
      latencyMs: 1_250,
      attempts: 2,
      providerRequestId: 'openai-request-id',
      refusal: false,
      errorCode: null,
      retryable: false,
    });
    expect(Number(records[0]?.inputTokens)).toBe(100);
    expect(Number(records[0]?.outputTokens)).toBe(40);
    expect(Number(records[0]?.totalTokens)).toBe(140);
    expect(Number(records[0]?.cacheReadTokens)).toBe(15);
    expect(Number(records[0]?.cacheWriteTokens)).toBe(5);
    expect(Number(records[0]?.reasoningTokens)).toBe(10);
    expect(records[0]).not.toHaveProperty('prompt');
    expect(records[0]).not.toHaveProperty('instructions');
    expect(records[0]).not.toHaveProperty('input');
    expect(records[0]).not.toHaveProperty('output');
    expect(records[0]).not.toHaveProperty('rawError');
    expect(records[0]).not.toHaveProperty('credential');
  });

  it('FAILED updates the same record with only controlled failure metadata', async () => {
    const event = startedEvent('00000000-0000-4000-8000-000000000103', {
      provider: AiProvider.ANTHROPIC,
      configuredModel: 'claude-sonnet-5',
      taskType: AiTaskType.GENERATE,
    });
    await recorder.record(event);

    await recorder.record({
      ...event,
      status: 'FAILED',
      completedAt: '2026-08-12T10:00:02.000Z',
      attempts: 1,
      refusal: { refused: true, category: 'policy' },
      errorCode: 'MODEL_REFUSAL',
      retryable: false,
    });

    const records = await readAllAiRuns();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      ID: event.aiRunId,
      status: 'FAILED',
      provider: 'ANTHROPIC',
      taskType: 'GENERATE',
      configuredModel: 'claude-sonnet-5',
      responseModel: null,
      completedAt: '2026-08-12T10:00:02.000Z',
      attempts: 1,
      refusal: true,
      refusalCategory: 'policy',
      errorCode: 'MODEL_REFUSAL',
      retryable: false,
    });
    expect(JSON.stringify(records[0])).not.toContain('provider stack');
  });

  it('rejects duplicate STARTED without adding another record', async () => {
    const event = startedEvent('00000000-0000-4000-8000-000000000104');
    await recorder.record(event);

    await expect(recorder.record(event)).rejects.toMatchObject({ code: 'AI_AUDIT_FAILED' });
    await expect(readAllAiRuns()).resolves.toHaveLength(1);
  });

  it('rejects completing a missing record as AI_AUDIT_FAILED', async () => {
    await expect(
      store.completeSucceeded('00000000-0000-4000-8000-000000000105', {
        status: 'SUCCEEDED',
        responseModel: 'gpt-snapshot',
        completedAt: '2026-08-12T10:00:01.000Z',
        refusal: { refused: false },
        retryable: false,
      }),
    ).rejects.toMatchObject({ code: 'AI_AUDIT_FAILED' });
  });

  it('rejects a second completion and preserves the first terminal state', async () => {
    const event = startedEvent('00000000-0000-4000-8000-000000000106');
    await recorder.record(event);
    await recorder.record({
      ...event,
      status: 'SUCCEEDED',
      responseModel: 'gpt-snapshot',
      completedAt: '2026-08-12T10:00:01.000Z',
      refusal: { refused: false },
      retryable: false,
    });

    await expect(
      recorder.record({
        ...event,
        status: 'FAILED',
        completedAt: '2026-08-12T10:00:02.000Z',
        errorCode: 'PROVIDER_ERROR',
        retryable: false,
      }),
    ).rejects.toMatchObject({ code: 'AI_AUDIT_FAILED' });
    await expect(readAiRun(event.aiRunId)).resolves.toMatchObject({
      status: 'SUCCEEDED',
      responseModel: 'gpt-snapshot',
      errorCode: null,
    });
  });

  it('allows an optional association to an existing PlanningRun', async () => {
    const planningRunId = await createPlanningRun();
    const event = startedEvent('00000000-0000-4000-8000-000000000107', { planningRunId });

    await recorder.record(event);

    await expect(readAiRun(event.aiRunId)).resolves.toMatchObject({
      planningRun_ID: planningRunId,
      status: 'STARTED',
    });
  });

  it('allows smoke/eval records without a PlanningRun', async () => {
    const event = startedEvent('00000000-0000-4000-8000-000000000108', {
      taskType: AiTaskType.SMOKE,
    });

    await recorder.record(event);

    await expect(readAiRun(event.aiRunId)).resolves.toMatchObject({
      planningRun_ID: null,
      taskType: 'SMOKE',
    });
  });

  it('cleanup removes only records with expiresAt strictly before now', async () => {
    const oneDayRecorder = new PersistentAiRunRecorder(store, 1);
    const expired = startedEvent('00000000-0000-4000-8000-000000000109', {
      startedAt: '2026-08-01T00:00:00.000Z',
    });
    const boundary = startedEvent('00000000-0000-4000-8000-000000000110', {
      startedAt: '2026-08-02T00:00:00.000Z',
    });
    const future = startedEvent('00000000-0000-4000-8000-000000000111', {
      startedAt: '2026-08-03T00:00:00.000Z',
    });
    await oneDayRecorder.record(expired);
    await oneDayRecorder.record(boundary);
    await oneDayRecorder.record(future);

    const deleted = await store.deleteExpired('2026-08-03T00:00:00.000Z');

    expect(deleted).toBe(1);
    expect(await readAiRun(expired.aiRunId)).toBeUndefined();
    expect(await readAiRun(boundary.aiRunId)).toBeDefined();
    expect(await readAiRun(future.aiRunId)).toBeDefined();
  });

  it('does not expose AiRuns through the public TripPlannerService OData endpoint', async () => {
    await expect(GET('/trip-planner/AiRuns')).rejects.toMatchObject({ status: 404 });
  });
});

describe('full offline gateway persistence composition', () => {
  it('commits STARTED before the adapter and completes exactly one SUCCEEDED AiRun', async () => {
    const aiRunId = '00000000-0000-4000-8000-000000000120';
    const observation: TransactionObservation = { adapterCalls: 0 };
    const gateway = createSqliteGateway(aiRunId, observation);

    const result = await gateway.call(gatewayRequest());

    expect(observation.adapterCalls).toBe(1);
    expect(observation.startedSeenByAdapter).toMatchObject({
      ID: aiRunId,
      status: 'STARTED',
      configuredModel: 'gpt-5.6-luna',
      responseModel: null,
    });
    expect(result).toMatchObject({
      aiRunId,
      configuredModel: 'gpt-5.6-luna',
      responseModel: 'gpt-5.6-luna-sqlite-snapshot',
      usage: {
        inputTokens: 21,
        outputTokens: 8,
        totalTokens: 29,
        cacheReadTokens: 3,
        reasoningTokens: 2,
      },
    });

    const records = await readAllAiRuns();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      ID: aiRunId,
      status: 'SUCCEEDED',
      taskType: 'DECIDE',
      provider: 'OPENAI',
      configuredModel: 'gpt-5.6-luna',
      responseModel: 'gpt-5.6-luna-sqlite-snapshot',
      promptVersion: 'sqlite-composition-prompt-v1',
      schemaVersion: 'sqlite-composition-schema-v1',
      latencyMs: 19,
      attempts: 1,
      providerRequestId: 'offline-sqlite-adapter-request',
      refusal: false,
      retryable: false,
    });
    expect(Number(records[0]?.inputTokens)).toBe(21);
    expect(Number(records[0]?.outputTokens)).toBe(8);
    expect(Number(records[0]?.totalTokens)).toBe(29);
    expect(Number(records[0]?.cacheReadTokens)).toBe(3);
    expect(Number(records[0]?.reasoningTokens)).toBe(2);
    expect(records[0]).not.toHaveProperty('input');
    expect(records[0]).not.toHaveProperty('instructions');
    expect(records[0]).not.toHaveProperty('prompt');
    expect(records[0]).not.toHaveProperty('output');
    expect(records[0]).not.toHaveProperty('rawError');
  });

  it('fails closed before the adapter on a real SQLite persistence conflict', async () => {
    const aiRunId = '00000000-0000-4000-8000-000000000121';
    await recorder.record(startedEvent(aiRunId));
    const observation: TransactionObservation = { adapterCalls: 0 };
    const gateway = createSqliteGateway(aiRunId, observation);

    await expect(gateway.call(gatewayRequest())).rejects.toMatchObject({
      code: 'AI_AUDIT_FAILED',
      details: { stage: 'STARTED' },
    });
    expect(observation.adapterCalls).toBe(0);
    await expect(readAllAiRuns()).resolves.toHaveLength(1);
    await expect(readAiRun(aiRunId)).resolves.toMatchObject({ status: 'STARTED' });
  });
});

describe('CAP request and SQLite transaction composition', () => {
  it('fails closed within five seconds instead of entering the gateway with an active request DB transaction', async () => {
    const aiRunId = '00000000-0000-4000-8000-000000000130';

    await expect(
      withHardTimeout(
        POST('/test-ai-transaction/executeGateway', {
          aiRunId,
          mode: 'ACTIVE_REQUEST_TRANSACTION',
        }),
      ),
    ).rejects.toMatchObject({ status: 500 });

    expect(transactionObservations.get(aiRunId)).toMatchObject({
      adapterCalls: 0,
      errorCode: 'AI_AUDIT_FAILED',
      transactionBoundary: 'ACTIVE_CAP_DATABASE_TRANSACTION',
    });
    expect(await readTransactionProbe(aiRunId)).toBeUndefined();
    expect(await readAiRun(aiRunId)).toBeUndefined();
  });

  it('uses a phased boundary and exposes committed STARTED to the adapter before product writes', async () => {
    const aiRunId = '00000000-0000-4000-8000-000000000131';

    const response = await withHardTimeout(
      POST('/test-ai-transaction/executeGateway', {
        aiRunId,
        mode: 'SAFE_BOUNDARY',
      }),
    );

    expect(response.data.value ?? response.data).toBe('ok');
    expect(transactionObservations.get(aiRunId)).toMatchObject({
      adapterCalls: 1,
      startedSeenByAdapter: {
        ID: aiRunId,
        status: 'STARTED',
      },
    });
    expect(await readAiRun(aiRunId)).toMatchObject({
      status: 'SUCCEEDED',
      responseModel: 'gpt-5.6-luna-sqlite-snapshot',
    });
    expect(await readTransactionProbe(aiRunId)).toBeDefined();
  });

  it('keeps SUCCEEDED audit committed when the later product request transaction rolls back', async () => {
    const aiRunId = '00000000-0000-4000-8000-000000000132';

    await expect(
      withHardTimeout(
        POST('/test-ai-transaction/executeGateway', {
          aiRunId,
          mode: 'SAFE_BOUNDARY_ROLLBACK',
        }),
      ),
    ).rejects.toMatchObject({ status: 500 });

    expect(transactionObservations.get(aiRunId)).toMatchObject({
      adapterCalls: 1,
      startedSeenByAdapter: {
        ID: aiRunId,
        status: 'STARTED',
      },
    });
    expect(await readTransactionProbe(aiRunId)).toBeUndefined();
    expect(await readAiRun(aiRunId)).toMatchObject({
      status: 'SUCCEEDED',
      responseModel: 'gpt-5.6-luna-sqlite-snapshot',
    });
  });
});
