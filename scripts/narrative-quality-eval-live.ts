import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import cds from '@sap/cds';
import { loadAiConfig, type AiConfig } from '../srv/ai/config.ts';
import { createPersistentAiGateway } from '../srv/ai/create-persistent-ai-gateway.ts';
import {
  CapAiRunStore,
  type AiRunTransactionalDatabase,
} from '../srv/ai/persistence/cap-ai-run-store.ts';
import {
  runNarrativeQualityLiveEvaluation,
  toSafeNarrativeLiveEvalFailure,
  type NarrativeLiveEvalExecutor,
  type NarrativeLiveEvalPreflightSummary,
} from '../srv/evals/live-runner.ts';
import { loadAiPriceSnapshot, type AiPriceSnapshot } from '../srv/evals/price-snapshot.ts';

export interface NarrativeLiveEvalScriptDependencies {
  readonly loadPriceSnapshot?: () => AiPriceSnapshot;
  readonly createExecutor?: (config: AiConfig) => Promise<NarrativeLiveEvalExecutor>;
}

export interface NarrativeLiveEvalDatabase extends AiRunTransactionalDatabase {
  run(query: object): Promise<unknown>;
}

export interface NarrativeLiveEvalAuditStore {
  readonly database: NarrativeLiveEvalDatabase;
  readonly store: CapAiRunStore;
}

interface CdsDeploymentApi {
  deploy(model: string): {
    to(target: string, options: { readonly silent: boolean }): Promise<unknown>;
  };
}

function safePreflight(summary: NarrativeLiveEvalPreflightSummary) {
  return {
    status: 'PREFLIGHT_PASSED',
    planVersion: summary.plan.planVersion,
    tokenCeilingVersion: summary.plan.tokenCeilingVersion,
    costCeilingVersion: summary.plan.costCeilingVersion,
    retryPolicyVersion: summary.plan.retryPolicyVersion,
    syntheticOnly: summary.plan.syntheticOnly,
    plannedLogicalCalls: summary.plan.plannedLogicalCalls,
    plannedMaximumAttempts: summary.plan.plannedMaximumAttempts,
    plannedMaximumCostUsdMicros: summary.plannedMaximumCostUsdMicros,
    priceCatalogVersion: summary.priceCatalogVersion,
    limits: summary.limits,
    profiles: summary.plan.calls
      .filter(
        (call, index, calls) =>
          calls.findIndex(
            (candidate) =>
              candidate.taskType === call.taskType &&
              candidate.provider === call.provider &&
              candidate.configuredModel === call.configuredModel,
          ) === index,
      )
      .map(
        ({ taskType, provider, configuredModel, configuredEffort, configuredMaxOutputTokens }) => ({
          taskType,
          provider,
          configuredModel,
          configuredEffort,
          configuredMaxOutputTokens,
        }),
      ),
  };
}

/** Deploys an isolated safe-metadata store only after every live preflight check has passed. */
export async function createNarrativeLiveEvalAuditStore(
  databaseUrl?: string,
): Promise<NarrativeLiveEvalAuditStore> {
  let target = databaseUrl;
  if (target === undefined) {
    const directory = fileURLToPath(new URL('../.tools/narrative-live-eval/', import.meta.url));
    await mkdir(directory, { recursive: true });
    const databasePath = join(directory, `ai-runs-${randomUUID()}.sqlite`).replace(/\\/gu, '/');
    target = `sqlite:${databasePath}`;
  }
  const deployment = (cds as unknown as CdsDeploymentApi).deploy('*');
  const database = (await deployment.to(target, { silent: true })) as NarrativeLiveEvalDatabase;
  return {
    database,
    store: new CapAiRunStore(
      () => database,
      () => false,
    ),
  };
}

async function createProductionExecutor(config: AiConfig): Promise<NarrativeLiveEvalExecutor> {
  // Preflight has already passed before this function is invoked. Each approved baseline gets an
  // isolated SQLite audit store containing safe AiRuns metadata only; no product rows are reused.
  const audit = await createNarrativeLiveEvalAuditStore();
  const gateway = createPersistentAiGateway(config, { store: audit.store });
  return {
    async call(descriptor) {
      return { result: await gateway.call(descriptor.request), auditSucceeded: true };
    },
  };
}

export async function runNarrativeQualityLiveEvalScript(
  env: Readonly<Record<string, string | undefined>>,
  writeLine: (line: string) => void,
  dependencies: NarrativeLiveEvalScriptDependencies = {},
): Promise<0 | 1> {
  try {
    const config = loadAiConfig(env);
    const priceSnapshot = (dependencies.loadPriceSnapshot ?? loadAiPriceSnapshot)();
    const result = await runNarrativeQualityLiveEvaluation({
      env,
      config,
      priceSnapshot,
      createExecutor: () => (dependencies.createExecutor ?? createProductionExecutor)(config),
      onPreflight: (summary) => writeLine(JSON.stringify(safePreflight(summary))),
    });
    const passed =
      result.report.semantic.gates.passed &&
      result.report.stability.gates.passed &&
      result.report.endToEnd.gates.passed;
    writeLine(JSON.stringify({ status: passed ? 'PASS' : 'FAIL', report: result.report }));
    return passed ? 0 : 1;
  } catch (error) {
    // Never stringify Error, cause, provider payload, request, context, candidate, or output.
    writeLine(JSON.stringify(toSafeNarrativeLiveEvalFailure(error)));
    return 1;
  }
}

function isMainModule(): boolean {
  const mainPath = process.argv[1];
  return mainPath !== undefined && import.meta.url === pathToFileURL(mainPath).href;
}

if (isMainModule()) {
  process.exitCode = await runNarrativeQualityLiveEvalScript(process.env, (line) =>
    console.log(line),
  );
}
