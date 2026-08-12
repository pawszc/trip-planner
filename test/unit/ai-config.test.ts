import { describe, expect, it } from 'vitest';
import {
  AI_CONFIG_DEFAULTS,
  getSafeAiConfigSummary,
  loadAiConfig,
  resolveMaxOutputTokens,
} from '../../srv/ai/config.js';
import { AiProvider, AiTaskType } from '../../srv/ai/contracts.js';

describe('task-aware AI configuration', () => {
  it('loads safe defaults for DECIDE, GENERATE and JUDGE without credentials', () => {
    const config = loadAiConfig({});

    expect(config).toEqual({
      enabled: false,
      liveSmokeEnabled: false,
      taskProfiles: {
        DECIDE: {
          taskType: AiTaskType.DECIDE,
          provider: AiProvider.OPENAI,
          model: 'gpt-5.6-luna',
          effort: 'none',
          maxOutputTokens: 512,
        },
        GENERATE: {
          taskType: AiTaskType.GENERATE,
          provider: AiProvider.ANTHROPIC,
          model: 'claude-sonnet-5',
          effort: 'low',
          maxOutputTokens: 1_600,
        },
        JUDGE: {
          taskType: AiTaskType.JUDGE,
          provider: AiProvider.OPENAI,
          model: 'gpt-5.6-terra',
          effort: 'low',
          maxOutputTokens: 768,
        },
      },
      providers: { OPENAI: {}, ANTHROPIC: {} },
      timeoutMs: 30_000,
      maxRetries: 1,
      runRetentionDays: 30,
    });
    expect(AI_CONFIG_DEFAULTS.enabled).toBe(false);
  });

  it('accepts complete task-specific overrides', () => {
    const config = loadAiConfig({
      AI_ENABLED: 'true',
      AI_LIVE_SMOKE_ENABLED: 'true',
      AI_DECIDE_PROVIDER: 'anthropic',
      AI_DECIDE_MODEL: 'claude-decide',
      AI_DECIDE_EFFORT: 'high',
      AI_DECIDE_MAX_OUTPUT_TOKENS: '101',
      AI_GENERATE_PROVIDER: 'openai',
      AI_GENERATE_MODEL: 'gpt-generate',
      AI_GENERATE_EFFORT: 'max',
      AI_GENERATE_MAX_OUTPUT_TOKENS: '202',
      AI_JUDGE_PROVIDER: 'anthropic',
      AI_JUDGE_MODEL: 'claude-judge',
      AI_JUDGE_EFFORT: 'xhigh',
      AI_JUDGE_MAX_OUTPUT_TOKENS: '303',
      AI_TIMEOUT_MS: '45000',
      AI_MAX_RETRIES: '2',
      AI_RUN_RETENTION_DAYS: '90',
      OPENAI_API_KEY: 'openai-test-credential',
      ANTHROPIC_API_KEY: 'anthropic-test-credential',
    });

    expect(config).toMatchObject({
      enabled: true,
      liveSmokeEnabled: true,
      taskProfiles: {
        DECIDE: {
          provider: AiProvider.ANTHROPIC,
          model: 'claude-decide',
          effort: 'high',
          maxOutputTokens: 101,
        },
        GENERATE: {
          provider: AiProvider.OPENAI,
          model: 'gpt-generate',
          effort: 'max',
          maxOutputTokens: 202,
        },
        JUDGE: {
          provider: AiProvider.ANTHROPIC,
          model: 'claude-judge',
          effort: 'xhigh',
          maxOutputTokens: 303,
        },
      },
      providers: {
        OPENAI: { apiKey: 'openai-test-credential' },
        ANTHROPIC: { apiKey: 'anthropic-test-credential' },
      },
      timeoutMs: 45_000,
      maxRetries: 2,
      runRetentionDays: 90,
    });
  });

  it.each([
    ['AI_ENABLED', 'TRUE'],
    ['AI_ENABLED', '1'],
    ['AI_LIVE_SMOKE_ENABLED', ''],
    ['AI_LIVE_SMOKE_ENABLED', 'yes'],
  ])('rejects invalid boolean %s=%j', (field, value) => {
    expect(() => loadAiConfig({ [field]: value })).toThrowError(
      expect.objectContaining({ code: 'INVALID_AI_CONFIGURATION' }),
    );
  });

  it.each([
    ['AI_TIMEOUT_MS', '999'],
    ['AI_TIMEOUT_MS', '120001'],
    ['AI_MAX_RETRIES', '3'],
    ['AI_DECIDE_MAX_OUTPUT_TOKENS', '0'],
    ['AI_GENERATE_MAX_OUTPUT_TOKENS', '8193'],
    ['AI_JUDGE_MAX_OUTPUT_TOKENS', 'NaN'],
    ['AI_RUN_RETENTION_DAYS', '0'],
    ['AI_RUN_RETENTION_DAYS', '366'],
    ['AI_RUN_RETENTION_DAYS', '3.5'],
  ])('rejects invalid numeric configuration %s=%j', (field, value) => {
    expect(() => loadAiConfig({ [field]: value })).toThrowError(
      expect.objectContaining({ code: 'INVALID_AI_CONFIGURATION' }),
    );
  });

  it.each(['AI_DECIDE_PROVIDER', 'AI_GENERATE_PROVIDER', 'AI_JUDGE_PROVIDER'])(
    'rejects an unsupported provider in %s as invalid configuration',
    (field) => {
      expect(() => loadAiConfig({ [field]: 'other-provider' })).toThrowError(
        expect.objectContaining({ code: 'INVALID_AI_CONFIGURATION' }),
      );
    },
  );

  it.each(['AI_DECIDE_MODEL', 'AI_GENERATE_MODEL', 'AI_JUDGE_MODEL'])(
    'rejects an explicitly empty model in %s',
    (field) => {
      expect(() => loadAiConfig({ [field]: '   ' })).toThrowError(
        expect.objectContaining({ code: 'INVALID_AI_CONFIGURATION' }),
      );
    },
  );

  it.each([
    ['AI_DECIDE_EFFORT', 'minimal'],
    ['AI_GENERATE_EFFORT', 'extreme'],
    ['AI_JUDGE_EFFORT', ''],
  ])('rejects unsupported effort %s=%j', (field, value) => {
    expect(() => loadAiConfig({ [field]: value })).toThrowError(
      expect.objectContaining({ code: 'INVALID_AI_CONFIGURATION' }),
    );
  });

  it.each([
    ['AI_DECIDE_PROVIDER', 'AI_DECIDE_EFFORT'],
    ['AI_GENERATE_PROVIDER', 'AI_GENERATE_EFFORT'],
    ['AI_JUDGE_PROVIDER', 'AI_JUDGE_EFFORT'],
  ])('rejects none effort for an Anthropic profile', (providerField, effortField) => {
    expect(() =>
      loadAiConfig({ [providerField]: 'anthropic', [effortField]: 'none' }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_AI_CONFIGURATION' }));
  });

  it('uses new DECIDE and GENERATE variables before deprecated aliases', () => {
    const config = loadAiConfig({
      AI_DECIDE_MODEL: 'new-decide',
      OPENAI_DECIDE_MODEL: 'legacy-decide',
      AI_DECIDE_EFFORT: 'high',
      OPENAI_REASONING_EFFORT: 'low',
      AI_GENERATE_MODEL: 'new-generate',
      ANTHROPIC_GENERATE_MODEL: 'legacy-generate',
      AI_GENERATE_EFFORT: 'max',
      ANTHROPIC_EFFORT: 'medium',
    });

    expect(config.taskProfiles.DECIDE).toMatchObject({ model: 'new-decide', effort: 'high' });
    expect(config.taskProfiles.GENERATE).toMatchObject({ model: 'new-generate', effort: 'max' });
  });

  it('accepts deprecated aliases only for their matching providers', () => {
    const matching = loadAiConfig({
      OPENAI_DECIDE_MODEL: 'legacy-openai',
      OPENAI_REASONING_EFFORT: 'high',
      ANTHROPIC_GENERATE_MODEL: 'legacy-anthropic',
      ANTHROPIC_EFFORT: 'medium',
    });
    expect(matching.taskProfiles.DECIDE).toMatchObject({
      model: 'legacy-openai',
      effort: 'high',
    });
    expect(matching.taskProfiles.GENERATE).toMatchObject({
      model: 'legacy-anthropic',
      effort: 'medium',
    });

    const mismatched = loadAiConfig({
      AI_DECIDE_PROVIDER: 'anthropic',
      AI_DECIDE_EFFORT: 'low',
      OPENAI_DECIDE_MODEL: 'must-be-ignored',
      AI_GENERATE_PROVIDER: 'openai',
      ANTHROPIC_GENERATE_MODEL: 'must-also-be-ignored',
      ANTHROPIC_EFFORT: 'max',
    });
    expect(mismatched.taskProfiles.DECIDE.model).toBe('gpt-5.6-luna');
    expect(mismatched.taskProfiles.GENERATE).toMatchObject({
      model: 'claude-sonnet-5',
      effort: 'low',
    });
  });

  it('does not use the removed global token limit as a profile fallback', () => {
    const config = loadAiConfig({ AI_MAX_OUTPUT_TOKENS: '1' });

    expect(config.taskProfiles.DECIDE.maxOutputTokens).toBe(512);
    expect(config.taskProfiles.GENERATE.maxOutputTokens).toBe(1_600);
    expect(config.taskProfiles.JUDGE.maxOutputTokens).toBe(768);
  });

  it('produces a credential-safe summary with all profiles and retention', () => {
    const secret = 'sk-' + 'proj-' + 'abcdefghijklmnopqrstuvwxyz1234567890';
    const summary = getSafeAiConfigSummary(loadAiConfig({ OPENAI_API_KEY: secret }));
    const serialized = JSON.stringify(summary);

    expect(summary).toMatchObject({
      liveSmokeEnabled: false,
      runRetentionDays: 30,
      openAiCredentialConfigured: true,
      anthropicCredentialConfigured: false,
    });
    expect(Object.keys(summary.taskProfiles)).toEqual(['DECIDE', 'GENERATE', 'JUDGE']);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain('apiKey');
  });

  it('allows a request to lower but never raise the task profile limit', () => {
    expect(resolveMaxOutputTokens(undefined, 512)).toBe(512);
    expect(resolveMaxOutputTokens(64, 512)).toBe(64);
    expect(resolveMaxOutputTokens(1_000, 512)).toBe(512);
    expect(() => resolveMaxOutputTokens(0, 512)).toThrowError(
      expect.objectContaining({ code: 'INVALID_AI_CONFIGURATION' }),
    );
  });
});
