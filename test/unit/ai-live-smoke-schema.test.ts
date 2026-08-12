import { describe, expect, it, vi } from 'vitest';
import { loadAiConfig } from '../../srv/ai/config.js';
import { AiProvider, AiTaskType, createInputFingerprint } from '../../srv/ai/contracts.js';
import type {
  AiCallResult,
  AiExecutionProfile,
  StructuredAiAdapter,
  StructuredAiRequest,
} from '../../srv/ai/contracts.js';
import { createCredentialCheckResult } from '../../srv/ai/credential-check.js';
import { AiError } from '../../srv/ai/errors.js';
import {
  resolveLiveSmokeProfile,
  runLiveSmoke,
  toSafeLiveSmokeResult,
} from '../../srv/ai/live-smoke.js';
import {
  LIVE_SMOKE_SCHEMA_VERSION,
  createLiveSmokeRequest,
  liveSmokeSchema,
} from '../../srv/ai/schemas/live-smoke-schema.js';
import { runCredentialCheckScript } from '../../scripts/ai-credentials-check.js';
import { runLiveSmokeScript, toSafeLiveSmokeFailure } from '../../scripts/ai-live-smoke.js';

describe('Phase 3B1 live smoke schema', () => {
  it('accepts only the exact literal structured output', () => {
    expect(liveSmokeSchema.parse({ ok: true, phase: '3b1', check: 'structured-output' })).toEqual({
      ok: true,
      phase: '3b1',
      check: 'structured-output',
    });
    expect(() =>
      liveSmokeSchema.parse({ ok: false, phase: '3b1', check: 'structured-output' }),
    ).toThrow();
    expect(() =>
      liveSmokeSchema.parse({ ok: true, phase: '3a', check: 'structured-output' }),
    ).toThrow();
    expect(() =>
      liveSmokeSchema.parse({
        ok: true,
        phase: '3b1',
        check: 'structured-output',
        extra: true,
      }),
    ).toThrow();
  });

  it('builds a minimal request without product provider override or trip data', () => {
    const request = createLiveSmokeRequest();

    expect(request).toMatchObject({
      taskType: AiTaskType.SMOKE,
      schemaVersion: LIVE_SMOKE_SCHEMA_VERSION,
      maxOutputTokens: 128,
      input: { ok: true, phase: '3b1', check: 'structured-output' },
    });
    expect(request).not.toHaveProperty('provider');
    expect(JSON.stringify(request.input)).not.toMatch(/name|email|city|budget/i);
  });
});

describe('deterministic operator smoke profiles', () => {
  it('selects the first OpenAI task in DECIDE, GENERATE, JUDGE order', () => {
    const config = loadAiConfig({});

    expect(resolveLiveSmokeProfile(config, AiProvider.OPENAI)).toEqual({
      ...config.taskProfiles.DECIDE,
      taskType: AiTaskType.SMOKE,
      maxOutputTokens: 128,
    });
  });

  it('selects the first Anthropic task and preserves its model and effort', () => {
    const config = loadAiConfig({
      AI_DECIDE_PROVIDER: 'anthropic',
      AI_DECIDE_MODEL: 'claude-decide-first',
      AI_DECIDE_EFFORT: 'high',
    });

    expect(resolveLiveSmokeProfile(config, AiProvider.ANTHROPIC)).toMatchObject({
      taskType: AiTaskType.SMOKE,
      provider: AiProvider.ANTHROPIC,
      model: 'claude-decide-first',
      effort: 'high',
      maxOutputTokens: 128,
    });
  });

  it('rejects a provider unused by every task without inventing a model', () => {
    const config = loadAiConfig({
      AI_GENERATE_PROVIDER: 'openai',
      AI_GENERATE_MODEL: 'gpt-generate',
      AI_GENERATE_EFFORT: 'low',
    });

    expect(() => resolveLiveSmokeProfile(config, AiProvider.ANTHROPIC)).toThrowError(
      expect.objectContaining({ code: 'INVALID_AI_CONFIGURATION' }),
    );
  });

  it('caps smoke at 128 while preserving a lower task limit', () => {
    const config = loadAiConfig({ AI_DECIDE_MAX_OUTPUT_TOKENS: '64' });

    expect(resolveLiveSmokeProfile(config, AiProvider.OPENAI).maxOutputTokens).toBe(64);
    expect(resolveLiveSmokeProfile(loadAiConfig({}), AiProvider.OPENAI).maxOutputTokens).toBe(128);
  });
});

