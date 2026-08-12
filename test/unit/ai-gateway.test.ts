import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AiGateway } from '../../srv/ai/ai-gateway.js';
import { loadAiConfig } from '../../srv/ai/config.js';
import { AiProvider, AiTaskType, createInputFingerprint } from '../../srv/ai/contracts.js';
import type {
  AiCallResult,
  AiExecutionProfile,
  JsonValue,
  StructuredAiAdapter,
  StructuredAiRequest,
} from '../../srv/ai/contracts.js';
import { AiError } from '../../srv/ai/errors.js';
import type { AiRunRecorder, AiRunTelemetryEvent } from '../../srv/ai/telemetry.js';

const outputSchema = z.object({ decision: z.literal('ok') }).strict();
const fixedRunIds = [
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000002',
];

function request(taskType: AiTaskType): StructuredAiRequest<{ decision: 'ok' }> {
  return {
    taskType,
    promptVersion: 'prompt-v1',
    schemaVersion: 'schema-v1',
    schemaName: 'decision',
    instructions: 'Return the grounded decision.',
    input: { z: 1, nested: { b: true, a: 'secret-grounded-input' } },
    outputSchema,
  };
}

type ResultMutator = (result: AiCallResult<{ decision: 'ok' }>) => void;

class FakeAdapter implements StructuredAiAdapter {
  calls = 0;
  failWith?: AiError;
  mutator?: ResultMutator;
  readonly receivedProfiles: AiExecutionProfile[] = [];
  readonly receivedRequests: StructuredAiRequest<unknown>[] = [];

  constructor(
    readonly provider: AiProvider,
    private readonly order?: string[],
  ) {}

  async call<TOutput>(
    value: StructuredAiRequest<TOutput>,
    profile: AiExecutionProfile,
  ): Promise<AiCallResult<TOutput>> {
    this.calls += 1;
    this.order?.push('ADAPTER');
    this.receivedProfiles.push(profile);
    this.receivedRequests.push(value);
    if (this.failWith !== undefined) throw this.failWith;

    const result: AiCallResult<{ decision: 'ok' }> = {
      aiRunId: value.aiRunId ?? 'missing-ai-run-id',
      output: { decision: 'ok' },
      provider: this.provider,
      configuredModel: profile.model,
      responseModel: `${profile.model}-snapshot`,
      taskType: value.taskType,
      promptVersion: value.promptVersion,
      schemaVersion: value.schemaVersion,
      inputFingerprint: createInputFingerprint(value.input),
      usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
      latencyMs: 7,
      providerRequestId: `${this.provider}-request`,
      attempts: 1,
      refusal: { refused: false },
    };
    this.mutator?.(result);
    return result as AiCallResult<TOutput>;
  }
}

class MemoryRecorder implements AiRunRecorder {
  readonly events: AiRunTelemetryEvent[] = [];
  failStatus?: AiRunTelemetryEvent['status'];

  constructor(private readonly order?: string[]) {}

  async record(event: AiRunTelemetryEvent): Promise<void> {
    this.order?.push(event.status);
    if (event.status === this.failStatus) throw new Error(`recorder-${event.status}-failed`);
    this.events.push(event);
  }
}

function enabledConfig(overrides: Readonly<Record<string, string | undefined>> = {}) {
  return loadAiConfig({ AI_ENABLED: 'true', ...overrides });
}

function gateway(
  config = enabledConfig(),
  adapters: readonly StructuredAiAdapter[] = [new FakeAdapter(AiProvider.OPENAI)],
  recorder: AiRunRecorder = new MemoryRecorder(),
  ids = [...fixedRunIds],
  timestamps = [
    new Date('2026-08-12T10:00:00.000Z'),
    new Date('2026-08-12T10:00:01.000Z'),
    new Date('2026-08-12T10:00:02.000Z'),
  ],
): AiGateway {
  return new AiGateway(
    config,
    adapters,
    recorder,
    () => ids.shift() ?? fixedRunIds[1]!,
    () => timestamps.shift() ?? new Date('2026-08-12T10:00:03.000Z'),
  );
}

const metadataMismatchCases: readonly [string, ResultMutator][] = [
  ['provider', (result) => void (result.provider = AiProvider.ANTHROPIC)],
  ['configuredModel', (result) => void (result.configuredModel = 'other')],
  ['taskType', (result) => void (result.taskType = AiTaskType.JUDGE)],
  ['promptVersion', (result) => void (result.promptVersion = 'other')],
  ['schemaVersion', (result) => void (result.schemaVersion = 'other')],
  ['inputFingerprint', (result) => void (result.inputFingerprint = '0'.repeat(64))],
  ['aiRunId', (result) => void (result.aiRunId = 'other-run')],
  ['responseModel', (result) => void (result.responseModel = '   ')],
];

