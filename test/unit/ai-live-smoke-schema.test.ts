import { describe, expect, it, vi } from 'vitest';
import { loadAiConfig } from '../../srv/ai/config.js';
import { AiProvider, AiTaskType } from '../../srv/ai/contracts.js';
import type {
  AiCallResult,
  StructuredAiAdapter,
  StructuredAiRequest,
} from '../../srv/ai/contracts.js';
import { createCredentialCheckResult } from '../../srv/ai/credential-check.js';
import { AiError } from '../../srv/ai/errors.js';
import { runLiveSmoke, toSafeLiveSmokeResult } from '../../srv/ai/live-smoke.js';
import {
  LIVE_SMOKE_SCHEMA_VERSION,
  createLiveSmokeRequest,
  liveSmokeSchema,
} from '../../srv/ai/schemas/live-smoke-schema.js';
import { runCredentialCheckScript } from '../../scripts/ai-credentials-check.js';
import { runLiveSmokeScript, toSafeLiveSmokeFailure } from '../../scripts/ai-live-smoke.js';

describe('Phase 3A live smoke schema', () => {
  it('accepts only the exact literal structured output', () => {
    expect(liveSmokeSchema.parse({ ok: true, phase: '3a', check: 'structured-output' })).toEqual({
      ok: true,
      phase: '3a',
      check: 'structured-output',
    });
    expect(() =>
      liveSmokeSchema.parse({ ok: false, phase: '3a', check: 'structured-output' }),
    ).toThrow();
    expect(() =>
      liveSmokeSchema.parse({ ok: true, phase: '3b', check: 'structured-output' }),
    ).toThrow();
    expect(() =>
      liveSmokeSchema.parse({
        ok: true,
        phase: '3a',
        check: 'structured-output',
        extra: true,
      }),
    ).toThrow();
  });

  it('builds a minimal, provider-explicit request without personal or trip data', () => {
    const request = createLiveSmokeRequest(AiProvider.OPENAI);

    expect(request).toMatchObject({
      taskType: AiTaskType.SMOKE,
      provider: AiProvider.OPENAI,
      schemaVersion: LIVE_SMOKE_SCHEMA_VERSION,
      maxOutputTokens: 128,
      input: { ok: true, phase: '3a', check: 'structured-output' },
    });
    expect(JSON.stringify(request.input)).not.toMatch(/name|email|city|budget/i);
  });
});

