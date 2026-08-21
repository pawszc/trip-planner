import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadAiConfig } from '../../srv/ai/config.ts';
import { canonicalizeJson } from '../../srv/ai/contracts.ts';
import { buildNarrativeLiveEvalCostPreflight } from '../../srv/evals/live-preflight.ts';
import {
  loadAiPriceSnapshot,
  parseAiPriceSnapshot,
  type AiPriceSnapshot,
} from '../../srv/evals/price-snapshot.ts';
import {
  createNarrativeLiveCostScenarioConfig,
  narrativeLiveCostPreflightOutputSchema,
  runNarrativeQualityLiveCostPreflightScript,
  type NarrativeLiveCostPreflightOutput,
} from '../../scripts/narrative-quality-eval-live-preflight.ts';

const workspacePath = fileURLToPath(new URL('../..', import.meta.url));
const tsxSandboxUserShimPath = fileURLToPath(
  new URL('../fixtures/tsx-sandbox-user-shim.cjs', import.meta.url),
);
const fakeSecrets = Object.freeze({
  openai: 'preflight-canary-openai-not-a-real-key',
  anthropic: 'preflight-canary-anthropic-not-a-real-key',
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function parseOutputs(lines: readonly string[]): NarrativeLiveCostPreflightOutput[] {
  return lines.map((line) => narrativeLiveCostPreflightOutputSchema.parse(JSON.parse(line)));
}

function collectKeys(value: unknown, keys = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, keys);
  } else if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      keys.add(key);
      collectKeys(child, keys);
    }
  }
  return keys;
}

function collectRelativeModuleGraph(entryPaths: readonly string[]): ReadonlyMap<string, string> {
  const pending = entryPaths.map((entryPath) => resolve(workspacePath, entryPath));
  const sources = new Map<string, string>();
  const relativeModuleSpecifier =
    /(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\sfrom\s+)?['"](\.[^'"]+)['"]\s*;/gu;

  while (pending.length > 0) {
    const filePath = pending.pop()!;
    const workspaceRelativePath = relative(workspacePath, filePath);
    if (sources.has(workspaceRelativePath)) continue;
    const source = readFileSync(filePath, 'utf8');
    sources.set(workspaceRelativePath, source);
    for (const match of source.matchAll(relativeModuleSpecifier)) {
      const specifier = match[1]!;
      if (specifier.endsWith('.ts')) pending.push(resolve(dirname(filePath), specifier));
    }
  }

  return sources;
}

