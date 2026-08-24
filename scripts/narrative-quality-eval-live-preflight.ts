import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { loadAiConfig, type AiConfig } from '../srv/ai/config.ts';
import { canonicalizeJson } from '../srv/ai/contracts.ts';
import { EvalContractError } from '../srv/evals/dataset.ts';
import {
  buildNarrativeLiveEvalCostPreflight,
  type NarrativeLiveEvalCostPreflight,
} from '../srv/evals/live-preflight.ts';
import { loadAiPriceSnapshot, type AiPriceSnapshot } from '../srv/evals/price-snapshot.ts';

export const NARRATIVE_LIVE_COST_SCENARIO_IDS = [
  'SCENARIO_RUNTIME_LUNA',
  'SCENARIO_COMPARISON_TERRA',
] as const;

export type NarrativeLiveCostScenarioId = (typeof NARRATIVE_LIVE_COST_SCENARIO_IDS)[number];

const scenarioSchema = z.enum(NARRATIVE_LIVE_COST_SCENARIO_IDS);
const nonNegativeSafeInteger = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const positiveSafeInteger = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const usdDecimal = z.string().regex(/^\d+\.\d{6}$/u);
const profileSchema = z
  .object({
    provider: z.enum(['OPENAI', 'ANTHROPIC']),
    configuredModel: z.string().min(1),
    effort: z.enum(['none', 'low', 'medium', 'high', 'xhigh', 'max']),
    maxOutputTokens: positiveSafeInteger,
    minimumInputTokensPerAttempt: positiveSafeInteger,
    maximumInputTokensPerAttempt: positiveSafeInteger,
    maximumOutputTokensPerAttempt: positiveSafeInteger,
  })
  .strict();
const costTotalSchema = z
  .object({
    plannedCalls: nonNegativeSafeInteger,
    plannedMaximumCostUsdMicros: nonNegativeSafeInteger,
    plannedMaximumCostUsd: usdDecimal,
  })
  .strict();
const providerModelCostSchema = costTotalSchema
  .extend({
    provider: z.enum(['OPENAI', 'ANTHROPIC']),
    configuredModel: z.string().min(1),
  })
  .strict();

export const narrativeLiveCostPreflightOutputSchema = z
  .object({
    status: z.enum(['COST_PREFLIGHT_PASSED', 'COST_PREFLIGHT_BLOCKED']),
    scenarioId: scenarioSchema,
    planVersion: z.string().min(1),
    tokenCeilingVersion: z.string().min(1),
    costCeilingVersion: z.string().min(1),
    priceCatalogVersion: z.string().min(1),
    pricingVerifiedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
    workloadFingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
    syntheticOnly: z.literal(true),
    semanticCases: z.literal(32),
    precheckCases: z.literal(2),
    repeatedSentinels: z.literal(8),
    endToEndCases: z.literal(4),
    plannedLogicalCalls: z.literal(46),
    plannedGenerateCalls: z.literal(4),
    plannedJudgeCalls: z.literal(42),
    plannedMaximumAttempts: positiveSafeInteger,
    maxRetries: nonNegativeSafeInteger,
    profiles: z.object({ generate: profileSchema, judge: profileSchema }).strict(),
    plannedMaximumCostUsdMicros: nonNegativeSafeInteger,
    plannedMaximumCostUsd: usdDecimal,
    configuredCostCapUsdMicros: positiveSafeInteger,
    configuredCostCapUsd: usdDecimal,
    costCapHeadroomUsdMicros: nonNegativeSafeInteger,
    costCapHeadroomUsd: usdDecimal,
    withinLogicalCallCap: z.boolean(),
    withinProviderAttemptCap: z.boolean(),
    withinCostCap: z.boolean(),
    withinAllCaps: z.boolean(),
    costBreakdown: z
      .object({
        generate: costTotalSchema,
        judge: costTotalSchema,
        byProviderModel: z.array(providerModelCostSchema).min(1),
      })
      .strict(),
  })
  .strict();

export type NarrativeLiveCostPreflightOutput = z.infer<
  typeof narrativeLiveCostPreflightOutputSchema
>;

export interface NarrativeLiveCostPreflightScriptDependencies {
  readonly loadPriceSnapshot?: () => AiPriceSnapshot;
  readonly buildCostPreflight?: typeof buildNarrativeLiveEvalCostPreflight;
}

