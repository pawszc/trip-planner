import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AiGateway } from '../../srv/ai/ai-gateway.js';
import { loadAiConfig } from '../../srv/ai/config.js';
import { AiProvider, AiTaskType, createInputFingerprint } from '../../srv/ai/contracts.js';
import type {
  AiCallResult,
  AiExecutionProfile,
  StructuredAiAdapter,
  StructuredAiRequest,
} from '../../srv/ai/contracts.js';
import { AiError } from '../../srv/ai/errors.js';
import type { AiRunRecorder, AiRunTelemetryEvent } from '../../srv/ai/telemetry.js';

const outputSchema = z.object({ ok: z.literal(true) }).strict();
const aiRunId = '70000000-0000-4000-8000-000000000001';

function request(maxOutputTokens?: number): StructuredAiRequest<{ ok: true }> {
  return {
    taskType: AiTaskType.DECIDE,
    promptVersion: 'audit-metadata-prompt-v1',
    schemaVersion: 'audit-metadata-schema-v1',
    schemaName: 'audit_metadata',
    instructions: 'Return the controlled fixture.',
    input: { fixture: 'audit-metadata' },
    outputSchema,
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
  };
}

class RecordingAdapter implements StructuredAiAdapter {
  readonly provider = AiProvider.OPENAI;
  readonly requests: StructuredAiRequest<unknown>[] = [];
  failure?: AiError;

  async call<TOutput>(
    value: StructuredAiRequest<TOutput>,
    profile: AiExecutionProfile,
  ): Promise<AiCallResult<TOutput>> {
    this.requests.push(value);
    if (this.failure !== undefined) throw this.failure;
    return {
      aiRunId: value.aiRunId!,
      output: value.outputSchema.parse({ ok: true }),
      provider: this.provider,
      configuredModel: profile.model,
      responseModel: `${profile.model}-offline-snapshot`,
      taskType: value.taskType,
      promptVersion: value.promptVersion,
      schemaVersion: value.schemaVersion,
      inputFingerprint: createInputFingerprint(value.input),
      usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 },
      latencyMs: 5,
      attempts: 1,
      refusal: { refused: false },
    };
  }
}

class RecordingRecorder implements AiRunRecorder {
  readonly events: AiRunTelemetryEvent[] = [];
  failStatus?: AiRunTelemetryEvent['status'];

  async record(event: AiRunTelemetryEvent): Promise<void> {
    if (event.status === this.failStatus) throw new Error(`audit-${event.status}-failed`);
    this.events.push(event);
  }
}

function gateway(adapter: RecordingAdapter, recorder: RecordingRecorder) {
  const times = [new Date('2026-08-15T10:00:00.000Z'), new Date('2026-08-15T10:00:01.000Z')];
  return new AiGateway(
    loadAiConfig({ AI_ENABLED: 'true', AI_DECIDE_MAX_OUTPUT_TOKENS: '512' }),
    [adapter],
    recorder,
    () => aiRunId,
    () => times.shift() ?? new Date('2026-08-15T10:00:02.000Z'),
  );
}

describe('AI audit execution metadata', () => {
  it('fixes the effective output limit before STARTED and propagates the exact profile metadata', async () => {
    const adapter = new RecordingAdapter();
    const recorder = new RecordingRecorder();

    await gateway(adapter, recorder).call(request(128));

    expect(adapter.requests[0]?.maxOutputTokens).toBe(128);
    expect(recorder.events).toHaveLength(2);
    for (const event of recorder.events) {
      expect(event).toMatchObject({
        configuredEffort: 'none',
        configuredMaxOutputTokens: 512,
        effectiveMaxOutputTokens: 128,
      });
    }
  });

  it('caps a larger request at the configured profile and rejects invalid limits before audit', async () => {
    const cappedAdapter = new RecordingAdapter();
    const cappedRecorder = new RecordingRecorder();
    await gateway(cappedAdapter, cappedRecorder).call(request(900));
    expect(cappedAdapter.requests[0]?.maxOutputTokens).toBe(512);
    expect(cappedRecorder.events[0]?.effectiveMaxOutputTokens).toBe(512);

    const invalidAdapter = new RecordingAdapter();
    const invalidRecorder = new RecordingRecorder();
    await expect(gateway(invalidAdapter, invalidRecorder).call(request(0))).rejects.toMatchObject({
      code: 'INVALID_AI_CONFIGURATION',
    });
    expect(invalidAdapter.requests).toHaveLength(0);
    expect(invalidRecorder.events).toHaveLength(0);
  });

  it('returns a safe aiRunId only after durable STARTED and terminal FAILED evidence', async () => {
    const adapter = new RecordingAdapter();
    adapter.failure = new AiError('AI_TIMEOUT', 'Controlled timeout.', { retryable: true });
    const recorder = new RecordingRecorder();

    await expect(gateway(adapter, recorder).call(request())).rejects.toMatchObject({
      code: 'AI_TIMEOUT',
      details: { aiRunId },
    });
    expect(recorder.events.map(({ status }) => status)).toEqual(['STARTED', 'FAILED']);
  });

  it('exposes the durable STARTED ID on later audit failure but never on STARTED-write failure', async () => {
    const failedTerminalAdapter = new RecordingAdapter();
    failedTerminalAdapter.failure = new AiError('AI_TIMEOUT', 'Controlled timeout.', {
      retryable: true,
    });
    const failedTerminalRecorder = new RecordingRecorder();
    failedTerminalRecorder.failStatus = 'FAILED';
    await expect(
      gateway(failedTerminalAdapter, failedTerminalRecorder).call(request()),
    ).rejects.toMatchObject({
      code: 'AI_AUDIT_FAILED',
      details: { aiRunId, originalErrorCode: 'AI_TIMEOUT' },
    });

    const failedStartedAdapter = new RecordingAdapter();
    const failedStartedRecorder = new RecordingRecorder();
    failedStartedRecorder.failStatus = 'STARTED';
    const failure = gateway(failedStartedAdapter, failedStartedRecorder).call(request());
    await expect(failure).rejects.toMatchObject({
      code: 'AI_AUDIT_FAILED',
      details: { stage: 'STARTED' },
    });
    await expect(failure).rejects.not.toMatchObject({ details: { aiRunId } });
    expect(failedStartedAdapter.requests).toHaveLength(0);
  });
});
