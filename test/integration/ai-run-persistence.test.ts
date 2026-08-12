import { randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AiProvider, AiTaskType } from '../../srv/ai/contracts.js';
import { CapAiRunStore } from '../../srv/ai/persistence/cap-ai-run-store.js';
import { PersistentAiRunRecorder } from '../../srv/ai/persistence/persistent-ai-run-recorder.js';
import type { AiRunTelemetryEvent } from '../../srv/ai/telemetry.js';
import { referenceTripRequestODataPayload } from '../fixtures/trip-request.js';

process.env.CDS_TYPESCRIPT = 'true';
const { default: cds } = await import('@sap/cds');
const test = cds.test('serve', 'all', '--in-memory').in(process.cwd());
const { GET, POST } = test;

const fingerprint = 'b'.repeat(64);
const store = new CapAiRunStore();
const recorder = new PersistentAiRunRecorder(store, 30);

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
});

beforeEach(test.data.reset);

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
