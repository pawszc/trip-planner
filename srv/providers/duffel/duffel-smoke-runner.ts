import { DuffelApiTransportProvider } from './duffel-api-transport-provider.ts';
import {
  createDuffelSmokeEvidence,
  DUFFEL_SMOKE_EVIDENCE_VERSION,
  type DuffelSmokeEvidence,
  type DuffelSmokeFailureCategory,
} from './duffel-smoke-evidence.ts';
import {
  createDuffelSmokeRuntimeIdentity,
  DUFFEL_TEST_TOKEN_PREFIX,
  validatePreparedDuffelSmokePlan,
  type PreparedDuffelSmokePlan,
} from './duffel-smoke-plan.ts';
import { DEFAULT_DUFFEL_ORIGIN_CATALOG } from './duffel-search-policy.ts';
import {
  DUFFEL_API_BASE_URL,
  ProviderHttpClient,
  type ProviderHttpTransport,
} from '../http/provider-http-client.ts';
import {
  ProviderExecutionScope,
  type ProviderCallAuditEvent,
  type ProviderCallOptions,
} from '../provider-execution.ts';
import { ProviderExecutionError, type ProviderFailureCategory } from '../provider-errors.ts';

export interface DuffelSmokeRunnerDependencies {
  readonly optIn: string | undefined;
  readonly approvedPlanFingerprint: string | undefined;
  readonly readToken: () => string | undefined;
  readonly transport?: ProviderHttpTransport;
  readonly now?: () => Date;
}

function safeInstant(now: () => Date): string {
  let instant: Date;
  try {
    instant = now();
  } catch {
    instant = new Date(0);
  }
  return Number.isFinite(instant.getTime()) ? instant.toISOString() : new Date(0).toISOString();
}

function isTestToken(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.startsWith(DUFFEL_TEST_TOKEN_PREFIX) &&
    value.length > DUFFEL_TEST_TOKEN_PREFIX.length &&
    value.length <= 500 &&
    ![...value].some((character) => (character.codePointAt(0) ?? 0) <= 32)
  );
}

function executionOptions(scope: ProviderExecutionScope): ProviderCallOptions {
  return {
    signal: scope.signal,
    executeUpstream: (descriptor, invoke) =>
      scope.execute(
        {
          providerKey: 'duffel-flights',
          operation: 'TRANSPORT_SEARCH',
          destinationCode: descriptor.destinationCode ?? null,
          queryFingerprint: descriptor.queryFingerprint,
          resultFingerprint: descriptor.resultFingerprint,
          resultCount: descriptor.resultCount,
        },
        invoke,
      ),
  };
}

function auditedCounts(events: readonly ProviderCallAuditEvent[]): {
  readonly requestCount: 0 | 1;
  readonly attemptCount: 0 | 1;
} | null {
  const requestCount = events.filter((event) => event.providerCallAttempted).length;
  const attemptCount = events.reduce((sum, event) => sum + event.attempts, 0);
  if ((requestCount !== 0 && requestCount !== 1) || (attemptCount !== 0 && attemptCount !== 1)) {
    return null;
  }
  return { requestCount, attemptCount };
}

function failureCategory(error: ProviderExecutionError): Exclude<DuffelSmokeFailureCategory, null> {
  return (error.evidence.underlyingCategory ?? error.category) as ProviderFailureCategory;
}

interface EvidenceInput {
  readonly prepared: PreparedDuffelSmokePlan;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly status: DuffelSmokeEvidence['status'];
  readonly failureCategory: DuffelSmokeFailureCategory;
  readonly credentialAccessed: boolean;
  readonly events?: readonly ProviderCallAuditEvent[];
}

function evidence(input: EvidenceInput): DuffelSmokeEvidence {
  const event = input.events?.[0];
  const counts = auditedCounts(input.events ?? []);
  const auditInvalid = counts === null || (input.events?.length ?? 0) > 1;
  const plan = input.prepared.plan;
  return createDuffelSmokeEvidence({
    evidenceVersion: DUFFEL_SMOKE_EVIDENCE_VERSION,
    status: auditInvalid ? 'FAILED' : input.status,
    failureCategory: auditInvalid ? 'AUDIT_CONTRACT_VIOLATION' : input.failureCategory,
    environment: 'TEST',
    sourceSha: plan.sourceSha,
    planVersion: plan.planVersion,
    planFingerprint: input.prepared.planFingerprint,
    queryFingerprint: plan.execution.queryFingerprint,
    adapterVersion: plan.versions.adapterVersion,
    upstreamSchemaVersion: plan.versions.upstreamSchemaVersion,
    manifestVersion: plan.versions.manifestVersion,
    manifestFingerprint: plan.versions.manifestFingerprint,
    executionPolicyVersion: plan.versions.executionPolicyVersion,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    requestCount: counts?.requestCount ?? 0,
    attemptCount: counts?.attemptCount ?? 0,
    credentialAccessed: input.credentialAccessed,
    latencyMs: event?.latencyMs ?? 0,
    httpStatus: event?.httpStatus ?? null,
    resultCount: event?.resultCount ?? null,
    resultFingerprint: event?.resultFingerprint ?? null,
    actualExternalCostUsdMicros: 0,
  });
}

