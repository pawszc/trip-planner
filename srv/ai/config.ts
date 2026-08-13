import {
  AiProvider,
  AiTaskType,
  type AiEffort,
  type AiExecutionProfile,
  type ProfiledAiTaskType,
} from './contracts.ts';
import { AiError } from './errors.ts';

export const AI_CONFIG_DEFAULTS = Object.freeze({
  enabled: false,
  liveSmokeEnabled: false,
  taskProfiles: Object.freeze({
    [AiTaskType.DECIDE]: Object.freeze({
      taskType: AiTaskType.DECIDE,
      provider: AiProvider.OPENAI,
      model: 'gpt-5.6-luna',
      effort: 'none' as const,
      maxOutputTokens: 512,
    }),
    [AiTaskType.GENERATE]: Object.freeze({
      taskType: AiTaskType.GENERATE,
      provider: AiProvider.ANTHROPIC,
      model: 'claude-sonnet-5',
      effort: 'low' as const,
      maxOutputTokens: 1_600,
    }),
    [AiTaskType.JUDGE]: Object.freeze({
      taskType: AiTaskType.JUDGE,
      provider: AiProvider.OPENAI,
      model: 'gpt-5.6-terra',
      effort: 'low' as const,
      maxOutputTokens: 768,
    }),
  }),
  timeoutMs: 30_000,
  maxRetries: 1,
  runRetentionDays: 30,
});

export type OpenAiReasoningEffort = AiEffort;
export type AnthropicEffort = Exclude<AiEffort, 'none'>;

export interface AiProviderConfig {
  apiKey?: string;
}

export type AiTaskProfiles = Readonly<Record<ProfiledAiTaskType, AiExecutionProfile>>;

export interface AiConfig {
  enabled: boolean;
  liveSmokeEnabled: boolean;
  taskProfiles: AiTaskProfiles;
  providers: Readonly<Record<AiProvider, AiProviderConfig>>;
  timeoutMs: number;
  maxRetries: number;
  runRetentionDays: number;
}

export interface SafeAiConfigSummary {
  liveSmokeEnabled: boolean;
  taskProfiles: AiTaskProfiles;
  runRetentionDays: number;
  openAiCredentialConfigured: boolean;
  anthropicCredentialConfigured: boolean;
}

type AiEnv = Readonly<Record<string, string | undefined>>;

const ALL_EFFORTS = new Set<AiEffort>(['none', 'low', 'medium', 'high', 'xhigh', 'max']);
const ANTHROPIC_EFFORTS = new Set<AiEffort>(['low', 'medium', 'high', 'xhigh', 'max']);

function invalidConfiguration(field: string, message: string): never {
  throw new AiError('INVALID_AI_CONFIGURATION', message, { details: { field } });
}

function parseBoolean(value: string | undefined, fallback: boolean, field: string): boolean {
  if (value === undefined) return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return invalidConfiguration(field, `${field} must be exactly true or false.`);
}

function parseProvider(value: string | undefined, fallback: AiProvider, field: string): AiProvider {
  if (value === undefined) return fallback;
  if (value === 'openai') return AiProvider.OPENAI;
  if (value === 'anthropic') return AiProvider.ANTHROPIC;
  return invalidConfiguration(field, `${field} selects an unsupported AI provider.`);
}