describe('credential and live-smoke gates', () => {
  it('credential checker prints only presence flags, model names and opt-in state', () => {
    const openAiKey = 'sk-' + 'proj-' + 'abcdefghijklmnopqrstuvwxyz1234567890';
    const anthropicKey = 'sk-' + 'ant-' + 'abcdefghijklmnopqrstuvwxyz1234567890';
    const result = createCredentialCheckResult(
      loadAiConfig({
        AI_LIVE_SMOKE_ENABLED: 'true',
        OPENAI_API_KEY: openAiKey,
        ANTHROPIC_API_KEY: anthropicKey,
      }),
    );
    const output = result.lines.join('\n');

    expect(result.exitCode).toBe(0);
    expect(output).toContain('OPENAI_API_KEY: configured');
    expect(output).toContain('ANTHROPIC_API_KEY: configured');
    expect(output).toContain('OPENAI_DECIDE_MODEL: gpt-5.6-luna');
    expect(output).not.toContain(openAiKey);
    expect(output).not.toContain(anthropicKey);
    expect(output).not.toContain(String(openAiKey.length));
  });

  it('credential script fails safely without printing credentials', () => {
    const lines: string[] = [];
    const credential = 'sk-' + 'proj-' + 'abcdefghijklmnopqrstuvwxyz1234567890';
    const exitCode = runCredentialCheckScript({ OPENAI_API_KEY: credential }, (line) =>
      lines.push(line),
    );

    expect(exitCode).toBe(1);
    expect(lines.join('\n')).not.toContain(credential);
    expect(lines.join('\n')).toContain('ANTHROPIC_API_KEY: missing');
  });

  it('blocks live smoke without explicit opt-in before creating an adapter', async () => {
    const createOpenAiAdapter = vi.fn();

    await expect(
      runLiveSmoke(loadAiConfig({ OPENAI_API_KEY: 'test-openai-credential' }), AiProvider.OPENAI, {
        createOpenAiAdapter,
      }),
    ).rejects.toMatchObject({ code: 'LIVE_AI_NOT_ENABLED' });
    expect(createOpenAiAdapter).not.toHaveBeenCalled();
  });

  it('requires only the selected provider credential after opt-in', async () => {
    await expect(
      runLiveSmoke(
        loadAiConfig({ AI_LIVE_SMOKE_ENABLED: 'true', ANTHROPIC_API_KEY: 'anthropic-only' }),
        AiProvider.OPENAI,
      ),
    ).rejects.toMatchObject({
      code: 'MISSING_CREDENTIALS',
      details: { credentialEnvironmentVariable: 'OPENAI_API_KEY' },
    });
  });

  it('invokes exactly one selected adapter and returns safe metadata only', async () => {
    let calls = 0;
    const adapter: StructuredAiAdapter = {
      provider: AiProvider.OPENAI,
      model: 'gpt-test',
      async call<TOutput>(request: StructuredAiRequest<TOutput>): Promise<AiCallResult<TOutput>> {
        calls += 1;
        return {
          output: request.outputSchema.parse({
            ok: true,
            phase: '3a',
            check: 'structured-output',
          }),
          provider: AiProvider.OPENAI,
          model: 'gpt-test',
          taskType: request.taskType,
          promptVersion: request.promptVersion,
          schemaVersion: request.schemaVersion,
          inputFingerprint: 'fingerprint',
          usage: { inputTokens: 5, outputTokens: 4, totalTokens: 9 },
          latencyMs: 12,
          attempts: 1,
          refusal: { refused: false },
        };
      },
    };
    const result = await runLiveSmoke(
      loadAiConfig({ AI_LIVE_SMOKE_ENABLED: 'true', OPENAI_API_KEY: 'test-key' }),
      AiProvider.OPENAI,
      { createOpenAiAdapter: () => adapter },
    );
    const safe = toSafeLiveSmokeResult(result);

    expect(calls).toBe(1);
    expect(safe).toEqual({
      provider: AiProvider.OPENAI,
      model: 'gpt-test',
      status: 'ok',
      latencyMs: 12,
      usage: { inputTokens: 5, outputTokens: 4, totalTokens: 9 },
      schemaVersion: LIVE_SMOKE_SCHEMA_VERSION,
    });
    expect(safe).not.toHaveProperty('output');
    expect(safe).not.toHaveProperty('prompt');
  });

  it('live smoke script rejects a missing opt-in without a network call or secret output', async () => {
    const credential = 'sk-' + 'proj-' + 'abcdefghijklmnopqrstuvwxyz1234567890';
    const lines: string[] = [];
    const exitCode = await runLiveSmokeScript('openai', { OPENAI_API_KEY: credential }, (line) =>
      lines.push(line),
    );

    expect(exitCode).toBe(1);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('LIVE_AI_NOT_ENABLED');
    expect(lines[0]).not.toContain(credential);
  });

  it('reports safe actionable timeout and quota metadata without credentials', () => {
    const config = loadAiConfig({ AI_TIMEOUT_MS: '45000' });
    const timeout = toSafeLiveSmokeFailure(
      new AiError('AI_TIMEOUT', 'Timed out safely.'),
      config,
      AiProvider.OPENAI,
    );
    const quota = toSafeLiveSmokeFailure(
      new AiError('RATE_LIMITED', 'Rate limited safely.', {
        details: { quotaRelated: true },
      }),
      config,
      AiProvider.ANTHROPIC,
    );

    expect(timeout).toMatchObject({
      provider: AiProvider.OPENAI,
      model: 'gpt-5.6-luna',
      modelEnvironmentVariable: 'OPENAI_DECIDE_MODEL',
      credentialEnvironmentVariable: 'OPENAI_API_KEY',
      code: 'AI_TIMEOUT',
      timeoutMs: 45_000,
    });
    expect(quota).toMatchObject({
      provider: AiProvider.ANTHROPIC,
      modelEnvironmentVariable: 'ANTHROPIC_GENERATE_MODEL',
      credentialEnvironmentVariable: 'ANTHROPIC_API_KEY',
      code: 'RATE_LIMITED',
      quotaRelated: true,
    });
    expect(JSON.stringify({ timeout, quota })).not.toContain('apiKey');
  });
});
