import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  buildDuffelSmokePlan,
  DuffelSmokePlanError,
  validatePreparedDuffelSmokePlan,
  type PreparedDuffelSmokePlan,
} from '../../srv/providers/duffel/duffel-smoke-plan.js';
import { duffelSmokeEvidenceSchema } from '../../srv/providers/duffel/duffel-smoke-evidence.js';
import { runDuffelTestModeSmoke } from '../../srv/providers/duffel/duffel-smoke-runner.js';
import type { ProviderHttpTransport } from '../../srv/providers/http/provider-http-client.js';
import {
  duffelSmokePreflightOutputSchema,
  runDuffelSmokePreflightScript,
} from '../../scripts/duffel-smoke-preflight.js';
import {
  duffelFixture,
  validDuffelOfferRequestResponse,
} from '../fixtures/duffel-offer-response.js';

const SOURCE_SHA = 'a'.repeat(40);
const TEST_TOKEN = 'duffel_test_safe_unit_token';
const START_DATE = '2026-10-10';
const END_DATE = '2026-10-13';
const CLOCK = () => new Date('2026-10-01T12:00:00.000Z');

function preparedPlan(): PreparedDuffelSmokePlan {
  return buildDuffelSmokePlan({
    sourceSha: SOURCE_SHA,
    repositoryTreeState: 'CLEAN',
    today: '2026-08-30',
    startDate: START_DATE,
    endDate: END_DATE,
  });
}

