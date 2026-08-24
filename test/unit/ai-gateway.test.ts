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
import { NoopAiOperationalSignalSink, NoopAiRunRecorder } from '../../srv/ai/telemetry.js';
import type {
  AiOperationalSignalSink,
  AiPreStartFailureSignal,
  AiRunRecorder,
  AiRunTelemetryEvent,
} from '../../srv/ai/telemetry.js';

const outputSchema = z.object({ decision: z.literal('ok') }).strict();
const fixedRunIds = [
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000002',
];
const planningRunId = '00000000-0000-4000-8000-000000000101';
const rankedOptionId = '00000000-0000-4000-8000-000000000102';

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
  failureMessage = 'recorder-failed';

  constructor(private readonly order?: string[]) {}

  async record(event: AiRunTelemetryEvent): Promise<void> {
    this.order?.push(event.status);
    if (event.status === this.failStatus) throw new Error(this.failureMessage);
    this.events.push(event);
  }
}

class MemoryOperationalSignalSink implements AiOperationalSignalSink {
  readonly signals: AiPreStartFailureSignal[] = [];
  failWith?: Error;

  async emit(signal: AiPreStartFailureSignal): Promise<void> {
    this.signals.push(signal);
    if (this.failWith !== undefined) throw this.failWith;
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
  operationalSignalSink: AiOperationalSignalSink = new NoopAiOperationalSignalSink(),
): AiGateway {
  return new AiGateway(
    config,
    adapters,
    recorder,
    () => ids.shift() ?? fixedRunIds[1]!,
    () => timestamps.shift() ?? new Date('2026-08-12T10:00:03.000Z'),
    operationalSignalSink,
  );
}

function narrativeRequest(
  taskType: typeof AiTaskType.GENERATE | typeof AiTaskType.JUDGE,
): StructuredAiRequest<{ decision: 'ok' }> {
  return {
    ...request(taskType),
    planningRunId,
    rankedOptionId,
    instructions: 'RAW_PROMPT_SENTINEL must never enter operational telemetry.',
    input: {
      candidate: 'RAW_CANDIDATE_SENTINEL',
      providerPayload: 'RAW_INPUT_SENTINEL',
    },
  };
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
  it('routes DECIDE and JUDGE to OpenAI Luna and GENERATE to Anthropic Sonnet', async () => {
    const openai = new FakeAdapter(AiProvider.OPENAI);
    const anthropic = new FakeAdapter(AiProvider.ANTHROPIC);
    const subject = gateway(enabledConfig(), [openai, anthropic]);

    const decide = await subject.call(request(AiTaskType.DECIDE));
    const generate = await subject.call(request(AiTaskType.GENERATE));
    const judge = await subject.call(request(AiTaskType.JUDGE));

    expect(decide.configuredModel).toBe('gpt-5.6-luna');
    expect(generate.configuredModel).toBe('claude-sonnet-5');
    expect(judge.configuredModel).toBe('gpt-5.6-luna');
    expect(openai.calls).toBe(2);
    expect(anthropic.calls).toBe(1);
    expect(openai.receivedProfiles.map(({ taskType, model }) => ({ taskType, model }))).toEqual([
      { taskType: AiTaskType.DECIDE, model: 'gpt-5.6-luna' },
      { taskType: AiTaskType.JUDGE, model: 'gpt-5.6-luna' },
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

  it('allows a deliberately non-persistent test composition only with an explicit no-op recorder', async () => {
    const openai = new FakeAdapter(AiProvider.OPENAI);
    const subject = new AiGateway(
      enabledConfig(),
      [openai],
      new NoopAiRunRecorder(),
      () => fixedRunIds[0]!,
    );

    await expect(subject.call(request(AiTaskType.DECIDE))).resolves.toMatchObject({
      aiRunId: fixedRunIds[0],
      configuredModel: 'gpt-5.6-luna',
    });
    expect(openai.calls).toBe(1);
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

  it('preserves closed terminal evidence through FAILED audit and durable run ID wrapping', async () => {
    const recorder = new MemoryRecorder();
    const openai = new FakeAdapter(AiProvider.OPENAI);
    const rawSentinels = 'RAW_PROMPT RAW_CANDIDATE RAW_PROVIDER_MESSAGE https://private.test/x';
    openai.failWith = new AiError(
      'INCOMPLETE_MODEL_OUTPUT',
      'OpenAI terminal response was incomplete.',
      {
        provider: AiProvider.OPENAI,
        model: 'gpt-5.6-luna',
        retryable: false,
        executionEvidence: {
          provider: AiProvider.OPENAI,
          configuredModel: 'gpt-5.6-luna',
          responseModel: 'gpt-5.6-luna-snapshot',
          providerResponseStatus: 'INCOMPLETE',
          providerIncompleteReason: 'MAX_OUTPUT_TOKENS',
          providerRequestId: 'req_gateway_safe',
          providerResponseId: 'resp_gateway_safe',
          usage: {
            inputTokens: 100,
            outputTokens: 20,
            totalTokens: 120,
            cacheReadTokens: 0,
            cacheWriteTokens: 80,
            reasoningTokens: 5,
          },
          attempts: 1,
          latencyMs: 250,
        },
        cause: new Error(rawSentinels),
      },
    );
    const subject = gateway(enabledConfig(), [openai], recorder);

    let failure: AiError | undefined;
    try {
      await subject.call(request(AiTaskType.DECIDE));
    } catch (error) {
      if (error instanceof AiError) failure = error;
    }

    expect(failure).toMatchObject({
      code: 'INCOMPLETE_MODEL_OUTPUT',
      details: { aiRunId: fixedRunIds[0] },
      executionEvidence: {
        providerResponseStatus: 'INCOMPLETE',
        providerIncompleteReason: 'MAX_OUTPUT_TOKENS',
        attempts: 1,
      },
    });
    expect(recorder.events[1]).toMatchObject({
      status: 'FAILED',
      errorCode: 'INCOMPLETE_MODEL_OUTPUT',
      responseModel: 'gpt-5.6-luna-snapshot',
      providerRequestId: 'req_gateway_safe',
      providerResponseId: 'resp_gateway_safe',
      providerResponseStatus: 'INCOMPLETE',
      providerIncompleteReason: 'MAX_OUTPUT_TOKENS',
      attempts: 1,
      latencyMs: 250,
      usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
    });
    expect(JSON.stringify(failure?.toSafeJSON())).not.toContain(rawSentinels);
    expect(JSON.stringify(recorder.events)).not.toContain(rawSentinels);
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

  it.each([AiTaskType.GENERATE, AiTaskType.JUDGE] as const)(
    'emits exactly one privacy-safe %s signal when durable STARTED fails',
    async (taskType) => {
      const config = enabledConfig();
      const adapter = new FakeAdapter(config.taskProfiles[taskType].provider);
      const recorder = new MemoryRecorder();
      recorder.failStatus = 'STARTED';
      recorder.failureMessage = 'RAW_ERROR_SENTINEL from persistence';
      const sink = new MemoryOperationalSignalSink();
      const value = narrativeRequest(taskType);
      const subject = gateway(
        config,
        [adapter],
        recorder,
        [fixedRunIds[0]!],
        [new Date('2026-08-12T10:00:00.000Z')],
        sink,
      );

      await expect(subject.call(value)).rejects.toMatchObject({
        code: 'AI_AUDIT_FAILED',
        details: { stage: 'STARTED' },
      });

      expect(adapter.calls).toBe(0);
      expect(recorder.events).toHaveLength(0);
      expect(sink.signals).toEqual([
        {
          eventType: 'AI_PRE_START_FAILURE',
          stage: 'BEFORE_DURABLE_STARTED',
          taskType,
          failureCode: 'AI_AUDIT_FAILED',
          planningRunId,
          rankedOptionId,
          promptVersion: 'prompt-v1',
          schemaVersion: 'schema-v1',
          inputFingerprint: createInputFingerprint(value.input),
          providerCallAttempted: false,
          occurredAt: '2026-08-12T10:00:00.000Z',
        },
      ]);
      expect(sink.signals[0]).not.toHaveProperty('aiRunId');
      expect(JSON.stringify(sink.signals)).not.toMatch(
        /RAW_PROMPT_SENTINEL|RAW_CANDIDATE_SENTINEL|RAW_INPUT_SENTINEL|RAW_ERROR_SENTINEL/u,
      );
    },
  );

  it.each([AiTaskType.GENERATE, AiTaskType.JUDGE] as const)(
    'emits exactly one %s signal for AI_DISABLED without fingerprinting or creating an ID',
    async (taskType) => {
      const config = loadAiConfig({});
      const adapter = new FakeAdapter(config.taskProfiles[taskType].provider);
      const recorder = new MemoryRecorder();
      const sink = new MemoryOperationalSignalSink();
      sink.failWith = new Error('RAW_SINK_ERROR_SENTINEL');
      let generatedIds = 0;
      const subject = new AiGateway(
        config,
        [adapter],
        recorder,
        () => {
          generatedIds += 1;
          return fixedRunIds[0]!;
        },
        () => new Date('2026-08-12T10:00:00.000Z'),
        sink,
      );

      await expect(subject.call(narrativeRequest(taskType))).rejects.toMatchObject({
        code: 'AI_DISABLED',
      });

      expect(generatedIds).toBe(0);
      expect(adapter.calls).toBe(0);
      expect(recorder.events).toHaveLength(0);
      expect(sink.signals).toHaveLength(1);
      expect(sink.signals[0]).toMatchObject({
        eventType: 'AI_PRE_START_FAILURE',
        stage: 'BEFORE_DURABLE_STARTED',
        taskType,
        failureCode: 'AI_DISABLED',
        planningRunId,
        rankedOptionId,
        providerCallAttempted: false,
        occurredAt: '2026-08-12T10:00:00.000Z',
      });
      expect(sink.signals[0]).not.toHaveProperty('inputFingerprint');
      expect(sink.signals[0]).not.toHaveProperty('aiRunId');
      expect(JSON.stringify(sink.signals)).not.toMatch(/RAW_|candidate|instructions|cause|stack/iu);
    },
  );

  it.each([AiTaskType.GENERATE, AiTaskType.JUDGE] as const)(
    'emits one controlled %s signal for invalid profile configuration before STARTED',
    async (taskType) => {
      const config = enabledConfig();
      const invalidConfig = {
        ...config,
        taskProfiles: {
          ...config.taskProfiles,
          [taskType]: { ...config.taskProfiles[taskType], maxOutputTokens: 0 },
        },
      };
      const adapter = new FakeAdapter(config.taskProfiles[taskType].provider);
      const recorder = new MemoryRecorder();
      const sink = new MemoryOperationalSignalSink();
      const subject = new AiGateway(
        invalidConfig,
        [adapter],
        recorder,
        () => fixedRunIds[0]!,
        () => new Date('2026-08-12T10:00:00.000Z'),
        sink,
      );

      await expect(subject.call(narrativeRequest(taskType))).rejects.toMatchObject({
        code: 'INVALID_AI_CONFIGURATION',
      });

      expect(adapter.calls).toBe(0);
      expect(recorder.events).toHaveLength(0);
      expect(sink.signals).toHaveLength(1);
      expect(sink.signals[0]).toMatchObject({
        taskType,
        failureCode: 'INVALID_AI_CONFIGURATION',
        providerCallAttempted: false,
      });
      expect(sink.signals[0]).not.toHaveProperty('aiRunId');
    },
  );

  it.each([AiTaskType.GENERATE, AiTaskType.JUDGE] as const)(
    'never exposes an invalid generated ID in the %s pre-STARTED signal',
    async (taskType) => {
      const config = enabledConfig();
      const adapter = new FakeAdapter(config.taskProfiles[taskType].provider);
      const recorder = new MemoryRecorder();
      const sink = new MemoryOperationalSignalSink();
      const value = narrativeRequest(taskType);
      const subject = new AiGateway(
        config,
        [adapter],
        recorder,
        () => 'RAW_FAKE_AI_RUN_ID_SENTINEL',
        () => new Date('2026-08-12T10:00:00.000Z'),
        sink,
      );

      await expect(subject.call(value)).rejects.toMatchObject({
        code: 'INVALID_AI_CONFIGURATION',
        details: { field: 'aiRunId' },
      });

      expect(adapter.calls).toBe(0);
      expect(recorder.events).toHaveLength(0);
      expect(sink.signals).toHaveLength(1);
      expect(sink.signals[0]).toMatchObject({
        taskType,
        failureCode: 'INVALID_AI_CONFIGURATION',
        inputFingerprint: createInputFingerprint(value.input),
        providerCallAttempted: false,
      });
      expect(sink.signals[0]).not.toHaveProperty('aiRunId');
      expect(JSON.stringify(sink.signals)).not.toContain('RAW_FAKE_AI_RUN_ID_SENTINEL');
    },
  );

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

  it('revalidates adapter output at the gateway boundary before recording SUCCEEDED', async () => {
    const recorder = new MemoryRecorder();
    const openai = new FakeAdapter(AiProvider.OPENAI);
    openai.mutator = (result) => {
      result.output = { decision: 'not-ok' } as unknown as { decision: 'ok' };
    };
    const subject = gateway(enabledConfig(), [openai], recorder);

    await expect(subject.call(request(AiTaskType.DECIDE))).rejects.toMatchObject({
      code: 'INVALID_STRUCTURED_OUTPUT',
    });
    expect(recorder.events.map(({ status }) => status)).toEqual(['STARTED', 'FAILED']);
    expect(recorder.events[1]).toMatchObject({ errorCode: 'INVALID_STRUCTURED_OUTPUT' });
  });

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
