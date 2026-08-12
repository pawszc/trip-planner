import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AiGateway } from '../../srv/ai/ai-gateway.js';
import { loadAiConfig } from '../../srv/ai/config.js';
import { AiProvider, AiTaskType, createInputFingerprint } from '../../srv/ai/contracts.js';
import type {
  AiCallResult,
  JsonValue,
  StructuredAiAdapter,
  StructuredAiRequest,
} from '../../srv/ai/contracts.js';
import { AiError } from '../../srv/ai/errors.js';
import type { AiRunRecorder, AiRunTelemetryEvent } from '../../srv/ai/telemetry.js';

const outputSchema = z.object({ decision: z.literal('ok') }).strict();

function request(
  taskType: AiTaskType,
  provider?: AiProvider,
): StructuredAiRequest<{ decision: 'ok' }> {
  return {
    taskType,
    promptVersion: 'prompt-v1',
    schemaVersion: 'schema-v1',
    schemaName: 'decision',
    instructions: 'Return the grounded decision.',
    input: { z: 1, nested: { b: true, a: 'secret-grounded-input' } },
    outputSchema,
    ...(provider === undefined ? {} : { provider }),
  };
}

class FakeAdapter implements StructuredAiAdapter {
  calls = 0;
  failWith?: AiError;

  constructor(
    readonly provider: AiProvider,
    readonly model: string,
  ) {}

  async call<TOutput>(value: StructuredAiRequest<TOutput>): Promise<AiCallResult<TOutput>> {
    this.calls += 1;
    if (this.failWith !== undefined) {
      throw this.failWith;
    }
    return {
      output: value.outputSchema.parse({ decision: 'ok' }),
      provider: this.provider,
      model: this.model,
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
  }
}

class MemoryRecorder implements AiRunRecorder {
  readonly events: AiRunTelemetryEvent[] = [];

  record(event: AiRunTelemetryEvent): void {
    this.events.push(event);
  }
}

function enabledConfig() {
  return loadAiConfig({ AI_ENABLED: 'true' });
}

describe('vendor-neutral AI gateway', () => {
  it('routes DECIDE to OpenAI and GENERATE to Anthropic', async () => {
    const openai = new FakeAdapter(AiProvider.OPENAI, 'openai-model');
    const anthropic = new FakeAdapter(AiProvider.ANTHROPIC, 'anthropic-model');
    const gateway = new AiGateway(enabledConfig(), [openai, anthropic]);

    await gateway.call(request(AiTaskType.DECIDE));
    await gateway.call(request(AiTaskType.GENERATE));

    expect(openai.calls).toBe(1);
    expect(anthropic.calls).toBe(1);
  });

  it('honors an explicit provider override', async () => {
    const openai = new FakeAdapter(AiProvider.OPENAI, 'openai-model');
    const anthropic = new FakeAdapter(AiProvider.ANTHROPIC, 'anthropic-model');
    const gateway = new AiGateway(enabledConfig(), [openai, anthropic]);

    const result = await gateway.call(request(AiTaskType.DECIDE, AiProvider.ANTHROPIC));

    expect(result.provider).toBe(AiProvider.ANTHROPIC);
    expect(openai.calls).toBe(0);
    expect(anthropic.calls).toBe(1);
  });

  it('returns AI_DISABLED without invoking an adapter', async () => {
    const openai = new FakeAdapter(AiProvider.OPENAI, 'openai-model');
    const gateway = new AiGateway(loadAiConfig({}), [openai]);

    await expect(gateway.call(request(AiTaskType.DECIDE))).rejects.toMatchObject({
      code: 'AI_DISABLED',
      provider: AiProvider.OPENAI,
    });
    expect(openai.calls).toBe(0);
  });

  it('returns AI_DISABLED before fingerprinting a cyclic runtime input', async () => {
    const openai = new FakeAdapter(AiProvider.OPENAI, 'openai-model');
    const gateway = new AiGateway(loadAiConfig({}), [openai]);
    const cyclicInput: Record<string, unknown> = {};
    cyclicInput.self = cyclicInput;
    const invalidRuntimeRequest = request(AiTaskType.DECIDE);
    invalidRuntimeRequest.input = cyclicInput as unknown as JsonValue;

    await expect(gateway.call(invalidRuntimeRequest)).rejects.toMatchObject({
      name: 'AiError',
      code: 'AI_DISABLED',
      provider: AiProvider.OPENAI,
      model: 'openai-model',
    });
    expect(openai.calls).toBe(0);
  });

  it('does not fall back when the selected provider fails', async () => {
    const openai = new FakeAdapter(AiProvider.OPENAI, 'openai-model');
    const anthropic = new FakeAdapter(AiProvider.ANTHROPIC, 'anthropic-model');
    openai.failWith = new AiError('RATE_LIMITED', 'OpenAI rate limited.', {
      provider: AiProvider.OPENAI,
      retryable: true,
    });
    const gateway = new AiGateway(enabledConfig(), [openai, anthropic]);

    await expect(gateway.call(request(AiTaskType.DECIDE))).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });
    expect(openai.calls).toBe(1);
    expect(anthropic.calls).toBe(0);
  });

  it('preserves prompt and schema versions and records metadata without input or output', async () => {
    const recorder = new MemoryRecorder();
    const openai = new FakeAdapter(AiProvider.OPENAI, 'openai-model');
    const gateway = new AiGateway(enabledConfig(), [openai], recorder);

    const result = await gateway.call(request(AiTaskType.DECIDE));
    const telemetry = JSON.stringify(recorder.events);

    expect(result).toMatchObject({ promptVersion: 'prompt-v1', schemaVersion: 'schema-v1' });
    expect(recorder.events.map((event) => event.status)).toEqual(['STARTED', 'SUCCEEDED']);
    expect(recorder.events[1]).toMatchObject({
      providerRequestId: 'OPENAI-request',
      refusal: { refused: false },
    });
    expect(telemetry).not.toContain('secret-grounded-input');
    expect(telemetry).not.toContain('decision');
  });

  it('creates the same fingerprint for objects with different key insertion order', () => {
    expect(createInputFingerprint({ b: 2, a: { y: true, x: 1 } })).toBe(
      createInputFingerprint({ a: { x: 1, y: true }, b: 2 }),
    );
    expect(createInputFingerprint({ a: [1, 2] })).not.toBe(createInputFingerprint({ a: [2, 1] }));
  });

  it('rejects duplicate adapters for one provider', () => {
    expect(
      () =>
        new AiGateway(enabledConfig(), [
          new FakeAdapter(AiProvider.OPENAI, 'one'),
          new FakeAdapter(AiProvider.OPENAI, 'two'),
        ]),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_AI_CONFIGURATION' }));
  });
});
