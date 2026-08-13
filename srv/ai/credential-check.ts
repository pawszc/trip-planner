import type { AiConfig } from './config.ts';
import { getSafeAiConfigSummary } from './config.ts';
import { AiTaskType } from './contracts.ts';

export interface CredentialCheckResult {
  exitCode: 0 | 1;
  lines: readonly string[];
}

/** Produces only presence flags and non-secret model configuration. */
export function createCredentialCheckResult(config: AiConfig): CredentialCheckResult {
  const summary = getSafeAiConfigSummary(config);
  const ready =
    summary.openAiCredentialConfigured &&
    summary.anthropicCredentialConfigured &&
    summary.liveSmokeEnabled;
  const lines = [
    `OPENAI_API_KEY: ${summary.openAiCredentialConfigured ? 'configured' : 'missing'}`,
    `ANTHROPIC_API_KEY: ${summary.anthropicCredentialConfigured ? 'configured' : 'missing'}`,
    ...([AiTaskType.DECIDE, AiTaskType.GENERATE, AiTaskType.JUDGE] as const).map((taskType) => {
      const profile = summary.taskProfiles[taskType];
      return `AI_${taskType}_PROFILE: provider=${profile.provider} model=${profile.model} effort=${profile.effort} maxOutputTokens=${profile.maxOutputTokens}`;
    }),
    `AI_LIVE_SMOKE_ENABLED: ${String(summary.liveSmokeEnabled)}`,
    `AI_RUN_RETENTION_DAYS: ${summary.runRetentionDays}`,
    ready
      ? 'Credential check passed. Live smoke tests may be run explicitly.'
      : 'Credential check failed. Configure both credentials locally and explicitly enable live smoke tests.',
  ];
  return { exitCode: ready ? 0 : 1, lines };
}