describe('credential and live-smoke gates', () => {
  it('credential checker prints only presence flags, all profiles, opt-in and retention', () => {
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
    expect(output).toContain(
      'AI_DECIDE_PROFILE: provider=OPENAI model=gpt-5.6-luna effort=none maxOutputTokens=512',
    );
    expect(output).toContain(
      'AI_GENERATE_PROFILE: provider=ANTHROPIC model=claude-sonnet-5 effort=low maxOutputTokens=1600',
    );
    expect(output).toContain(
      'AI_JUDGE_PROFILE: provider=OPENAI model=gpt-5.6-terra effort=low maxOutputTokens=768',
    );
    expect(output).toContain('AI_RUN_RETENTION_DAYS: 30');
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

  it('invokes exactly one selected adapter with the resolved profile and safe result metadata', async () => {
    let calls = 0;
    let capturedProfile: AiExecutionProfile | undefined;
    const adapter: StructuredAiAdapter = {
      provider: AiProvider.OPENAI,
      async call<TOutput>(
        request: StructuredAiRequest<TOutput>,
        profile: AiExecutionProfile,
      ): Promise<AiCallResult<TOutput>> {
        calls += 1;
        capturedProfile = profile;
        return {
          aiRunId: request.aiRunId ?? 'missing',
          output: request.outputSchema.parse({
            ok: true,
            phase: '3b1',
            check: 'structured-output',
          }),
          provider: AiProvider.OPENAI,
          configuredModel: profile.model,
          responseModel: `${profile.model}-snapshot`,
          taskType: request.taskType,
          promptVersion: request.promptVersion,
          schemaVersion: request.schemaVersion,
          inputFingerprint: createInputFingerprint(request.input),
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
      {
        createOpenAiAdapter: () => adapter,
        generateAiRunId: () => '00000000-0000-4000-8000-000000000010',
      },
    );
    const safe = toSafeLiveSmokeResult(result);

    expect(calls).toBe(1);
    expect(capturedProfile).toMatchObject({
      taskType: AiTaskType.SMOKE,
      provider: AiProvider.OPENAI,
      model: 'gpt-5.6-luna',
      effort: 'none',
      maxOutputTokens: 128,
    });
    expect(safe).toEqual({
      provider: AiProvider.OPENAI,
      configuredModel: 'gpt-5.6-luna',
      responseModel: 'gpt-5.6-luna-snapshot',
      status: 'ok',
      latencyMs: 12,
      usage: { inputTokens: 5, outputTokens: 4, totalTokens: 9 },
      schemaVersion: LIVE_SMOKE_SCHEMA_VERSION,
    });
    expect(safe).not.toHaveProperty('output');
    expect(safe).not.toHaveProperty('prompt');
  });

  it('live smoke script rejects missing opt-in without a network call or secret output', async () => {
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

  it('live smoke script reports an unused provider without an unhandled settings error', async () => {
    const lines: string[] = [];
    const exitCode = await runLiveSmokeScript(
      'anthropic',
      {
        AI_LIVE_SMOKE_ENABLED: 'true',
        AI_GENERATE_PROVIDER: 'openai',
        AI_GENERATE_MODEL: 'gpt-generate',
        AI_GENERATE_EFFORT: 'low',
      },
      (line) => lines.push(line),
    );

    expect(exitCode).toBe(1);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      provider: AiProvider.ANTHROPIC,
      code: 'INVALID_AI_CONFIGURATION',
    });
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
      configuredModel: 'gpt-5.6-luna',
      modelEnvironmentVariable: 'AI_DECIDE_MODEL',
      credentialEnvironmentVariable: 'OPENAI_API_KEY',
      code: 'AI_TIMEOUT',
      timeoutMs: 45_000,
    });
    expect(quota).toMatchObject({
      provider: AiProvider.ANTHROPIC,
      configuredModel: 'claude-sonnet-5',
      modelEnvironmentVariable: 'AI_GENERATE_MODEL',
      credentialEnvironmentVariable: 'ANTHROPIC_API_KEY',
      code: 'RATE_LIMITED',
      quotaRelated: true,
    });
    expect(JSON.stringify({ timeout, quota })).not.toContain('apiKey');
  });
});