function expectPlanError(
  operation: () => unknown,
  expectedCode: DuffelSmokePlanError['code'],
): void {
  let caught: unknown;
  try {
    operation();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(DuffelSmokePlanError);
  expect(caught).toMatchObject({ code: expectedCode });
}

function approvedDependencies(prepared: PreparedDuffelSmokePlan, transport: ProviderHttpTransport) {
  return {
    optIn: 'true',
    approvedPlanFingerprint: prepared.planFingerprint,
    readToken: vi.fn(() => TEST_TOKEN),
    transport,
    now: CLOCK,
  } as const;
}

describe('Duffel TEST smoke plan and offline preflight', () => {
  it('builds a deterministic, clean-tree, single-call TEST plan bound to source and dates', () => {
    const first = preparedPlan();
    const second = preparedPlan();

    expect(second).toEqual(first);
    expect(first.plan).toMatchObject({
      sourceSha: SOURCE_SHA,
      repositoryTreeState: 'CLEAN',
      environment: 'TEST',
      scenario: {
        originIata: 'WRO',
        destinationIata: 'PRG',
        startDate: START_DATE,
        endDate: END_DATE,
        adults: 1,
        cabinClass: 'economy',
      },
      execution: {
        logicalSearches: 1,
        physicalOfferRequests: 1,
        maxCallsPerRun: 1,
        maxConcurrency: 1,
        maxAttemptsPerCall: 1,
        retryCount: 0,
        fallbackStrategy: 'NONE',
        pagination: false,
        polling: false,
        offerRefresh: false,
        order: false,
        payment: false,
      },
      authorization: { credentialReadsDuringPreflight: 0 },
      cost: {
        plannedMaximumCostUsdMicros: 0,
        actualExternalCostUsdMicrosDuringPreflight: 0,
      },
    });
    expect(first.planFingerprint).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('changes approval identity when source SHA or travel dates change', () => {
    const baseline = preparedPlan();
    const changedSource = buildDuffelSmokePlan({
      sourceSha: 'b'.repeat(40),
      repositoryTreeState: 'CLEAN',
      today: '2026-08-30',
      startDate: START_DATE,
      endDate: END_DATE,
    });
    const changedDates = buildDuffelSmokePlan({
      sourceSha: SOURCE_SHA,
      repositoryTreeState: 'CLEAN',
      today: '2026-08-30',
      startDate: '2026-10-11',
      endDate: '2026-10-14',
    });

    expect(changedSource.planFingerprint).not.toBe(baseline.planFingerprint);
    expect(changedDates.planFingerprint).not.toBe(baseline.planFingerprint);
    expect(changedDates.plan.execution.queryFingerprint).not.toBe(
      baseline.plan.execution.queryFingerprint,
    );
  });

  it.each([
    ['DIRTY_REPOSITORY', { repositoryTreeState: 'DIRTY' as const }],
    ['INVALID_FUTURE_DATES', { startDate: '2026-08-30' }],
    ['INVALID_FUTURE_DATES', { endDate: START_DATE }],
  ] as const)('blocks invalid plan input with %s', (expectedCode, override) => {
    expectPlanError(
      () =>
        buildDuffelSmokePlan({
          sourceSha: SOURCE_SHA,
          repositoryTreeState: 'CLEAN',
          today: '2026-08-30',
          startDate: START_DATE,
          endDate: END_DATE,
          ...override,
        }),
      expectedCode,
    );
  });

  it('rejects a modified plan or fingerprint before the runner can use it', () => {
    const prepared = preparedPlan();
    const modified = structuredClone(prepared);
    Reflect.set(modified.plan.execution, 'maxCallsPerRun', 2);

    expectPlanError(() => validatePreparedDuffelSmokePlan(modified), 'RUNTIME_IDENTITY_MISMATCH');
    expectPlanError(
      () => validatePreparedDuffelSmokePlan({ ...prepared, planFingerprint: 'b'.repeat(64) }),
      'RUNTIME_IDENTITY_MISMATCH',
    );
  });

  it('runs preflight without credentials, provider requests, environment reads or network', () => {
    const output: string[] = [];
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const exitCode = runDuffelSmokePreflightScript(
      ['--start-date', START_DATE, '--end-date', END_DATE],
      (line) => output.push(line),
      {
        readRepositoryState: () => ({
          sourceSha: SOURCE_SHA,
          repositoryTreeState: 'CLEAN',
        }),
        today: () => '2026-08-30',
      },
    );

    expect(exitCode).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(duffelSmokePreflightOutputSchema.parse(JSON.parse(output[0]!))).toMatchObject({
      status: 'PREFLIGHT_PASSED',
      providerRequestsExecuted: 0,
      credentialReads: 0,
      actualExternalCostUsdMicros: 0,
    });
    fetchSpy.mockRestore();
  });

  it('blocks preflight on a dirty tree and reports only closed metadata', () => {
    const output: string[] = [];
    const exitCode = runDuffelSmokePreflightScript(
      ['--start-date', START_DATE, '--end-date', END_DATE],
      (line) => output.push(line),
      {
        readRepositoryState: () => ({ sourceSha: SOURCE_SHA, repositoryTreeState: 'DIRTY' }),
        today: () => '2026-08-30',
      },
    );

    expect(exitCode).toBe(1);
    expect(JSON.parse(output[0]!)).toEqual({
      actualExternalCostUsdMicros: 0,
      code: 'DIRTY_REPOSITORY',
      credentialReads: 0,
      providerRequestsExecuted: 0,
      status: 'PREFLIGHT_BLOCKED',
    });
  });

  it('keeps the dormant smoke command outside default verification and build scripts', () => {
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as {
      scripts: Record<string, string>;
    };
    for (const script of ['start', 'build', 'verify', 'verify:full']) {
      expect(packageJson.scripts[script]).not.toContain('duffel:smoke:test');
    }
    expect(packageJson.scripts['duffel:smoke:test']).not.toContain('--env-file');
  });
});

describe('dormant Duffel TEST smoke runner', () => {
  it.each([
    ['missing opt-in', undefined, undefined, 'OPT_IN_REQUIRED'],
    ['wrong opt-in', 'TRUE', undefined, 'OPT_IN_REQUIRED'],
    ['missing approval', 'true', undefined, 'PLAN_NOT_APPROVED'],
    ['wrong approval', 'true', 'b'.repeat(64), 'PLAN_NOT_APPROVED'],
  ])('blocks %s before credential access and transport', async (_label, optIn, approval, code) => {
    const prepared = preparedPlan();
    const readToken = vi.fn(() => TEST_TOKEN);
    const transport = vi.fn<ProviderHttpTransport>();

    const result = await runDuffelTestModeSmoke(prepared, {
      optIn,
      approvedPlanFingerprint: approval,
      readToken,
      transport,
      now: CLOCK,
    });

    expect(result).toMatchObject({
      status: 'BLOCKED',
      failureCategory: code,
      requestCount: 0,
      attemptCount: 0,
      credentialAccessed: false,
    });
    expect(readToken).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', undefined, 'CREDENTIAL_UNAVAILABLE'],
    ['empty', '', 'CREDENTIAL_UNAVAILABLE'],
    ['LIVE', 'duffel_live_unsafe', 'CREDENTIAL_NOT_TEST_MODE'],
    ['unknown', 'opaque-token', 'CREDENTIAL_NOT_TEST_MODE'],
    ['test prefix only', 'duffel_test_', 'CREDENTIAL_NOT_TEST_MODE'],
  ])('rejects a %s credential before transport', async (_label, token, code) => {
    const prepared = preparedPlan();
    const readToken = vi.fn(() => token);
    const transport = vi.fn<ProviderHttpTransport>();

    const result = await runDuffelTestModeSmoke(prepared, {
      optIn: 'true',
      approvedPlanFingerprint: prepared.planFingerprint,
      readToken,
      transport,
      now: CLOCK,
    });

    expect(result).toMatchObject({
      status: 'BLOCKED',
      failureCategory: code,
      requestCount: 0,
      attemptCount: 0,
      credentialAccessed: true,
    });
    expect(readToken).toHaveBeenCalledTimes(1);
    expect(transport).not.toHaveBeenCalled();
    if (token !== undefined && token.length > 0) {
      expect(JSON.stringify(result)).not.toContain(token);
    }
  });

  it('closes a credential read failure before transport without exposing its error', async () => {
    const prepared = preparedPlan();
    const readToken = vi.fn(() => {
      throw new Error('raw credential source detail');
    });
    const transport = vi.fn<ProviderHttpTransport>();

    const result = await runDuffelTestModeSmoke(prepared, {
      optIn: 'true',
      approvedPlanFingerprint: prepared.planFingerprint,
      readToken,
      transport,
      now: CLOCK,
    });

    expect(result).toMatchObject({
      status: 'BLOCKED',
      failureCategory: 'CREDENTIAL_UNAVAILABLE',
      requestCount: 0,
      attemptCount: 0,
      credentialAccessed: true,
    });
    expect(readToken).toHaveBeenCalledTimes(1);
    expect(transport).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('raw credential source detail');
  });

  it('executes exactly one TEST Offer Request and records only bounded evidence on PASS', async () => {
    const prepared = preparedPlan();
    const transport = vi.fn<ProviderHttpTransport>(async (_input, init) => {
      expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TEST_TOKEN}`);
      return new Response(JSON.stringify(validDuffelOfferRequestResponse), { status: 200 });
    });
    const dependencies = approvedDependencies(prepared, transport);

    const result = await runDuffelTestModeSmoke(prepared, dependencies);
    const serialized = JSON.stringify(result);

    expect(result).toMatchObject({
      status: 'PASS',
      failureCategory: null,
      schemaFailureStage: null,
      environment: 'TEST',
      sourceSha: SOURCE_SHA,
      planFingerprint: prepared.planFingerprint,
      requestCount: 1,
      attemptCount: 1,
      credentialAccessed: true,
      httpStatus: null,
      resultCount: 1,
      actualExternalCostUsdMicros: 0,
    });
    expect(result.resultFingerprint).toMatch(/^[0-9a-f]{64}$/u);
    expect(dependencies.readToken).toHaveBeenCalledTimes(1);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(serialized).not.toContain(TEST_TOKEN);
    expect(serialized).not.toContain('off_000000validoffer');
    expect(serialized).not.toContain('LOT Polish Airlines');
    expect(serialized).not.toContain('120.00');
  });

  it('stops with NO_USABLE_OFFER after the single empty TEST response', async () => {
    const prepared = preparedPlan();
    const fixture = duffelFixture();
    fixture.data.offers = [];
    const transport = vi.fn<ProviderHttpTransport>(
      async () => new Response(JSON.stringify(fixture), { status: 200 }),
    );

    const result = await runDuffelTestModeSmoke(
      prepared,
      approvedDependencies(prepared, transport),
    );

    expect(result).toMatchObject({
      status: 'NO_USABLE_OFFER',
      failureCategory: 'NO_USABLE_OFFER',
      schemaFailureStage: null,
      requestCount: 1,
      attemptCount: 1,
      httpStatus: null,
      resultCount: 0,
    });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['rate limit', 429, 'RATE_LIMITED'],
    ['upstream client rejection', 400, 'UPSTREAM_4XX'],
    ['upstream outage', 503, 'UPSTREAM_5XX'],
  ])('fails safe on %s without retry', async (_label, status, category) => {
    const prepared = preparedPlan();
    const transport = vi.fn<ProviderHttpTransport>(async () => new Response(null, { status }));

    const result = await runDuffelTestModeSmoke(
      prepared,
      approvedDependencies(prepared, transport),
    );

    expect(result).toMatchObject({
      status: 'FAILED',
      failureCategory: category,
      requestCount: 1,
      attemptCount: 1,
      httpStatus: status,
    });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      'network failure',
      async () => Promise.reject(new Error('raw network secret')),
      'NETWORK',
      null,
    ],
    ['malformed JSON', async () => new Response('{not-json'), 'INVALID_SCHEMA', 'RESPONSE_JSON'],
    [
      'invalid envelope schema',
      async () => new Response(JSON.stringify({ data: { offers: 'not-an-array' } })),
      'INVALID_SCHEMA',
      'RESPONSE_ENVELOPE',
    ],
    [
      'LIVE response',
      async () => {
        const fixture = duffelFixture();
        fixture.data.live_mode = true;
        return new Response(JSON.stringify(fixture));
      },
      'INVALID_SCHEMA',
      'ENVIRONMENT_IDENTITY',
    ],
    [
      'invalid offer item schema',
      async () => {
        const fixture = duffelFixture();
        fixture.data.offers = [{} as (typeof fixture.data.offers)[number]];
        return new Response(JSON.stringify(fixture));
      },
      'INVALID_SCHEMA',
      'RESULT_ITEM_SCHEMA',
    ],
    [
      'conflicting repeated offer identity',
      async () => {
        const fixture = duffelFixture();
        const conflicting = structuredClone(fixture.data.offers[0]!);
        conflicting.expires_at = '2026-10-01T14:00:00.000Z';
        fixture.data.offers.push(conflicting);
        return new Response(JSON.stringify(fixture));
      },
      'INVALID_SCHEMA',
      'RESULT_SEMANTIC_IDENTITY',
    ],
  ] as const)(
    'closes %s into safe staged evidence',
    async (_label, response, category, schemaFailureStage) => {
      const prepared = preparedPlan();
      const transport = vi.fn<ProviderHttpTransport>(response);

      const result = await runDuffelTestModeSmoke(
        prepared,
        approvedDependencies(prepared, transport),
      );

      expect(result).toMatchObject({
        status: 'FAILED',
        failureCategory: category,
        schemaFailureStage,
        requestCount: 1,
        attemptCount: 1,
      });
      expect(transport).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(result)).not.toContain('raw network secret');
    },
  );

  it('times out the only request and never retries it', async () => {
    vi.useFakeTimers();
    const prepared = preparedPlan();
    const transport = vi.fn<ProviderHttpTransport>(
      async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('raw abort')), {
            once: true,
          });
        }),
    );
    const smoke = runDuffelTestModeSmoke(prepared, approvedDependencies(prepared, transport));

    await vi.advanceTimersByTimeAsync(10_000);

    await expect(smoke).resolves.toMatchObject({
      status: 'FAILED',
      failureCategory: 'TIMEOUT',
      requestCount: 1,
      attemptCount: 1,
    });
    expect(transport).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('rejects evidence extensions that could carry raw provider data', () => {
    const prepared = preparedPlan();
    const validEvidence = {
      evidenceVersion: 'duffel-smoke-evidence-v2',
      status: 'PASS',
      failureCategory: null,
      schemaFailureStage: null,
      environment: 'TEST',
      sourceSha: SOURCE_SHA,
      planVersion: prepared.plan.planVersion,
      planFingerprint: prepared.planFingerprint,
      queryFingerprint: prepared.plan.execution.queryFingerprint,
      adapterVersion: prepared.plan.versions.adapterVersion,
      upstreamSchemaVersion: prepared.plan.versions.upstreamSchemaVersion,
      manifestVersion: prepared.plan.versions.manifestVersion,
      manifestFingerprint: prepared.plan.versions.manifestFingerprint,
      executionPolicyVersion: prepared.plan.versions.executionPolicyVersion,
      startedAt: CLOCK().toISOString(),
      completedAt: CLOCK().toISOString(),
      requestCount: 1,
      attemptCount: 1,
      credentialAccessed: true,
      latencyMs: 1,
      httpStatus: null,
      resultCount: 1,
      resultFingerprint: 'd'.repeat(64),
      actualExternalCostUsdMicros: 0,
    } as const;
    expect(duffelSmokeEvidenceSchema.safeParse(validEvidence).success).toBe(true);
    expect(
      duffelSmokeEvidenceSchema.safeParse({
        ...validEvidence,
        rawResponse: validDuffelOfferRequestResponse,
        token: TEST_TOKEN,
      }).success,
    ).toBe(false);
  });

  it('rejects status/count/category combinations that contradict terminal evidence', () => {
    const prepared = preparedPlan();
    const validEvidence = {
      evidenceVersion: 'duffel-smoke-evidence-v2',
      status: 'PASS',
      failureCategory: null,
      schemaFailureStage: null,
      environment: 'TEST',
      sourceSha: SOURCE_SHA,
      planVersion: prepared.plan.planVersion,
      planFingerprint: prepared.planFingerprint,
      queryFingerprint: prepared.plan.execution.queryFingerprint,
      adapterVersion: prepared.plan.versions.adapterVersion,
      upstreamSchemaVersion: prepared.plan.versions.upstreamSchemaVersion,
      manifestVersion: prepared.plan.versions.manifestVersion,
      manifestFingerprint: prepared.plan.versions.manifestFingerprint,
      executionPolicyVersion: prepared.plan.versions.executionPolicyVersion,
      startedAt: CLOCK().toISOString(),
      completedAt: CLOCK().toISOString(),
      requestCount: 1,
      attemptCount: 1,
      credentialAccessed: true,
      latencyMs: 1,
      httpStatus: null,
      resultCount: 1,
      resultFingerprint: 'd'.repeat(64),
      actualExternalCostUsdMicros: 0,
    } as const;
    const contradictions: readonly unknown[] = [
      { ...validEvidence, requestCount: 0, attemptCount: 0 },
      { ...validEvidence, resultFingerprint: null },
      {
        ...validEvidence,
        status: 'NO_USABLE_OFFER',
        failureCategory: 'NO_USABLE_OFFER',
        resultCount: 1,
      },
      {
        ...validEvidence,
        status: 'BLOCKED',
        failureCategory: 'OPT_IN_REQUIRED',
        requestCount: 1,
        attemptCount: 1,
        credentialAccessed: false,
        resultCount: null,
        resultFingerprint: null,
      },
      {
        ...validEvidence,
        status: 'BLOCKED',
        failureCategory: 'NETWORK',
        requestCount: 0,
        attemptCount: 0,
        resultCount: null,
        resultFingerprint: null,
        latencyMs: 0,
      },
      {
        ...validEvidence,
        status: 'BLOCKED',
        failureCategory: 'PLAN_NOT_APPROVED',
        requestCount: 0,
        attemptCount: 0,
        resultCount: null,
        resultFingerprint: null,
        latencyMs: 0,
      },
      {
        ...validEvidence,
        status: 'FAILED',
        failureCategory: 'OPT_IN_REQUIRED',
        resultCount: null,
        resultFingerprint: null,
      },
      {
        ...validEvidence,
        status: 'FAILED',
        failureCategory: 'INVALID_SCHEMA',
        schemaFailureStage: null,
        resultCount: null,
        resultFingerprint: null,
      },
      {
        ...validEvidence,
        status: 'FAILED',
        failureCategory: 'NETWORK',
        schemaFailureStage: 'RESPONSE_JSON',
        resultCount: null,
        resultFingerprint: null,
      },
      {
        ...validEvidence,
        completedAt: '2026-10-01T11:59:59.000Z',
      },
    ];

    for (const contradiction of contradictions) {
      expect(duffelSmokeEvidenceSchema.safeParse(contradiction).success).toBe(false);
    }
  });
});
