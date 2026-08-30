import { pathToFileURL } from 'node:url';
import {
  buildDuffelSmokePlan,
  DuffelSmokePlanError,
} from '../srv/providers/duffel/duffel-smoke-plan.ts';
import { runDuffelTestModeSmoke } from '../srv/providers/duffel/duffel-smoke-runner.ts';
import {
  canonicalizeProviderJson,
  type ProviderJsonValue,
} from '../srv/providers/provider-fingerprint.ts';
import {
  duffelSmokePreflightFailureSchema,
  parseDuffelSmokeDateArguments,
  readDuffelSmokeRepositoryState,
} from './duffel-smoke-preflight.ts';

function safePreflightFailure(
  code: 'INVALID_ARGUMENTS' | 'REPOSITORY_STATE_UNAVAILABLE' | DuffelSmokePlanError['code'],
): ProviderJsonValue {
  return duffelSmokePreflightFailureSchema.parse({
    status: 'PREFLIGHT_BLOCKED',
    code,
    providerRequestsExecuted: 0,
    credentialReads: 0,
    actualExternalCostUsdMicros: 0,
  }) as unknown as ProviderJsonValue;
}

export async function runDuffelSmokeTestScript(
  args: readonly string[],
  writeLine: (line: string) => void,
): Promise<0 | 1> {
  let dates;
  try {
    dates = parseDuffelSmokeDateArguments(args);
  } catch {
    writeLine(canonicalizeProviderJson(safePreflightFailure('INVALID_ARGUMENTS')));
    return 1;
  }
  let repositoryState;
  try {
    repositoryState = readDuffelSmokeRepositoryState();
  } catch {
    writeLine(canonicalizeProviderJson(safePreflightFailure('REPOSITORY_STATE_UNAVAILABLE')));
    return 1;
  }
  let prepared;
  try {
    prepared = buildDuffelSmokePlan({
      ...repositoryState,
      today: new Date().toISOString().slice(0, 10),
      startDate: dates.startDate,
      endDate: dates.endDate,
    });
  } catch (error) {
    const code = error instanceof DuffelSmokePlanError ? error.code : 'RUNTIME_IDENTITY_MISMATCH';
    writeLine(canonicalizeProviderJson(safePreflightFailure(code)));
    return 1;
  }

  const result = await runDuffelTestModeSmoke(prepared, {
    optIn: process.env.DUFFEL_SMOKE_ENABLED,
    approvedPlanFingerprint: process.env.DUFFEL_SMOKE_APPROVED_PLAN_FINGERPRINT,
    readToken: () => process.env.DUFFEL_ACCESS_TOKEN,
  });
  writeLine(canonicalizeProviderJson(result as unknown as ProviderJsonValue));
  return result.status === 'PASS' ? 0 : 1;
}

function isMainModule(): boolean {
  const mainPath = process.argv[1];
  return mainPath !== undefined && import.meta.url === pathToFileURL(mainPath).href;
}

if (isMainModule()) {
  process.exitCode = await runDuffelSmokeTestScript(process.argv.slice(2), (line) =>
    console.log(line),
  );
}
