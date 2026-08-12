import { AiProvider } from './contracts.ts';
import { AiError } from './errors.ts';

export const AI_CONFIG_DEFAULTS = Object.freeze({
  enabled: false,
  liveSmokeEnabled: false,
  decideProvider: AiProvider.OPENAI,
  generateProvider: AiProvider.ANTHROPIC,
  openAiModel: 'gpt-5.6-luna',
  openAiReasoningEffort: 'none' as const,
  anthropicModel: 'claude-sonnet-5',
  anthropicEffort: 'low' as const,
  timeoutMs: 30_000,
  maxRetries: 1,
  maxOutputTokens: 128,
});

export type OpenAiReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type AnthropicEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface OpenAiConfig {
  model: string;
  reasoningEffort: OpenAiReasoningEffort;
  apiKey?: string;
}

export interface AnthropicConfig {
  model: string;
  effort: AnthropicEffort;
  apiKey?: string;
}

export interface AiConfig {
  enabled: boolean;
  liveSmokeEnabled: boolean;
  decideProvider: AiProvider;
  generateProvider: AiProvider;
  openai: OpenAiConfig;
  anthropic: AnthropicConfig;
  timeoutMs: number;
  maxRetries: number;
  maxOutputTokens: number;
}

export interface SafeAiConfigSummary {
  liveSmokeEnabled: boolean;
  openAiModel: string;
  anthropicModel: string;
  openAiCredentialConfigured: boolean;
  anthropicCredentialConfigured: boolean;
}

type AiEnv = Readonly<Record<string, string | undefined>>;

function invalidConfiguration(field: string, message: string): never {
  throw new AiError('INVALID_AI_CONFIGURATION', message, { details: { field } });
}

function parseBoolean(value: string | undefined, fallback: boolean, field: string): boolean {
  if (value === undefined) {
    return fallback;
  }
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  return invalidConfiguration(field, `${field} must be exactly true or false.`);
}

function parseProvider(value: string | undefined, fallback: AiProvider, field: string): AiProvider {
  if (value === undefined) {
    return fallback;
  }
  if (value === 'openai') {
    return AiProvider.OPENAI;
  }
  if (value === 'anthropic') {
    return AiProvider.ANTHROPIC;
  }
  throw new AiError('UNSUPPORTED_AI_PROVIDER', `${field} selects an unsupported AI provider.`, {
    details: { field },
  });
}

function parseModel(value: string | undefined, fallback: string, field: string): string {
  if (value === undefined) {
    return fallback;
  }
  const model = value.trim();
  if (model.length === 0) {
    return invalidConfiguration(field, `${field} must not be empty.`);
  }
  return model;
}

function parseInteger(
  value: string | undefined,
  fallback: number,
  field: string,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) {
    return fallback;
  }
  if (!/^\d+$/.test(value)) {
    return invalidConfiguration(field, `${field} must be an integer.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    return invalidConfiguration(
      field,
      `${field} must be a safe integer between ${minimum} and ${maximum}.`,
    );
  }
  return parsed;
}

function parseChoice<T extends string>(
  value: string | undefined,
  fallback: T,
  allowed: ReadonlySet<string>,
  field: string,
): T {
  if (value === undefined) {
    return fallback;
  }
  if (!allowed.has(value)) {
    return invalidConfiguration(field, `${field} has an unsupported value.`);
  }
  return value as T;
}

function optionalCredential(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

/** Pure configuration loader. It never reads process.env unless the caller passes it explicitly. */
export function loadAiConfig(env: AiEnv): AiConfig {
  const openAiApiKey = optionalCredential(env.OPENAI_API_KEY);
  const anthropicApiKey = optionalCredential(env.ANTHROPIC_API_KEY);

  return {
    enabled: parseBoolean(env.AI_ENABLED, AI_CONFIG_DEFAULTS.enabled, 'AI_ENABLED'),
    liveSmokeEnabled: parseBoolean(
      env.AI_LIVE_SMOKE_ENABLED,
      AI_CONFIG_DEFAULTS.liveSmokeEnabled,
      'AI_LIVE_SMOKE_ENABLED',
    ),
    decideProvider: parseProvider(
      env.AI_DECIDE_PROVIDER,
      AI_CONFIG_DEFAULTS.decideProvider,
      'AI_DECIDE_PROVIDER',
    ),
    generateProvider: parseProvider(
      env.AI_GENERATE_PROVIDER,
      AI_CONFIG_DEFAULTS.generateProvider,
      'AI_GENERATE_PROVIDER',
    ),
    openai: {
      model: parseModel(
        env.OPENAI_DECIDE_MODEL,
        AI_CONFIG_DEFAULTS.openAiModel,
        'OPENAI_DECIDE_MODEL',
      ),
      reasoningEffort: parseChoice<OpenAiReasoningEffort>(
        env.OPENAI_REASONING_EFFORT,
        AI_CONFIG_DEFAULTS.openAiReasoningEffort,
        new Set(['none', 'low', 'medium', 'high', 'xhigh', 'max']),
        'OPENAI_REASONING_EFFORT',
      ),
      ...(openAiApiKey === undefined ? {} : { apiKey: openAiApiKey }),
    },
    anthropic: {
      model: parseModel(
        env.ANTHROPIC_GENERATE_MODEL,
        AI_CONFIG_DEFAULTS.anthropicModel,
        'ANTHROPIC_GENERATE_MODEL',
      ),
      effort: parseChoice<AnthropicEffort>(
        env.ANTHROPIC_EFFORT,
        AI_CONFIG_DEFAULTS.anthropicEffort,
        new Set(['low', 'medium', 'high', 'xhigh', 'max']),
        'ANTHROPIC_EFFORT',
      ),
      ...(anthropicApiKey === undefined ? {} : { apiKey: anthropicApiKey }),
    },
    timeoutMs: parseInteger(
      env.AI_TIMEOUT_MS,
      AI_CONFIG_DEFAULTS.timeoutMs,
      'AI_TIMEOUT_MS',
      1_000,
      120_000,
    ),
    maxRetries: parseInteger(
      env.AI_MAX_RETRIES,
      AI_CONFIG_DEFAULTS.maxRetries,
      'AI_MAX_RETRIES',
      0,
      2,
    ),
    maxOutputTokens: parseInteger(
      env.AI_MAX_OUTPUT_TOKENS,
      AI_CONFIG_DEFAULTS.maxOutputTokens,
      'AI_MAX_OUTPUT_TOKENS',
      1,
      8_192,
    ),
  };
}

export function getSafeAiConfigSummary(config: AiConfig): SafeAiConfigSummary {
  return {
    liveSmokeEnabled: config.liveSmokeEnabled,
    openAiModel: config.openai.model,
    anthropicModel: config.anthropic.model,
    openAiCredentialConfigured: config.openai.apiKey !== undefined,
    anthropicCredentialConfigured: config.anthropic.apiKey !== undefined,
  };
}

export function resolveMaxOutputTokens(requested: number | undefined, configured: number): number {
  if (requested === undefined) {
    return configured;
  }
  if (!Number.isSafeInteger(requested) || requested <= 0) {
    return invalidConfiguration(
      'maxOutputTokens',
      'A request maxOutputTokens override must be a positive safe integer.',
    );
  }
  return Math.min(requested, configured);
}