describe('task-aware AI gateway', () => {
  it('routes DECIDE to OpenAI Luna, GENERATE to Anthropic Sonnet and JUDGE to OpenAI Terra', async () => {
    const openai = new FakeAdapter(AiProvider.OPENAI);
    const anthropic = new FakeAdapter(AiProvider.ANTHROPIC);
    const subject = gateway(enabledConfig(), [openai, anthropic]);

    const decide = await subject.call(request(AiTaskType.DECIDE));
    const generate = await subject.call(request(AiTaskType.GENERATE));
    const judge = await subject.call(request(AiTaskType.JUDGE));

    expect(decide.configuredModel).toBe('gpt-5.6-luna');
    expect(generate.configuredModel).toBe('claude-sonnet-5');
    expect(judge.configuredModel).toBe('gpt-5.6-terra');
    expect(openai.calls).toBe(2);
    expect(anthropic.calls).toBe(1);
    expect(openai.receivedProfiles.map(({ taskType, model }) => ({ taskType, model }))).toEqual([
      { taskType: AiTaskType.DECIDE, model: 'gpt-5.6-luna' },
      { taskType: AiTaskType.JUDGE, model: 'gpt-5.6-terra' },
    ]);
    expect(anthropic.receivedProfiles[0]).toMatchObject({
      taskType: AiTaskType.GENERATE,
      provider: AiProvider.ANTHROPIC,
      model: 'claude-sonnet-5',
      effort: 'low',
      maxOutputTokens: 1_600,
    });
  });

  it('has no normal request provider override and obeys injected task configuration', async () => {
    const openai = new FakeAdapter(AiProvider.OPENAI);
    const anthropic = new FakeAdapter(AiProvider.ANTHROPIC);
    const normalRequest = request(AiTaskType.DECIDE);
    const subject = gateway(
      enabledConfig({
        AI_DECIDE_PROVIDER: 'anthropic',
        AI_DECIDE_MODEL: 'claude-controlled-route',
        AI_DECIDE_EFFORT: 'medium',
      }),
      [openai, anthropic],
    );

    const result = await subject.call(normalRequest);

    expect(normalRequest).not.toHaveProperty('provider');
    expect(result).toMatchObject({
      provider: AiProvider.ANTHROPIC,
      configuredModel: 'claude-controlled-route',
    });
    expect(openai.calls).toBe(0);
    expect(anthropic.calls).toBe(1);
  });

  it('passes one immutable execution profile and a gateway-owned run ID to the adapter', async () => {
    const openai = new FakeAdapter(AiProvider.OPENAI);
    const callerRequest = { ...request(AiTaskType.DECIDE), aiRunId: 'caller-must-not-control-id' };
    const subject = gateway(enabledConfig(), [openai]);

    const result = await subject.call(callerRequest);

    expect(openai.receivedProfiles[0]).toEqual(enabledConfig().taskProfiles.DECIDE);
    expect(openai.receivedRequests[0]?.aiRunId).toBe(fixedRunIds[0]);
    expect(result.aiRunId).toBe(fixedRunIds[0]);
    expect(callerRequest.aiRunId).toBe('caller-must-not-control-id');
  });

  it('creates a unique stable aiRunId for every execution', async () => {
    const openai = new FakeAdapter(AiProvider.OPENAI);
    const subject = gateway(enabledConfig(), [openai]);

    const first = await subject.call(request(AiTaskType.DECIDE));
    const second = await subject.call(request(AiTaskType.DECIDE));

    expect(first.aiRunId).toBe(fixedRunIds[0]);
    expect(second.aiRunId).toBe(fixedRunIds[1]);
    expect(first.aiRunId).not.toBe(second.aiRunId);
  });

  it('awaits STARTED before the adapter and SUCCEEDED after a validated result', async () => {
    const order: string[] = [];
    const recorder = new MemoryRecorder(order);
    const openai = new FakeAdapter(AiProvider.OPENAI, order);
    const subject = gateway(enabledConfig(), [openai], recorder);

    const result = await subject.call(request(AiTaskType.DECIDE));

    expect(order).toEqual(['STARTED', 'ADAPTER', 'SUCCEEDED']);
    expect(result).toMatchObject({
      configuredModel: 'gpt-5.6-luna',
      responseModel: 'gpt-5.6-luna-snapshot',
    });
    expect(recorder.events[1]).toMatchObject({
      aiRunId: fixedRunIds[0],
      status: 'SUCCEEDED',
      configuredModel: 'gpt-5.6-luna',
      responseModel: 'gpt-5.6-luna-snapshot',
      providerRequestId: 'OPENAI-request',
      refusal: { refused: false },
    });
  });

  it('records FAILED after an adapter error and does not fall back', async () => {
    const order: string[] = [];
    const recorder = new MemoryRecorder(order);
    const openai = new FakeAdapter(AiProvider.OPENAI, order);
    const anthropic = new FakeAdapter(AiProvider.ANTHROPIC, order);
    openai.failWith = new AiError('RATE_LIMITED', 'OpenAI rate limited.', {
      provider: AiProvider.OPENAI,
      retryable: true,
    });
    const subject = gateway(enabledConfig(), [openai, anthropic], recorder);

    await expect(subject.call(request(AiTaskType.DECIDE))).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });
    expect(order).toEqual(['STARTED', 'ADAPTER', 'FAILED']);
    expect(recorder.events[1]).toMatchObject({
      status: 'FAILED',
      errorCode: 'RATE_LIMITED',
      retryable: true,
    });
    expect(anthropic.calls).toBe(0);
  });

  it('fails closed before the adapter when STARTED recording fails', async () => {
    const recorder = new MemoryRecorder();
    recorder.failStatus = 'STARTED';
    const openai = new FakeAdapter(AiProvider.OPENAI);
    const subject = gateway(enabledConfig(), [openai], recorder);

    await expect(subject.call(request(AiTaskType.DECIDE))).rejects.toMatchObject({
      code: 'AI_AUDIT_FAILED',
      details: { stage: 'STARTED' },
    });
    expect(openai.calls).toBe(0);
  });

  it('fails closed without returning output when SUCCEEDED recording fails', async () => {
    const recorder = new MemoryRecorder();
    recorder.failStatus = 'SUCCEEDED';
    const openai = new FakeAdapter(AiProvider.OPENAI);
    const subject = gateway(enabledConfig(), [openai], recorder);

    await expect(subject.call(request(AiTaskType.DECIDE))).rejects.toMatchObject({
      code: 'AI_AUDIT_FAILED',
      details: { stage: 'SUCCEEDED' },
    });
    expect(openai.calls).toBe(1);
  });

  it('returns AI_AUDIT_FAILED with only the original code when FAILED recording fails', async () => {
    const recorder = new MemoryRecorder();
    recorder.failStatus = 'FAILED';
    const openai = new FakeAdapter(AiProvider.OPENAI);
    openai.failWith = new AiError('AI_TIMEOUT', 'Safe timeout.', {
      provider: AiProvider.OPENAI,
      retryable: true,
      cause: new Error('raw provider error'),
    });
    const subject = gateway(enabledConfig(), [openai], recorder);

    const promise = subject.call(request(AiTaskType.DECIDE));
    await expect(promise).rejects.toMatchObject({
      code: 'AI_AUDIT_FAILED',
      details: { originalErrorCode: 'AI_TIMEOUT' },
    });
    await expect(promise).rejects.not.toMatchObject({ details: { stage: expect.anything() } });
  });

  it.each(metadataMismatchCases)(
    'rejects a mismatched adapter result %s metadata field',
    async (_field, mutate) => {
      const recorder = new MemoryRecorder();
      const openai = new FakeAdapter(AiProvider.OPENAI);
      openai.mutator = mutate;
      const subject = gateway(enabledConfig(), [openai], recorder);

      await expect(subject.call(request(AiTaskType.DECIDE))).rejects.toMatchObject({
        code: 'PROVIDER_ERROR',
      });
      expect(recorder.events.map(({ status }) => status)).toEqual(['STARTED', 'FAILED']);
    },
  );

  it('records metadata without instructions, grounded input or parsed output', async () => {
    const recorder = new MemoryRecorder();
    const openai = new FakeAdapter(AiProvider.OPENAI);
    const subject = gateway(enabledConfig(), [openai], recorder);

    await subject.call(request(AiTaskType.DECIDE));
    const telemetry = JSON.stringify(recorder.events);

    expect(telemetry).not.toContain('secret-grounded-input');
    expect(telemetry).not.toContain('Return the grounded decision');
    expect(telemetry).not.toContain('"decision"');
    expect(telemetry).not.toContain('outputSchema');
  });

  it('returns AI_DISABLED before fingerprinting, ID generation or recorder use', async () => {
    const openai = new FakeAdapter(AiProvider.OPENAI);
    const recorder = new MemoryRecorder();
    let generatedIds = 0;
    const subject = new AiGateway(loadAiConfig({}), [openai], recorder, () => {
      generatedIds += 1;
      return fixedRunIds[0]!;
    });
    const cyclicInput: Record<string, unknown> = {};
    cyclicInput.self = cyclicInput;
    const invalidRuntimeRequest = request(AiTaskType.DECIDE);
    invalidRuntimeRequest.input = cyclicInput as unknown as JsonValue;

    await expect(subject.call(invalidRuntimeRequest)).rejects.toMatchObject({
      code: 'AI_DISABLED',
      provider: AiProvider.OPENAI,
      model: 'gpt-5.6-luna',
    });
    expect(generatedIds).toBe(0);
    expect(openai.calls).toBe(0);
    expect(recorder.events).toHaveLength(0);
  });

  it('creates the same fingerprint for objects with different key insertion order', () => {
    expect(createInputFingerprint({ b: 2, a: { y: true, x: 1 } })).toBe(
      createInputFingerprint({ a: { x: 1, y: true }, b: 2 }),
    );
    expect(createInputFingerprint({ a: [1, 2] })).not.toBe(createInputFingerprint({ a: [2, 1] }));
  });

  it('rejects duplicate adapters for one provider', () => {
    expect(() =>
      gateway(enabledConfig(), [
        new FakeAdapter(AiProvider.OPENAI),
        new FakeAdapter(AiProvider.OPENAI),
      ]),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_AI_CONFIGURATION' }));
  });
});
