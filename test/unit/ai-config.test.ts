import { describe, expect, it } from 'vitest';
import {
  AI_CONFIG_DEFAULTS,
  getSafeAiConfigSummary,
  loadAiConfig,
  resolveMaxOutputTokens,
} from '../../srv/ai/config.js';
import { AiProvider } from '../../srv/ai/contracts.js';

describe('AI configuration', () => {
  it('loads safe defaults without credentials', () => {
    const config = loadAiConfig({});

    expect(config).toEqual({
      enabled: false,
      liveSmokeEnabled: false,
      decideProvider: AiProvider.OPENAI,
      generateProvider: AiProvider.ANTHROPIC,
      openai: {
        model: 'gpt-5.6-luna',
        reasoningEffort: 'none',
      },
      anthropic: {
        model: 'claude-sonnet-5',
        effort: 'low',
      },
      timeoutMs: 30_000,
      maxRetries: 1,
      maxOutputTokens: 128,
    });
    expect(AI_CONFIG_DEFAULTS.enabled).toBe(false);
  });

  it('accepts explicit, valid overrides', () => {
    const config = loadAiConfig({
      AI_ENABLED: 'true',
      AI_LIVE_SMOKE_ENABLED: 'true',
      AI_DECIDE_PROVIDER: 'anthropic',
      AI_GENERATE_PROVIDER: 'openai',
      OPENAI_DECIDE_MODEL: 'gpt-test',
      OPENAI_REASONING_EFFORT: 'high',
      ANTHROPIC_GENERATE_MODEL: 'claude-test',
      ANTHROPIC_EFFORT: 'medium',
      AI_TIMEOUT_MS: '45000',
      AI_MAX_RETRIES: '2',
      AI_MAX_OUTPUT_TOKENS: '512',
      OPENAI_API_KEY: 'openai-test-credential',
      ANTHROPIC_API_KEY: 'anthropic-test-credential',
    });

    expect(config).toMatchObject({
      enabled: true,
      liveSmokeEnabled: true,
      decideProvider: AiProvider.ANTHROPIC,
      generateProvider: AiProvider.OPENAI,
      openai: {
        model: 'gpt-test',
        reasoningEffort: 'high',
        apiKey: 'openai-test-credential',
      },
      anthropic: {
        model: 'claude-test',
        effort: 'medium',
        apiKey: 'anthropic-test-credential',
      },
      timeoutMs: 45_000,
      maxRetries: 2,
      maxOutputTokens: 512,
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
    ['AI_TIMEOUT_MS', '3.5'],
    ['AI_MAX_RETRIES', '3'],
    ['AI_MAX_RETRIES', '-1'],
    ['AI_MAX_OUTPUT_TOKENS', '0'],
    ['AI_MAX_OUTPUT_TOKENS', '8193'],
    ['AI_MAX_OUTPUT_TOKENS', 'NaN'],
  ])('rejects invalid numeric configuration %s=%j', (field, value) => {
    expect(() => loadAiConfig({ [field]: value })).toThrowError(
      expect.objectContaining({ code: 'INVALID_AI_CONFIGURATION' }),
    );
  });

  it.each(['OPENAI_DECIDE_MODEL', 'ANTHROPIC_GENERATE_MODEL'])(
    'rejects an explicitly empty model in %s',
    (field) => {
      expect(() => loadAiConfig({ [field]: '   ' })).toThrowError(
        expect.objectContaining({ code: 'INVALID_AI_CONFIGURATION' }),
      );
    },
  );

  it.each(['AI_DECIDE_PROVIDER', 'AI_GENERATE_PROVIDER'])(
    'rejects an unsupported provider in %s',
    (field) => {
      expect(() => loadAiConfig({ [field]: 'other-provider' })).toThrowError(
        expect.objectContaining({ code: 'UNSUPPORTED_AI_PROVIDER' }),
      );
    },
  );

  it.each([
    ['OPENAI_REASONING_EFFORT', 'minimal'],
    ['ANTHROPIC_EFFORT', 'none'],
  ])('rejects unsupported effort %s=%j', (field, value) => {
    expect(() => loadAiConfig({ [field]: value })).toThrowError(
      expect.objectContaining({ code: 'INVALID_AI_CONFIGURATION' }),
    );
  });

  it('keeps application startup valid with AI disabled and both credentials absent', () => {
    const config = loadAiConfig({ AI_ENABLED: 'false' });
    const summary = getSafeAiConfigSummary(config);

    expect(summary).toEqual({
      liveSmokeEnabled: false,
      openAiModel: 'gpt-5.6-luna',
      anthropicModel: 'claude-sonnet-5',
      openAiCredentialConfigured: false,
      anthropicCredentialConfigured: false,
    });
    expect(JSON.stringify(summary)).not.toContain('apiKey');
  });

  it('caps request output tokens at configuration and rejects invalid overrides', () => {
    expect(resolveMaxOutputTokens(undefined, 128)).toBe(128);
    expect(resolveMaxOutputTokens(64, 128)).toBe(64);
    expect(resolveMaxOutputTokens(256, 128)).toBe(128);
    expect(() => resolveMaxOutputTokens(0, 128)).toThrowError(
      expect.objectContaining({ code: 'INVALID_AI_CONFIGURATION' }),
    );
  });
});