function parseModel(value: string | undefined, fallback: string, field: string): string {
  if (value === undefined) return fallback;
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
  if (value === undefined) return fallback;
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

function parseEffort(
  value: string | undefined,
  fallback: AiEffort,
  provider: AiProvider,
  field: string,
): AiEffort {
  const effort = value ?? fallback;
  if (!ALL_EFFORTS.has(effort as AiEffort)) {
    return invalidConfiguration(field, `${field} has an unsupported value.`);
  }
  if (provider === AiProvider.ANTHROPIC && !ANTHROPIC_EFFORTS.has(effort as AiEffort)) {
    return invalidConfiguration(field, `${field} cannot be none for Anthropic.`);
  }
  return effort as AiEffort;
}

function optionalCredential(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

interface SelectedEnvironmentValue {
  value: string | undefined;
  field: string;
}

function selectEnvironmentValue(
  value: string | undefined,
  field: string,
  legacyValue?: string,
  legacyField?: string,
): SelectedEnvironmentValue {
  if (value !== undefined) return { value, field };
  if (legacyValue !== undefined && legacyField !== undefined) {
    return { value: legacyValue, field: legacyField };
  }
  return { value: undefined, field };
}

function createTaskProfile(
  env: AiEnv,
  taskType: ProfiledAiTaskType,
  defaults: AiExecutionProfile,
): AiExecutionProfile {
  const prefix = `AI_${taskType}`;
  const providerField = `${prefix}_PROVIDER`;
  const modelField = `${prefix}_MODEL`;
  const provider = parseProvider(env[providerField], defaults.provider, providerField);

  // A provider switch is a deliberate routing change. Reusing the old provider's
  // default (or one of its legacy aliases) would create an invalid provider/model pair.
  if (env[providerField] !== undefined && provider !== defaults.provider) {
    const explicitlyConfiguredModel = env[modelField];
    if (explicitlyConfiguredModel === undefined || explicitlyConfiguredModel.trim().length === 0) {
      invalidConfiguration(
        modelField,
        `${modelField} must be explicitly configured when ${providerField} changes provider.`,
      );
    }
  }

  const modelSelection =
    taskType === AiTaskType.DECIDE && provider === AiProvider.OPENAI
      ? selectEnvironmentValue(
          env.AI_DECIDE_MODEL,
          'AI_DECIDE_MODEL',
          env.OPENAI_DECIDE_MODEL,
          'OPENAI_DECIDE_MODEL',
        )
      : taskType === AiTaskType.GENERATE && provider === AiProvider.ANTHROPIC
        ? selectEnvironmentValue(
            env.AI_GENERATE_MODEL,
            'AI_GENERATE_MODEL',
            env.ANTHROPIC_GENERATE_MODEL,
            'ANTHROPIC_GENERATE_MODEL',
          )
        : selectEnvironmentValue(env[modelField], modelField);

  const effortSelection =
    taskType === AiTaskType.DECIDE && provider === AiProvider.OPENAI
      ? selectEnvironmentValue(
          env.AI_DECIDE_EFFORT,
          'AI_DECIDE_EFFORT',
          env.OPENAI_REASONING_EFFORT,
          'OPENAI_REASONING_EFFORT',
        )
      : taskType === AiTaskType.GENERATE && provider === AiProvider.ANTHROPIC
        ? selectEnvironmentValue(
            env.AI_GENERATE_EFFORT,
            'AI_GENERATE_EFFORT',
            env.ANTHROPIC_EFFORT,
            'ANTHROPIC_EFFORT',
          )
        : selectEnvironmentValue(env[`${prefix}_EFFORT`], `${prefix}_EFFORT`);

  return {
    taskType,
    provider,
    model: parseModel(modelSelection.value, defaults.model, modelSelection.field),
    effort: parseEffort(effortSelection.value, defaults.effort, provider, effortSelection.field),
    maxOutputTokens: parseInteger(
      env[`${prefix}_MAX_OUTPUT_TOKENS`],
      defaults.maxOutputTokens,
      `${prefix}_MAX_OUTPUT_TOKENS`,
      1,
      8_192,
    ),
  };
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
    taskProfiles: {
      [AiTaskType.DECIDE]: createTaskProfile(
        env,
        AiTaskType.DECIDE,
        AI_CONFIG_DEFAULTS.taskProfiles[AiTaskType.DECIDE],
      ),
      [AiTaskType.GENERATE]: createTaskProfile(
        env,
        AiTaskType.GENERATE,
        AI_CONFIG_DEFAULTS.taskProfiles[AiTaskType.GENERATE],
      ),
      [AiTaskType.JUDGE]: createTaskProfile(
        env,
        AiTaskType.JUDGE,
        AI_CONFIG_DEFAULTS.taskProfiles[AiTaskType.JUDGE],
      ),
    },
    providers: {
      [AiProvider.OPENAI]: openAiApiKey === undefined ? {} : { apiKey: openAiApiKey },
      [AiProvider.ANTHROPIC]: anthropicApiKey === undefined ? {} : { apiKey: anthropicApiKey },
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
    runRetentionDays: parseInteger(
      env.AI_RUN_RETENTION_DAYS,
      AI_CONFIG_DEFAULTS.runRetentionDays,
      'AI_RUN_RETENTION_DAYS',
      1,
      365,
    ),
  };
}

export function getSafeAiConfigSummary(config: AiConfig): SafeAiConfigSummary {
  return {
    liveSmokeEnabled: config.liveSmokeEnabled,
    taskProfiles: config.taskProfiles,
    runRetentionDays: config.runRetentionDays,
    openAiCredentialConfigured: config.providers[AiProvider.OPENAI].apiKey !== undefined,
    anthropicCredentialConfigured: config.providers[AiProvider.ANTHROPIC].apiKey !== undefined,
  };
}

export function resolveMaxOutputTokens(requested: number | undefined, configured: number): number {
  if (requested === undefined) return configured;
  if (!Number.isSafeInteger(requested) || requested <= 0) {
    return invalidConfiguration(
      'maxOutputTokens',
      'A request maxOutputTokens override must be a positive safe integer.',
    );
  }
  return Math.min(requested, configured);
}

export function validateAiExecutionProfile(profile: AiExecutionProfile): void {
  if (!Object.values(AiProvider).includes(profile.provider)) {
    invalidConfiguration('profile.provider', 'The AI execution profile provider is unsupported.');
  }
  if (profile.model.trim().length === 0) {
    invalidConfiguration('profile.model', 'The AI execution profile model must not be empty.');
  }
  parseEffort(profile.effort, profile.effort, profile.provider, 'profile.effort');
  if (
    !Number.isSafeInteger(profile.maxOutputTokens) ||
    profile.maxOutputTokens < 1 ||
    profile.maxOutputTokens > 8_192
  ) {
    invalidConfiguration(
      'profile.maxOutputTokens',
      'The AI execution profile maxOutputTokens must be a safe integer between 1 and 8192.',
    );
  }
}

export function isProfiledAiTaskType(taskType: AiTaskType): taskType is ProfiledAiTaskType {
  return taskType !== AiTaskType.SMOKE;
}
