import { AnthropicMessagesAdapter } from './adapters/anthropic-messages-adapter.ts';
import { OpenAiResponsesAdapter } from './adapters/openai-responses-adapter.ts';
import type { AiConfig } from './config.ts';
import { AiProvider } from './contracts.ts';
import type { AiCallResult, AiUsage, StructuredAiAdapter } from './contracts.ts';
import { AiError, createMissingCredentialsError } from './errors.ts';
import { LIVE_SMOKE_SCHEMA_VERSION, createLiveSmokeRequest } from './schemas/live-smoke-schema.ts';
import type { LiveSmokeOutput } from './schemas/live-smoke-schema.ts';

export interface LiveSmokeDependencies {
  createOpenAiAdapter?: (config: AiConfig) => StructuredAiAdapter;
  createAnthropicAdapter?: (config: AiConfig) => StructuredAiAdapter;
}

export interface SafeLiveSmokeResult {
  provider: AiProvider;
  model: string;
  status: 'ok';
  latencyMs: number;
  usage: AiUsage;
  schemaVersion: string;
  providerRequestId?: string;
}

function providerConfig(
  config: AiConfig,
  provider: AiProvider,
): {
  model: string;
  apiKey: string | undefined;
  credentialEnvironmentVariable: string;
} {
  if (provider === AiProvider.OPENAI) {
    return {
      model: config.openai.model,
      apiKey: config.openai.apiKey,
      credentialEnvironmentVariable: 'OPENAI_API_KEY',
    };
  }
  return {
    model: config.anthropic.model,
    apiKey: config.anthropic.apiKey,
    credentialEnvironmentVariable: 'ANTHROPIC_API_KEY',
  };
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
  const selected = providerConfig(config, provider);
  if (!config.liveSmokeEnabled) {
    throw new AiError('LIVE_AI_NOT_ENABLED', 'Live AI smoke tests require explicit opt-in.', {
      provider,
      model: selected.model,
      details: { field: 'AI_LIVE_SMOKE_ENABLED' },
    });
  }
  if (selected.apiKey === undefined) {
    throw createMissingCredentialsError(
      provider,
      selected.model,
      selected.credentialEnvironmentVariable,
    );
  }

  const adapter = createAdapter(config, provider, dependencies);
  return adapter.call(createLiveSmokeRequest(provider));
}

export function toSafeLiveSmokeResult(result: AiCallResult<LiveSmokeOutput>): SafeLiveSmokeResult {
  return {
    provider: result.provider,
    model: result.model,
    status: 'ok',
    latencyMs: result.latencyMs,
    usage: result.usage,
    schemaVersion: LIVE_SMOKE_SCHEMA_VERSION,
    ...(result.providerRequestId === undefined
      ? {}
      : { providerRequestId: result.providerRequestId }),
  };
}
