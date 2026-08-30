import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import {
  buildDuffelSmokePlan,
  duffelSmokePlanSchema,
  DuffelSmokePlanError,
  type PreparedDuffelSmokePlan,
} from '../srv/providers/duffel/duffel-smoke-plan.ts';
import {
  canonicalizeProviderJson,
  type ProviderJsonValue,
} from '../srv/providers/provider-fingerprint.ts';

export interface DuffelSmokeRepositoryState {
  readonly sourceSha: string;
  readonly repositoryTreeState: 'CLEAN' | 'DIRTY';
}

export interface DuffelSmokeDateArguments {
  readonly startDate: string;
  readonly endDate: string;
}

export const duffelSmokePreflightOutputSchema = z
  .object({
    status: z.literal('PREFLIGHT_PASSED'),
    providerRequestsExecuted: z.literal(0),
    credentialReads: z.literal(0),
    actualExternalCostUsdMicros: z.literal(0),
    planFingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
    plan: duffelSmokePlanSchema,
  })
  .strict();

export const duffelSmokePreflightFailureSchema = z
  .object({
    status: z.literal('PREFLIGHT_BLOCKED'),
    code: z.enum([
      'INVALID_ARGUMENTS',
      'REPOSITORY_STATE_UNAVAILABLE',
      'INVALID_PLAN_INPUT',
      'DIRTY_REPOSITORY',
      'INVALID_FUTURE_DATES',
      'RUNTIME_IDENTITY_MISMATCH',
    ]),
    providerRequestsExecuted: z.literal(0),
    credentialReads: z.literal(0),
    actualExternalCostUsdMicros: z.literal(0),
  })
  .strict();

export type DuffelSmokePreflightOutput = z.infer<typeof duffelSmokePreflightOutputSchema>;
export type DuffelSmokePreflightFailure = z.infer<typeof duffelSmokePreflightFailureSchema>;

export interface DuffelSmokePreflightDependencies {
  readonly readRepositoryState?: () => DuffelSmokeRepositoryState;
  readonly today?: () => string;
  readonly buildPlan?: typeof buildDuffelSmokePlan;
}

export function parseDuffelSmokeDateArguments(args: readonly string[]): DuffelSmokeDateArguments {
  let startDate: string | undefined;
  let endDate: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    const value = args[index + 1];
    if (
      (name !== '--start-date' && name !== '--end-date') ||
      value === undefined ||
      value.startsWith('--')
    ) {
      throw new TypeError('Invalid Duffel smoke date arguments.');
    }
    if (name === '--start-date') {
      if (startDate !== undefined) throw new TypeError('Duplicate Duffel smoke start date.');
      startDate = value;
    } else {
      if (endDate !== undefined) throw new TypeError('Duplicate Duffel smoke end date.');
      endDate = value;
    }
    index += 1;
  }
  if (startDate === undefined || endDate === undefined) {
    throw new TypeError('Duffel smoke dates are required.');
  }
  return Object.freeze({ startDate, endDate });
}

export function readDuffelSmokeRepositoryState(): DuffelSmokeRepositoryState {
  const repository = process.cwd();
  const gitArguments = ['-c', `safe.directory=${repository}`];
  const sourceSha = execFileSync('git', [...gitArguments, 'rev-parse', 'HEAD'], {
    cwd: repository,
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
  const status = execFileSync(
    'git',
    [...gitArguments, 'status', '--porcelain=v1', '--untracked-files=normal'],
    {
      cwd: repository,
      encoding: 'utf8',
      windowsHide: true,
    },
  );
  return Object.freeze({
    sourceSha,
    repositoryTreeState: status.trim().length === 0 ? 'CLEAN' : 'DIRTY',
  });
}

function defaultToday(): string {
  return new Date().toISOString().slice(0, 10);
}

function success(prepared: PreparedDuffelSmokePlan): DuffelSmokePreflightOutput {
  return duffelSmokePreflightOutputSchema.parse({
    status: 'PREFLIGHT_PASSED',
    providerRequestsExecuted: 0,
    credentialReads: 0,
    actualExternalCostUsdMicros: 0,
    planFingerprint: prepared.planFingerprint,
    plan: prepared.plan,
  });
}

function failure(code: DuffelSmokePreflightFailure['code']): DuffelSmokePreflightFailure {
  return duffelSmokePreflightFailureSchema.parse({
    status: 'PREFLIGHT_BLOCKED',
    code,
    providerRequestsExecuted: 0,
    credentialReads: 0,
    actualExternalCostUsdMicros: 0,
  });
}

export function runDuffelSmokePreflightScript(
  args: readonly string[],
  writeLine: (line: string) => void,
  dependencies: DuffelSmokePreflightDependencies = {},
): 0 | 1 {
  let dates: DuffelSmokeDateArguments;
  try {
    dates = parseDuffelSmokeDateArguments(args);
  } catch {
    writeLine(
      canonicalizeProviderJson(failure('INVALID_ARGUMENTS') as unknown as ProviderJsonValue),
    );
    return 1;
  }

  let repositoryState: DuffelSmokeRepositoryState;
  try {
    repositoryState = (dependencies.readRepositoryState ?? readDuffelSmokeRepositoryState)();
  } catch {
    writeLine(
      canonicalizeProviderJson(
        failure('REPOSITORY_STATE_UNAVAILABLE') as unknown as ProviderJsonValue,
      ),
    );
    return 1;
  }

  try {
    const prepared = (dependencies.buildPlan ?? buildDuffelSmokePlan)({
      ...repositoryState,
      today: (dependencies.today ?? defaultToday)(),
      startDate: dates.startDate,
      endDate: dates.endDate,
    });
    writeLine(canonicalizeProviderJson(success(prepared) as unknown as ProviderJsonValue));
    return 0;
  } catch (error) {
    const code = error instanceof DuffelSmokePlanError ? error.code : 'RUNTIME_IDENTITY_MISMATCH';
    writeLine(canonicalizeProviderJson(failure(code) as unknown as ProviderJsonValue));
    return 1;
  }
}

function isMainModule(): boolean {
  const mainPath = process.argv[1];
  return mainPath !== undefined && import.meta.url === pathToFileURL(mainPath).href;
}

if (isMainModule()) {
  process.exitCode = runDuffelSmokePreflightScript(process.argv.slice(2), (line) =>
    console.log(line),
  );
}
