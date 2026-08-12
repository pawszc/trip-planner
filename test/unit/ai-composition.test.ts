import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { loadAiConfig } from '../../srv/ai/config.js';
import { createPersistentAiGateway } from '../../srv/ai/create-persistent-ai-gateway.js';
import { AiProvider, AiTaskType, createInputFingerprint } from '../../srv/ai/contracts.js';
import type {
  AiCallResult,
  AiExecutionProfile,
  StructuredAiAdapter,
  StructuredAiRequest,
} from '../../srv/ai/contracts.js';
import type {
  AiRunFailedUpdate,
  AiRunStartedRecord,
  AiRunStore,
  AiRunSucceededUpdate,
} from '../../srv/ai/persistence/ai-run-store.js';

const fixedRunId = '00000000-0000-4000-8000-000000000050';
const outputSchema = z.object({ decision: z.literal('ok') }).strict();

class RecordingStore implements AiRunStore {
  readonly started: AiRunStartedRecord[] = [];
  readonly succeeded: { ID: string; update: AiRunSucceededUpdate }[] = [];
  readonly failed: { ID: string; update: AiRunFailedUpdate }[] = [];
  failStarted = false;

  constructor(private readonly order: string[]) {}

  async insertStarted(record: AiRunStartedRecord): Promise<void> {
    this.order.push('STARTED');
    if (this.failStarted) throw new Error('test persistence failure');
    this.started.push(record);
  }

  async completeSucceeded(ID: string, update: AiRunSucceededUpdate): Promise<void> {
    this.order.push('SUCCEEDED');
    this.succeeded.push({ ID, update });
  }

  async completeFailed(ID: string, update: AiRunFailedUpdate): Promise<void> {
    this.order.push('FAILED');
    this.failed.push({ ID, update });
  }

  deleteExpired(): Promise<number> {
    return Promise.resolve(0);
  }
}

class RecordingAdapter implements StructuredAiAdapter {
  readonly provider = AiProvider.OPENAI;
  calls = 0;

  constructor(private readonly order: string[]) {}

  async call<TOutput>(
    request: StructuredAiRequest<TOutput>,
    profile: AiExecutionProfile,
  ): Promise<AiCallResult<TOutput>> {
    this.calls += 1;
    this.order.push('ADAPTER');
    return {
      aiRunId: request.aiRunId!,
      output: request.outputSchema.parse({ decision: 'ok' }),
      provider: this.provider,
      configuredModel: profile.model,
      responseModel: 'gpt-response-snapshot',
      taskType: request.taskType,
      promptVersion: request.promptVersion,
      schemaVersion: request.schemaVersion,
      inputFingerprint: createInputFingerprint(request.input),
      usage: { inputTokens: 8, outputTokens: 3, totalTokens: 11 },
      latencyMs: 15,
      attempts: 1,
      refusal: { refused: false },
    };
  }
}

function request(): StructuredAiRequest<{ decision: 'ok' }> {
  return {
    taskType: AiTaskType.DECIDE,
    promptVersion: 'prompt-v1',
    schemaVersion: 'schema-v1',
    schemaName: 'decision',
    instructions: 'Return one grounded decision.',
    input: { grounded: true },
    outputSchema,
  };
}

describe('persistent AI gateway composition', () => {
  it('constructs the default persistent composition without database or network side effects', () => {
    expect(() => createPersistentAiGateway(loadAiConfig({}))).not.toThrow();
  });

  it('uses PersistentAiRunRecorder with configured retention instead of a silent no-op', async () => {
    const order: string[] = [];
    const store = new RecordingStore(order);
    const adapter = new RecordingAdapter(order);
    const times = [new Date('2026-08-12T10:00:00.000Z'), new Date('2026-08-12T10:00:01.000Z')];
    const gateway = createPersistentAiGateway(
      loadAiConfig({ AI_ENABLED: 'true', AI_RUN_RETENTION_DAYS: '7' }),
      {
        adapters: [adapter],
        store,
        generateAiRunId: () => fixedRunId,
        now: () => times.shift() ?? new Date('2026-08-12T10:00:02.000Z'),
      },
    );

    await expect(gateway.call(request())).resolves.toMatchObject({ aiRunId: fixedRunId });

    expect(order).toEqual(['STARTED', 'ADAPTER', 'SUCCEEDED']);
    expect(store.started).toEqual([
      expect.objectContaining({
        ID: fixedRunId,
        status: 'STARTED',
        expiresAt: '2026-08-19T10:00:00.000Z',
      }),
    ]);
    expect(store.succeeded).toEqual([
      expect.objectContaining({
        ID: fixedRunId,
        update: expect.objectContaining({
          status: 'SUCCEEDED',
          responseModel: 'gpt-response-snapshot',
        }),
      }),
    ]);
  });

  it('fails closed at persistent STARTED and never calls the adapter', async () => {
    const order: string[] = [];
    const store = new RecordingStore(order);
    store.failStarted = true;
    const adapter = new RecordingAdapter(order);
    const gateway = createPersistentAiGateway(loadAiConfig({ AI_ENABLED: 'true' }), {
      adapters: [adapter],
      store,
      generateAiRunId: () => fixedRunId,
    });

    await expect(gateway.call(request())).rejects.toMatchObject({
      code: 'AI_AUDIT_FAILED',
      details: { stage: 'STARTED' },
    });
    expect(order).toEqual(['STARTED']);
    expect(adapter.calls).toBe(0);
  });
});