export async function runDuffelTestModeSmoke(
  unvalidatedPlan: PreparedDuffelSmokePlan,
  dependencies: DuffelSmokeRunnerDependencies,
): Promise<DuffelSmokeEvidence> {
  const prepared = validatePreparedDuffelSmokePlan(unvalidatedPlan);
  const now = dependencies.now ?? (() => new Date());
  const startedAt = safeInstant(now);
  if (dependencies.optIn !== 'true') {
    return evidence({
      prepared,
      startedAt,
      completedAt: safeInstant(now),
      status: 'BLOCKED',
      failureCategory: 'OPT_IN_REQUIRED',
      credentialAccessed: false,
    });
  }
  if (dependencies.approvedPlanFingerprint !== prepared.planFingerprint) {
    return evidence({
      prepared,
      startedAt,
      completedAt: safeInstant(now),
      status: 'BLOCKED',
      failureCategory: 'PLAN_NOT_APPROVED',
      credentialAccessed: false,
    });
  }

  let token: string | undefined;
  try {
    token = dependencies.readToken();
  } catch {
    return evidence({
      prepared,
      startedAt,
      completedAt: safeInstant(now),
      status: 'BLOCKED',
      failureCategory: 'CREDENTIAL_UNAVAILABLE',
      credentialAccessed: true,
    });
  }
  if (token === undefined || token.length === 0) {
    return evidence({
      prepared,
      startedAt,
      completedAt: safeInstant(now),
      status: 'BLOCKED',
      failureCategory: 'CREDENTIAL_UNAVAILABLE',
      credentialAccessed: true,
    });
  }
  if (!isTestToken(token)) {
    return evidence({
      prepared,
      startedAt,
      completedAt: safeInstant(now),
      status: 'BLOCKED',
      failureCategory: 'CREDENTIAL_NOT_TEST_MODE',
      credentialAccessed: true,
    });
  }
  const testToken = token;

  const runtime = createDuffelSmokeRuntimeIdentity(
    prepared.plan.scenario.startDate,
    prepared.plan.scenario.endDate,
  );
  const clientOptions = {
    baseUrl: DUFFEL_API_BASE_URL,
    token: () => testToken,
    now,
  } as const;
  const httpClient = new ProviderHttpClient(
    dependencies.transport === undefined
      ? clientOptions
      : { ...clientOptions, transport: dependencies.transport },
  );
  const scope = new ProviderExecutionScope({
    policy: {
      timeoutMs: prepared.plan.execution.timeoutMs,
      maxCallsPerRun: prepared.plan.execution.maxCallsPerRun,
      maxConcurrency: prepared.plan.execution.maxConcurrency,
    },
    now: () => now().getTime(),
  });
  scope.assertCallBudget(prepared.plan.execution.physicalOfferRequests);
  try {
    const offers = await new DuffelApiTransportProvider({
      environment: 'TEST',
      httpClient,
      manifestEntry: runtime.transportEntry,
      originCatalog: DEFAULT_DUFFEL_ORIGIN_CATALOG,
      clock: now,
    }).search(runtime.request, executionOptions(scope));
    const events = scope.getAuditEvents();
    if (offers.length === 0) {
      return evidence({
        prepared,
        startedAt,
        completedAt: safeInstant(now),
        status: 'NO_USABLE_OFFER',
        failureCategory: 'NO_USABLE_OFFER',
        credentialAccessed: true,
        events,
      });
    }
    return evidence({
      prepared,
      startedAt,
      completedAt: safeInstant(now),
      status: 'PASS',
      failureCategory: null,
      credentialAccessed: true,
      events,
    });
  } catch (error) {
    const events = scope.getAuditEvents();
    return evidence({
      prepared,
      startedAt,
      completedAt: safeInstant(now),
      status: 'FAILED',
      failureCategory:
        error instanceof ProviderExecutionError
          ? failureCategory(error)
          : 'UNEXPECTED_SAFE_FAILURE',
      credentialAccessed: true,
      events,
    });
  } finally {
    scope.dispose();
  }
}
