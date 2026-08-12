import { pathToFileURL } from 'node:url';
import { loadAiConfig } from '../srv/ai/config.ts';
import type { AiConfig } from '../srv/ai/config.ts';
import { AiProvider } from '../srv/ai/contracts.ts';
import type { AiErrorCode } from '../srv/ai/errors.ts';
import { AiError } from '../srv/ai/errors.ts';
import { runLiveSmoke, toSafeLiveSmokeResult } from '../srv/ai/live-smoke.ts';

function parseProvider(value: string | undefined): AiProvider {
  if (value === 'openai') {
    return AiProvider.OPENAI;
  }
  if (value === 'anthropic') {
    return AiProvider.ANTHROPIC;
  }
  throw new AiError('UNSUPPORTED_AI_PROVIDER', 'Select openai or anthropic for live smoke.');
}

function modelSettings(
  config: ReturnType<typeof loadAiConfig>,
  provider: AiProvider,
): {
  model: string;
  modelEnvironmentVariable: string;
  credentialEnvironmentVariable: string;
} {
  return provider === AiProvider.OPENAI
    ? {
        model: config.openai.model,
        modelEnvironmentVariable: 'OPENAI_DECIDE_MODEL',
        credentialEnvironmentVariable: 'OPENAI_API_KEY',
      }
    : {
        model: config.anthropic.model,
        modelEnvironmentVariable: 'ANTHROPIC_GENERATE_MODEL',
        credentialEnvironmentVariable: 'ANTHROPIC_API_KEY',
      };
}

function safeNextStep(error: AiError, settings: ReturnType<typeof modelSettings>): string {
  switch (error.code) {
    case 'AUTHENTICATION_FAILED':
    case 'MISSING_CREDENTIALS':
      return `Verify ${settings.credentialEnvironmentVariable} locally without displaying it.`;
    case 'MODEL_ACCESS_DENIED':
      return `Set ${settings.modelEnvironmentVariable} in the local .env to a model available on this account.`;
    case 'RATE_LIMITED':
      return error.details.quotaRelated === true
        ? 'Check provider quota or billing before another manual attempt.'
        : 'Wait for the provider rate limit window before another manual attempt.';
    case 'AI_TIMEOUT':
      return 'Review AI_TIMEOUT_MS before another manual attempt.';
    case 'INVALID_STRUCTURED_OUTPUT':
      return 'Review the adapter and structured output contract; do not print the raw response.';
    default:
      return 'Stop without an automatic retry and review the safe error code.';
  }
}

export interface SafeLiveSmokeFailure {
  provider: AiProvider;
  model: string;
  modelEnvironmentVariable: string;
  credentialEnvironmentVariable: string;
  code: AiErrorCode;
  nextStep: string;
  timeoutMs?: number;
  quotaRelated?: boolean;
}

export function toSafeLiveSmokeFailure(
  error: AiError,
  config: AiConfig,
  provider: AiProvider,
): SafeLiveSmokeFailure {
  const settings = modelSettings(config, provider);
  return {
    provider,
    model: settings.model,
    modelEnvironmentVariable: settings.modelEnvironmentVariable,
    credentialEnvironmentVariable: settings.credentialEnvironmentVariable,
    code: error.code,
    nextStep: safeNextStep(error, settings),
    ...(error.code === 'AI_TIMEOUT' ? { timeoutMs: config.timeoutMs } : {}),
    ...(error.code === 'RATE_LIMITED' ? { quotaRelated: error.details.quotaRelated === true } : {}),
  };
}

export async function runLiveSmokeScript(
  providerValue: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
  writeLine: (line: string) => void,
): Promise<0 | 1> {
  let provider: AiProvider;
  try {
    provider = parseProvider(providerValue);
  } catch (error) {
    const code = error instanceof AiError ? error.code : 'UNSUPPORTED_AI_PROVIDER';
    writeLine(JSON.stringify({ code, nextStep: 'Run with exactly openai or anthropic.' }));
    return 1;
  }

  try {
    const config = loadAiConfig(env);
    const result = await runLiveSmoke(config, provider);
    writeLine(JSON.stringify(toSafeLiveSmokeResult(result)));
    return 0;
  } catch (error) {
    const config = (() => {
      try {
        return loadAiConfig(env);
      } catch {
        return undefined;
      }
    })();
    if (!(error instanceof AiError) || config === undefined) {
      writeLine(
        JSON.stringify({
          provider,
          code: 'INVALID_AI_CONFIGURATION',
          nextStep: 'Review non-secret AI configuration without displaying .env.',
        }),
      );
      return 1;
    }
    writeLine(JSON.stringify(toSafeLiveSmokeFailure(error, config, provider)));
    return 1;
  }
}

function isMainModule(): boolean {
  const mainPath = process.argv[1];
  return mainPath !== undefined && import.meta.url === pathToFileURL(mainPath).href;
}

if (isMainModule()) {
  process.exitCode = await runLiveSmokeScript(process.argv[2], process.env, (line) =>
    console.log(line),
  );
}
