import { randomUUID } from 'node:crypto';
import { AnthropicMessagesAdapter } from './adapters/anthropic-messages-adapter.ts';
import { OpenAiResponsesAdapter } from './adapters/openai-responses-adapter.ts';
import type { AiConfig } from './config.ts';
import { AiProvider, AiTaskType } from './contracts.ts';
import type {
  AiCallResult,
  AiExecutionProfile,
  AiUsage,
  ProfiledAiTaskType,
  StructuredAiAdapter,
} from './contracts.ts';
import { AiError, createMissingCredentialsError } from './errors.ts';
import { LIVE_SMOKE_SCHEMA_VERSION, createLiveSmokeRequest } from './schemas/live-smoke-schema.ts';
import type { LiveSmokeOutput } from './schemas/live-smoke-schema.ts';

const SMOKE_PROFILE_ORDER: readonly ProfiledAiTaskType[] = [
  AiTaskType.DECIDE,
  AiTaskType.GENERATE,
  AiTaskType.JUDGE,
];

export interface LiveSmokeDependencies {
  createOpenAiAdapter?: (config: AiConfig) => StructuredAiAdapter;
  createAnthropicAdapter?: (config: AiConfig) => StructuredAiAdapter;
  generateAiRunId?: () => string;
}

export interface SafeLiveSmokeResult {
  provider: AiProvider;
  configuredModel: string;
  responseModel: string;
  status: 'ok';
  latencyMs: number;
  usage: AiUsage;
  schemaVersion: string;
  providerRequestId?: string;
}

function findSmokeSourceProfile(
  config: AiConfig,
  provider: AiProvider,
): AiExecutionProfile | undefined {
  for (const taskType of SMOKE_PROFILE_ORDER) {
    const profile = config.taskProfiles[taskType];
    if (profile.provider === provider) return profile;
  }
  return undefined;
}

/** Deterministically derives a tool-free smoke profile from configured product task profiles. */
export function resolveLiveSmokeProfile(
  config: AiConfig,
  provider: AiProvider,
): AiExecutionProfile {
  const source = findSmokeSourceProfile(config, provider);
  if (source === undefined) {
    throw new AiError(
      'INVALID_AI_CONFIGURATION',
      'No configured task profile uses the selected live-smoke provider.',
      { provider, details: { field: 'taskProfiles' } },
    );
  }
  return {
    ...source,
    taskType: AiTaskType.SMOKE,
    maxOutputTokens: Math.min(128, source.maxOutputTokens),
  };
}

export function resolveLiveSmokeSourceTaskType(
  config: AiConfig,
  provider: AiProvider,
): ProfiledAiTaskType {
  const source = findSmokeSourceProfile(config, provider);
  if (source === undefined || source.taskType === AiTaskType.SMOKE) {
    throw new AiError(
      'INVALID_AI_CONFIGURATION',
      'No configured task profile uses the selected live-smoke provider.',
      { provider, details: { field: 'taskProfiles' } },
    );
  }
  return source.taskType;
}

function createAdapter(
  config: AiConfig,
  provider: AiProvider,
  dependencies: LiveSmokeDependencies,
): StructuredAiAdapter {
  if (provider === AiProvider.OPENAI) {
    return dependencies.createOpenAiAdapter?.(config) ?? new OpenAiResponsesAdapter(config);
  }
  return dependencies.createAnthropicAdapter?.(config) ?? new AnthropicMessagesAdapter(config);
}

export async function runLiveSmoke(
  config: AiConfig,
  provider: AiProvider,
  dependencies: LiveSmokeDependencies = {},
): Promise<AiCallResult<LiveSmokeOutput>> {
  const profile = resolveLiveSmokeProfile(config, provider);
  if (!config.liveSmokeEnabled) {
    throw new AiError('LIVE_AI_NOT_ENABLED', 'Live AI smoke tests require explicit opt-in.', {
      provider,
      model: profile.model,
      details: { field: 'AI_LIVE_SMOKE_ENABLED' },
    });
  }

  const apiKey = config.providers[provider].apiKey;
  if (apiKey === undefined) {
    throw createMissingCredentialsError(
      provider,
      profile.model,
      provider === AiProvider.OPENAI ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY',
    );
  }

  const adapter = createAdapter(config, provider, dependencies);
  const request = {
    ...createLiveSmokeRequest(),
    aiRunId: (dependencies.generateAiRunId ?? randomUUID)(),
  };
  return adapter.call(request, profile);
}

export function toSafeLiveSmokeResult(result: AiCallResult<LiveSmokeOutput>): SafeLiveSmokeResult {
  return {
    provider: result.provider,
    configuredModel: result.configuredModel,
    responseModel: result.responseModel,
    status: 'ok',
    latencyMs: result.latencyMs,
    usage: result.usage,
    schemaVersion: LIVE_SMOKE_SCHEMA_VERSION,
    ...(result.providerRequestId === undefined
      ? {}
      : { providerRequestId: result.providerRequestId }),
  };
}