describe('credential-free narrative live cost preflight', () => {
  it('emits two exact canonical privacy-safe scenarios without fetch even when opt-ins and keys exist', () => {
    vi.stubEnv('AI_ENABLED', 'true');
    vi.stubEnv('AI_LIVE_EVAL_ENABLED', 'true');
    vi.stubEnv('OPENAI_API_KEY', fakeSecrets.openai);
    vi.stubEnv('ANTHROPIC_API_KEY', fakeSecrets.anthropic);
    const fetchSpy = vi.fn(() => {
      throw new Error('The pure cost preflight must never call fetch.');
    });
    vi.stubGlobal('fetch', fetchSpy);
    const lines: string[] = [];

    expect(runNarrativeQualityLiveCostPreflightScript((line) => lines.push(line))).toBe(0);
    expect(lines).toHaveLength(2);
    expect(lines.every((line) => line === canonicalizeJson(JSON.parse(line)))).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();

    const outputs = parseOutputs(lines);
    const terra = outputs.find(({ scenarioId }) => scenarioId === 'SCENARIO_CURRENT_TERRA')!;
    const luna = outputs.find(({ scenarioId }) => scenarioId === 'SCENARIO_COST_FALLBACK_LUNA')!;
    expect(terra).toMatchObject({
      status: 'COST_PREFLIGHT_BLOCKED',
      pricingVerifiedAt: '2026-08-21',
      plannedLogicalCalls: 46,
      plannedGenerateCalls: 4,
      plannedJudgeCalls: 42,
      plannedMaximumAttempts: 46,
      maxRetries: 0,
      plannedMaximumCostUsdMicros: 6_950_969,
      plannedMaximumCostUsd: '6.950969',
      configuredCostCapUsdMicros: 3_000_000,
      configuredCostCapUsd: '3.000000',
      withinLogicalCallCap: true,
      withinProviderAttemptCap: true,
      withinCostCap: false,
      withinAllCaps: false,
      costBreakdown: {
        generate: {
          plannedCalls: 4,
          plannedMaximumCostUsdMicros: 401_101,
          plannedMaximumCostUsd: '0.401101',
        },
        judge: {
          plannedCalls: 42,
          plannedMaximumCostUsdMicros: 6_549_868,
          plannedMaximumCostUsd: '6.549868',
        },
        byProviderModel: [
          {
            provider: 'OPENAI',
            configuredModel: 'gpt-5.6-terra',
            plannedCalls: 42,
            plannedMaximumCostUsdMicros: 6_549_868,
            plannedMaximumCostUsd: '6.549868',
          },
          {
            provider: 'ANTHROPIC',
            configuredModel: 'claude-sonnet-5',
            plannedCalls: 4,
            plannedMaximumCostUsdMicros: 401_101,
            plannedMaximumCostUsd: '0.401101',
          },
        ],
      },
    });
    expect(luna).toMatchObject({
      status: 'COST_PREFLIGHT_PASSED',
      plannedLogicalCalls: 46,
      plannedGenerateCalls: 4,
      plannedJudgeCalls: 42,
      plannedMaximumAttempts: 46,
      maxRetries: 0,
      plannedMaximumCostUsdMicros: 1_056_177,
      plannedMaximumCostUsd: '1.056177',
      configuredCostCapUsdMicros: 3_000_000,
      configuredCostCapUsd: '3.000000',
      withinLogicalCallCap: true,
      withinProviderAttemptCap: true,
      withinCostCap: true,
      withinAllCaps: true,
      costBreakdown: {
        generate: {
          plannedCalls: 4,
          plannedMaximumCostUsdMicros: 401_101,
          plannedMaximumCostUsd: '0.401101',
        },
        judge: {
          plannedCalls: 42,
          plannedMaximumCostUsdMicros: 655_076,
          plannedMaximumCostUsd: '0.655076',
        },
        byProviderModel: [
          {
            provider: 'OPENAI',
            configuredModel: 'gpt-5.6-luna',
            plannedCalls: 42,
            plannedMaximumCostUsdMicros: 655_076,
            plannedMaximumCostUsd: '0.655076',
          },
          {
            provider: 'ANTHROPIC',
            configuredModel: 'claude-sonnet-5',
            plannedCalls: 4,
            plannedMaximumCostUsdMicros: 401_101,
            plannedMaximumCostUsd: '0.401101',
          },
        ],
      },
    });
    expect(terra.profiles.generate).toEqual({
      provider: 'ANTHROPIC',
      configuredModel: 'claude-sonnet-5',
      effort: 'low',
      maxOutputTokens: 1_600,
      minimumInputTokensPerAttempt: 14_125,
      maximumInputTokensPerAttempt: 14_674,
      maximumOutputTokensPerAttempt: 1_600,
    });
    expect(terra.profiles.judge).toEqual({
      provider: 'OPENAI',
      configuredModel: 'gpt-5.6-terra',
      effort: 'low',
      maxOutputTokens: 768,
      minimumInputTokensPerAttempt: 24_176,
      maximumInputTokensPerAttempt: 72_619,
      maximumOutputTokensPerAttempt: 768,
    });
    expect(luna.profiles.judge).toEqual({
      ...terra.profiles.judge,
      configuredModel: 'gpt-5.6-luna',
    });
    expect(terra.workloadFingerprint).toBe(luna.workloadFingerprint);

    const forbiddenKeys = new Set([
      'apiKey',
      'prompt',
      'instructions',
      'input',
      'schema',
      'context',
      'candidate',
      'factReferences',
      'sourceUrl',
      'externalItemId',
      'output',
      'rawError',
      'cause',
      'stack',
    ]);
    for (const output of outputs) {
      expect([...collectKeys(output)].filter((key) => forbiddenKeys.has(key))).toEqual([]);
    }
    expect(lines.join('\n')).not.toContain(fakeSecrets.openai);
    expect(lines.join('\n')).not.toContain(fakeSecrets.anthropic);
  });

  it('uses identical requests, contracts, token ceilings and call order except for JUDGE model', () => {
    const priceSnapshot = loadAiPriceSnapshot();
    const terra = buildNarrativeLiveEvalCostPreflight({
      config: createNarrativeLiveCostScenarioConfig('SCENARIO_CURRENT_TERRA'),
      priceSnapshot,
    });
    const luna = buildNarrativeLiveEvalCostPreflight({
      config: createNarrativeLiveCostScenarioConfig('SCENARIO_COST_FALLBACK_LUNA'),
      priceSnapshot,
    });
    const normalizeJudgeModel = (summary: typeof terra) =>
      summary.plan.calls.map((call) => ({
        ...call,
        configuredModel:
          call.taskType === 'JUDGE' ? '<SCENARIO_JUDGE_MODEL>' : call.configuredModel,
      }));

    expect(normalizeJudgeModel(terra)).toEqual(normalizeJudgeModel(luna));
    expect(terra.workloadFingerprint).toBe(luna.workloadFingerprint);
    expect(terra.profiles.generate).toEqual(luna.profiles.generate);
    expect({ ...terra.profiles.judge, configuredModel: '<SCENARIO_JUDGE_MODEL>' }).toEqual({
      ...luna.profiles.judge,
      configuredModel: '<SCENARIO_JUDGE_MODEL>',
    });
    expect(terra.plan.calls.filter(({ taskType }) => taskType === 'JUDGE')).toHaveLength(42);
    expect(
      terra.plan.calls
        .filter(({ taskType }) => taskType === 'JUDGE')
        .every(({ configuredModel }) => configuredModel === 'gpt-5.6-terra'),
    ).toBe(true);
    expect(
      luna.plan.calls
        .filter(({ taskType }) => taskType === 'JUDGE')
        .every(({ configuredModel }) => configuredModel === 'gpt-5.6-luna'),
    ).toBe(true);
  });

  it('fails closed for an unknown scenario model before emitting partial scenario output', () => {
    const fullSnapshot = loadAiPriceSnapshot();
    const snapshotWithoutLuna: AiPriceSnapshot = {
      ...fullSnapshot,
      models: fullSnapshot.models.filter(({ model }) => model !== 'gpt-5.6-luna'),
    };
    const lines: string[] = [];

    expect(
      runNarrativeQualityLiveCostPreflightScript((line) => lines.push(line), {
        loadPriceSnapshot: () => snapshotWithoutLuna,
      }),
    ).toBe(1);
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      { code: 'LIVE_EVAL_BLOCKED', status: 'COST_PREFLIGHT_FAILED' },
    ]);
  });

  it('rejects a legacy v1 snapshot without a verification date before fetch or partial output', () => {
    const legacyInput: Record<string, unknown> = { ...loadAiPriceSnapshot() };
    delete legacyInput.pricingVerifiedAt;
    const legacySnapshot = parseAiPriceSnapshot(legacyInput);
    const fetchSpy = vi.fn(() => {
      throw new Error('Missing price verification must block before fetch.');
    });
    vi.stubGlobal('fetch', fetchSpy);
    const lines: string[] = [];

    expect(
      runNarrativeQualityLiveCostPreflightScript((line) => lines.push(line), {
        loadPriceSnapshot: () => legacySnapshot,
      }),
    ).toBe(1);
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      { code: 'LIVE_EVAL_BLOCKED', status: 'COST_PREFLIGHT_FAILED' },
    ]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('redacts raw thrown errors from the failure output', () => {
    const rawErrorSentinel =
      'RAW_ERROR_SECRET_PROMPT_CANDIDATE_FACT_REFERENCE_SOURCE_URL_EXTERNAL_ID';
    const lines: string[] = [];

    expect(
      runNarrativeQualityLiveCostPreflightScript((line) => lines.push(line), {
        buildCostPreflight: () => {
          throw new Error(rawErrorSentinel);
        },
      }),
    ).toBe(1);
    expect(lines).toEqual([
      canonicalizeJson({ code: 'COST_PREFLIGHT_FAILED', status: 'COST_PREFLIGHT_FAILED' }),
    ]);
    expect(lines.join('\n')).not.toContain(rawErrorSentinel);
  });

  it('keeps the complete pure module graph free of live executors, adapters, gateways and audit stores', () => {
    const sources = collectRelativeModuleGraph([
      'scripts/narrative-quality-eval-live-preflight.ts',
    ]);
    const modulePaths = [...sources.keys()].join('\n');
    const sourceText = [...sources.values()].join('\n');
    const forbiddenRuntimeModule =
      /scripts[\\/]narrative-quality-eval-live\.ts|srv[\\/]evals[\\/]live-runner\.ts|srv[\\/]ai[\\/]create-persistent-ai-gateway\.ts|srv[\\/]ai[\\/]adapters[\\/]|srv[\\/]ai[\\/]persistence[\\/]cap-ai-run-store\.ts/u;
    const forbiddenRuntimeConstruction =
      /runNarrativeQualityLiveEvaluation|createPersistentAiGateway|new\s+OpenAiResponsesAdapter|new\s+AnthropicMessagesAdapter|new\s+CapAiRunStore|createNarrativeLiveEvalAuditStore|@sap\/cds|node:fs\/promises|fetch\s*\(/u;

    expect(modulePaths).not.toMatch(forbiddenRuntimeModule);
    expect(sourceText).not.toMatch(forbiddenRuntimeConstruction);
  });

  it('runs the actual npm command with credentials and AI opt-ins removed', () => {
    const npmCli = process.env.npm_execpath;
    expect(npmCli).toBeTruthy();
    const removed = new Set([
      'OPENAI_API_KEY',
      'ANTHROPIC_API_KEY',
      'AI_ENABLED',
      'AI_LIVE_EVAL_ENABLED',
    ]);
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && !removed.has(key.toUpperCase())) env[key] = value;
    }
    env.NODE_OPTIONS = [env.NODE_OPTIONS, `--require=${JSON.stringify(tsxSandboxUserShimPath)}`]
      .filter(Boolean)
      .join(' ');
    const result = spawnSync(
      process.execPath,
      [npmCli!, 'run', '--silent', 'eval:live:preflight'],
      { cwd: workspacePath, env, encoding: 'utf8', timeout: 60_000 },
    );

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const lines = result.stdout.trim().split(/\r?\n/u);
    expect(parseOutputs(lines)).toHaveLength(2);
  });

  it('does not change the runtime JUDGE default or enable AI', () => {
    const config = loadAiConfig({});
    expect(config.enabled).toBe(false);
    expect(config.taskProfiles.JUDGE).toMatchObject({
      provider: 'OPENAI',
      model: 'gpt-5.6-terra',
      effort: 'low',
      maxOutputTokens: 768,
    });
  });
});