const COST_PREFLIGHT_PROFILE_ENV = Object.freeze({
  AI_MAX_RETRIES: '0',
  AI_GENERATE_PROVIDER: 'anthropic',
  AI_GENERATE_MODEL: 'claude-sonnet-5',
  AI_GENERATE_EFFORT: 'low',
  AI_GENERATE_MAX_OUTPUT_TOKENS: '1600',
  AI_JUDGE_PROVIDER: 'openai',
  AI_JUDGE_EFFORT: 'low',
  AI_JUDGE_MAX_OUTPUT_TOKENS: '2048',
});

export function createNarrativeLiveCostScenarioConfig(
  scenarioId: NarrativeLiveCostScenarioId,
): AiConfig {
  return loadAiConfig({
    ...COST_PREFLIGHT_PROFILE_ENV,
    AI_JUDGE_MODEL: scenarioId === 'SCENARIO_RUNTIME_LUNA' ? 'gpt-5.6-luna' : 'gpt-5.6-terra',
  });
}

function safeOutput(
  scenarioId: NarrativeLiveCostScenarioId,
  summary: NarrativeLiveEvalCostPreflight,
): NarrativeLiveCostPreflightOutput {
  return narrativeLiveCostPreflightOutputSchema.parse({
    status: summary.withinAllCaps ? 'COST_PREFLIGHT_PASSED' : 'COST_PREFLIGHT_BLOCKED',
    scenarioId,
    planVersion: summary.plan.planVersion,
    tokenCeilingVersion: summary.plan.tokenCeilingVersion,
    costCeilingVersion: summary.plan.costCeilingVersion,
    priceCatalogVersion: summary.priceCatalogVersion,
    pricingVerifiedAt: summary.pricingVerifiedAt,
    workloadFingerprint: summary.workloadFingerprint,
    syntheticOnly: summary.plan.syntheticOnly,
    semanticCases: summary.plan.semanticCases,
    precheckCases: summary.plan.precheckCases,
    repeatedSentinels: summary.plan.repeatedSentinels,
    endToEndCases: summary.plan.endToEndCases,
    plannedLogicalCalls: summary.plan.plannedLogicalCalls,
    plannedGenerateCalls: summary.plannedGenerateCalls,
    plannedJudgeCalls: summary.plannedJudgeCalls,
    plannedMaximumAttempts: summary.plan.plannedMaximumAttempts,
    maxRetries: summary.maxRetries,
    profiles: summary.profiles,
    plannedMaximumCostUsdMicros: summary.plannedMaximumCostUsdMicros,
    plannedMaximumCostUsd: summary.plannedMaximumCostUsd,
    configuredCostCapUsdMicros: summary.configuredCostCapUsdMicros,
    configuredCostCapUsd: summary.configuredCostCapUsd,
    costCapHeadroomUsdMicros: summary.costCapHeadroomUsdMicros,
    costCapHeadroomUsd: summary.costCapHeadroomUsd,
    withinLogicalCallCap: summary.withinLogicalCallCap,
    withinProviderAttemptCap: summary.withinProviderAttemptCap,
    withinCostCap: summary.withinCostCap,
    withinAllCaps: summary.withinAllCaps,
    costBreakdown: summary.costBreakdown,
  });
}

export function runNarrativeQualityLiveCostPreflightScript(
  writeLine: (line: string) => void,
  dependencies: NarrativeLiveCostPreflightScriptDependencies = {},
): 0 | 1 {
  try {
    const priceSnapshot = (dependencies.loadPriceSnapshot ?? loadAiPriceSnapshot)();
    const build = dependencies.buildCostPreflight ?? buildNarrativeLiveEvalCostPreflight;
    const outputs = NARRATIVE_LIVE_COST_SCENARIO_IDS.map((scenarioId) =>
      safeOutput(
        scenarioId,
        build({ config: createNarrativeLiveCostScenarioConfig(scenarioId), priceSnapshot }),
      ),
    );
    for (const output of outputs) writeLine(canonicalizeJson(output));
    return 0;
  } catch (error) {
    writeLine(
      canonicalizeJson({
        status: 'COST_PREFLIGHT_FAILED',
        code: error instanceof EvalContractError ? error.code : 'COST_PREFLIGHT_FAILED',
      }),
    );
    return 1;
  }
}

function isMainModule(): boolean {
  const mainPath = process.argv[1];
  return mainPath !== undefined && import.meta.url === pathToFileURL(mainPath).href;
}

if (isMainModule()) {
  process.exitCode = runNarrativeQualityLiveCostPreflightScript((line) => console.log(line));
}
