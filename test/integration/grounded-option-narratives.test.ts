import { randomUUID } from 'node:crypto';
import type { Request } from '@sap/cds';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AiGateway } from '../../srv/ai/ai-gateway.ts';
import { loadAiConfig } from '../../srv/ai/config.ts';
import { createPersistentAiGateway } from '../../srv/ai/create-persistent-ai-gateway.ts';
import { AiProvider, AiTaskType, createInputFingerprint } from '../../srv/ai/contracts.ts';
import type {
  AiCallResult,
  AiExecutionProfile,
  StructuredAiAdapter,
  StructuredAiRequest,
} from '../../srv/ai/contracts.ts';
import { AiError } from '../../srv/ai/errors.ts';
import { CapAiRunStore } from '../../srv/ai/persistence/cap-ai-run-store.ts';
import type { AiRunStore } from '../../srv/ai/persistence/ai-run-store.ts';
import { referenceTripRequestODataPayload } from '../fixtures/trip-request.ts';

process.env.CDS_TYPESCRIPT = 'true';
const { default: cds } = await import('@sap/cds');
const sqliteTestDatabase = cds.env.requires.db as {
  pool?: Readonly<Record<string, unknown>> & { acquireTimeoutMillis?: number };
};
sqliteTestDatabase.pool = {
  ...sqliteTestDatabase.pool,
  acquireTimeoutMillis: 1_000,
};
const test = cds.test('serve', 'all', '--in-memory').in(process.cwd());
const { GET, POST } = test;

interface ODataCollection<T> {
  value: T[];
}

interface RankedOptionResponse {
  ID: string;
  planningRun_ID: string;
  rank: number;
  role: string;
  destinationCity: string;
  currency: string;
  budgetLimitMinor: number | string;
  totalAmountMinor: number | string;
  totalScore: number | string;
}

interface NarrativeRunResponse {
  ID: string;
  planningRun_ID: string;
  rankedOption_ID: string;
  aiRunId: string;
  status: 'SUCCEEDED';
  contextVersion: string;
  contextFingerprint: string;
  promptVersion: string;
  schemaVersion: string;
  blockCount: number;
}

interface OptionNarrativeResponse {
  ID: string;
  narrativeRun_ID: string;
  planningRun_ID: string;
  rankedOption_ID: string;
  sequence: number;
  kind: string;
  text: string;
}

interface FactReferenceResponse {
  narrativeRun_ID: string;
  optionNarrative_ID: string;
  planningRun_ID: string;
  rankedOption_ID: string;
  sequence: number;
  factId: string;
}

interface PersistedAiRun {
  ID: string;
  planningRun_ID: string | null;
  status: 'STARTED' | 'SUCCEEDED' | 'FAILED';
  taskType: string;
  provider: string;
  promptVersion: string;
  schemaVersion: string;
  inputFingerprint: string;
  expiresAt: string;
  responseModel: string | null;
  errorCode: string | null;
}

interface NarrativeObservation {
  adapterCalls: number;
  aiRunId?: string;
  profileTaskType?: string;
  startedSeenByAdapter?: PersistedAiRun;
  requestFactIds?: readonly string[];
  budgetSummary?: Readonly<Record<string, unknown>>;
}

type OfflineMode = 'SUCCESS' | 'INVALID_REFERENCE' | 'PROVIDER_FAILURE';

interface NarrativeServiceSeam {
  createNarrativeGateway(): AiGateway;
  after(event: string, handler: (result: unknown, request: Request) => void): void;
}

const forceProductRollbackHeader = 'x-test-force-narrative-rollback';
let narrativeService: NarrativeServiceSeam;
let originalGatewayFactory: () => AiGateway;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null;
}

function readRequestFacts(request: StructuredAiRequest<unknown>): {
  fingerprint: string;
  factIds: readonly string[];
  budgetSummary: Readonly<Record<string, unknown>>;
} {
  const input = request.input;
  if (!isRecord(input) || typeof input.fingerprint !== 'string' || !Array.isArray(input.facts)) {
    throw new Error('Offline adapter received no grounded context.');
  }
  let budgetSummary: Readonly<Record<string, unknown>> | undefined;
  const factIds = input.facts.map((fact) => {
    if (!isRecord(fact) || typeof fact.factId !== 'string') {
      throw new Error('Offline adapter received an invalid grounded fact.');
    }
    if (fact.key === 'option.budget.summary' && isRecord(fact.value)) {
      budgetSummary = fact.value;
    }
    return fact.factId;
  });
  if (budgetSummary === undefined) {
    throw new Error('Offline adapter received no grounded budget summary.');
  }
  return { fingerprint: input.fingerprint, factIds, budgetSummary };
}

async function readAiRun(ID: string): Promise<PersistedAiRun | undefined> {
  return cds.db.run(cds.ql.SELECT.one.from('trip.planner.AiRuns').where({ ID })) as Promise<
    PersistedAiRun | undefined
  >;
}

async function readAiRunIndependently(ID: string): Promise<PersistedAiRun | undefined> {
  return cds.db.tx(async (transaction) =>
    transaction.run(cds.ql.SELECT.one.from('trip.planner.AiRuns').where({ ID })),
  ) as Promise<PersistedAiRun | undefined>;
}

class OfflineNarrativeAdapter implements StructuredAiAdapter {
  readonly provider = AiProvider.ANTHROPIC;
  private readonly observation: NarrativeObservation;
  private readonly mode: OfflineMode;

  constructor(observation: NarrativeObservation, mode: OfflineMode) {
    this.observation = observation;
    this.mode = mode;
  }

  async call<TOutput>(
    request: StructuredAiRequest<TOutput>,
    profile: AiExecutionProfile,
  ): Promise<AiCallResult<TOutput>> {
    this.observation.adapterCalls += 1;
    this.observation.aiRunId = request.aiRunId;
    this.observation.profileTaskType = profile.taskType;
    this.observation.startedSeenByAdapter = await readAiRunIndependently(request.aiRunId!);
    const grounded = readRequestFacts(request);
    this.observation.requestFactIds = grounded.factIds;
    this.observation.budgetSummary = grounded.budgetSummary;

    if (this.mode === 'PROVIDER_FAILURE') {
      throw new AiError('PROVIDER_UNAVAILABLE', 'Offline provider failure.', {
        provider: this.provider,
        model: profile.model,
        retryable: true,
      });
    }

    const output =
      this.mode === 'INVALID_REFERENCE'
        ? {
            contextFingerprint: grounded.fingerprint,
            blocks: [
              {
                kind: 'SUMMARY',
                text: 'Output with a foreign fact reference.',
                factReferences: [`fact_${'f'.repeat(64)}`],
              },
            ],
          }
        : {
            contextFingerprint: grounded.fingerprint,
            blocks: [
              {
                kind: 'SUMMARY',
                text: 'Praga jest opcją wybraną przez deterministyczny pipeline.',
                factReferences: [grounded.factIds[0]],
              },
              {
                kind: 'RISK',
                text: 'Dane oferty są demonstracyjnym fixture, a nie bieżącą dostępnością.',
                factReferences: [grounded.factIds.at(-1)],
              },
            ],
          };
    const validation = request.outputSchema.safeParse(output);
    if (!validation.success) {
      throw new AiError(
        'INVALID_STRUCTURED_OUTPUT',
        'Offline provider output failed the request schema.',
        { provider: this.provider, model: profile.model },
      );
    }

    return {
      aiRunId: request.aiRunId!,
      output: validation.data,
      provider: this.provider,
      configuredModel: profile.model,
      responseModel: 'claude-sonnet-5-offline-snapshot',
      taskType: request.taskType,
      promptVersion: request.promptVersion,
      schemaVersion: request.schemaVersion,
      inputFingerprint: createInputFingerprint(request.input),
      usage: { inputTokens: 80, outputTokens: 30, totalTokens: 110 },
      latencyMs: 12,
      attempts: 1,
      providerRequestId: 'offline-narrative-request',
      refusal: { refused: false },
    };
  }
}

function createOfflineGateway(
  observation: NarrativeObservation,
  mode: OfflineMode = 'SUCCESS',
  enabled = true,
): AiGateway {
  return createPersistentAiGateway(loadAiConfig({ AI_ENABLED: enabled ? 'true' : 'false' }), {
    adapters: [new OfflineNarrativeAdapter(observation, mode)],
    generateAiRunId: randomUUID,
  });
}

function createMismatchedAuditGateway(): { gateway: AiGateway; aiRunId: string } {
  const aiRunId = randomUUID();
  const gateway = {
    async call<TOutput>(request: StructuredAiRequest<TOutput>): Promise<AiCallResult<TOutput>> {
      const grounded = readRequestFacts(request);
      const output = request.outputSchema.parse({
        contextFingerprint: grounded.fingerprint,
        blocks: [
          {
            kind: 'SUMMARY',
            text: 'Narrative with an audit linked to no planning run.',
            factReferences: [grounded.factIds[0]],
          },
        ],
      });
      const inputFingerprint = createInputFingerprint(request.input);
      await cds.db.tx((transaction) =>
        transaction.run(
          cds.ql.INSERT.into('trip.planner.AiRuns').entries({
            ID: aiRunId,
            planningRun_ID: null,
            status: 'SUCCEEDED',
            taskType: 'GENERATE',
            provider: 'ANTHROPIC',
            configuredModel: 'claude-sonnet-5',
            responseModel: 'claude-sonnet-5-fake-snapshot',
            promptVersion: request.promptVersion,
            schemaVersion: request.schemaVersion,
            inputFingerprint,
            startedAt: '2026-08-13T12:00:00.000Z',
            completedAt: '2026-08-13T12:00:01.000Z',
            expiresAt: '2026-09-12T12:00:00.000Z',
            refusal: false,
          }),
        ),
      );
      return {
        aiRunId,
        output,
        provider: AiProvider.ANTHROPIC,
        configuredModel: 'claude-sonnet-5',
        responseModel: 'claude-sonnet-5-fake-snapshot',
        taskType: AiTaskType.GENERATE,
        promptVersion: request.promptVersion,
        schemaVersion: request.schemaVersion,
        inputFingerprint,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        latencyMs: 1,
        attempts: 1,
        refusal: { refused: false },
      };
    },
  } as unknown as AiGateway;
  return { gateway, aiRunId };
}

function createInvalidPersistenceGateway(): AiGateway {
  return {
    async call<TOutput>(request: StructuredAiRequest<TOutput>): Promise<AiCallResult<TOutput>> {
      const grounded = readRequestFacts(request);
      return {
        aiRunId: 'not-a-valid-ai-run-uuid',
        output: request.outputSchema.parse({
          contextFingerprint: grounded.fingerprint,
          blocks: [
            {
              kind: 'SUMMARY',
              text: 'Valid structured output with an invalid persistence identifier.',
              factReferences: [grounded.factIds[0]],
            },
          ],
        }),
        provider: AiProvider.ANTHROPIC,
        configuredModel: 'claude-sonnet-5',
        responseModel: 'claude-sonnet-5-fake-snapshot',
        taskType: AiTaskType.GENERATE,
        promptVersion: request.promptVersion,
        schemaVersion: request.schemaVersion,
        inputFingerprint: createInputFingerprint(request.input),
        refusal: { refused: false },
      };
    },
  } as AiGateway;
}

function narrativeActionUrl(rankedOptionId: string): string {
  return `/trip-planner/RankedOptions(${rankedOptionId})/TripPlannerService.generateNarrative`;
}

async function readCollection<T>(entity: string, field: string, ID: string): Promise<T[]> {
  const filter = encodeURIComponent(`${field} eq ${ID}`);
  const response = await GET(`/trip-planner/${entity}?$filter=${filter}&$orderby=sequence`);
  return (response.data as ODataCollection<T>).value;
}

async function readAllInternal(entity: string): Promise<unknown[]> {
  return cds.db.run(cds.ql.SELECT.from(`trip.planner.${entity}`)) as Promise<unknown[]>;
}

async function createPlannedOption(currency = 'PLN'): Promise<{
  planningRunId: string;
  option: RankedOptionResponse;
}> {
  const created = await POST('/trip-planner/TripRequests', {
    ...referenceTripRequestODataPayload,
    currency,
  });
  const tripRequestId = String(created.data.ID);
  await POST(
    `/trip-planner/TripRequests(${tripRequestId})/TripPlannerService.confirmConstraints`,
    {},
  );
  const planned = await POST(
    `/trip-planner/TripRequests(${tripRequestId})/TripPlannerService.startPlanning`,
    {},
  );
  const planningRunId = String(planned.data.ID);
  const filter = encodeURIComponent(`planningRun_ID eq ${planningRunId}`);
  const optionsResponse = await GET(`/trip-planner/RankedOptions?$filter=${filter}&$orderby=rank`);
  const options = (optionsResponse.data as ODataCollection<RankedOptionResponse>).value;
  const option = options[0];
  if (option === undefined) throw new Error('Planning fixture produced no ranked option.');
  return { planningRunId, option };
}

async function withHardTimeout<T>(operation: Promise<T>, timeoutMs = 5_000): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(
      () => reject(new Error(`Narrative CAP/SQLite test exceeded ${timeoutMs} ms.`)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([operation, deadline]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

beforeAll(async () => {
  await test;
  const service = cds.services.TripPlannerService as unknown as NarrativeServiceSeam | undefined;
  if (service === undefined) throw new Error('TripPlannerService was not started.');
  narrativeService = service;
  originalGatewayFactory = service.createNarrativeGateway;
  service.after('generateNarrative', (_result: unknown, request: Request) => {
    if (request.headers[forceProductRollbackHeader] === 'true') {
      throw new Error('Intentional narrative product rollback.');
    }
  });
});

beforeEach(async () => {
  await test.data.reset();
  narrativeService.createNarrativeGateway = originalGatewayFactory;
});

afterEach(() => {
  narrativeService.createNarrativeGateway = originalGatewayFactory;
});

describe('grounded option narrative CAP use case', () => {
  it('carries accepted EUR through planning into code-formatted grounded money', async () => {
    const { option } = await createPlannedOption('EUR');
    const observation: NarrativeObservation = { adapterCalls: 0 };
    narrativeService.createNarrativeGateway = () => createOfflineGateway(observation);

    await withHardTimeout(POST(narrativeActionUrl(option.ID), {}));

    expect(option.currency).toBe('EUR');
    expect(Number(option.budgetLimitMinor)).toBe(450_000);
    expect(observation.budgetSummary).toMatchObject({
      currency: 'EUR',
      currencyContractVersion: 'currency-fraction-digits-v1',
      budgetLimitMinor: '450000',
      budgetLimitDisplay: '4,500.00 EUR',
    });
    expect(
      [
        'confirmedAmountDisplay',
        'estimatedAmountDisplay',
        'totalAmountDisplay',
        'costPerPersonDisplay',
        'remainingBudgetDisplay',
      ].every((field) => String(observation.budgetSummary?.[field]).endsWith(' EUR')),
    ).toBe(true);
  });

  it('uses GENERATE outside the product transaction and persists exact narrative linkage', async () => {
    const { planningRunId, option } = await createPlannedOption();
    const observation: NarrativeObservation = { adapterCalls: 0 };
    narrativeService.createNarrativeGateway = () => createOfflineGateway(observation);

    const response = await withHardTimeout(POST(narrativeActionUrl(option.ID), {}));
    const narrativeRun = response.data as NarrativeRunResponse;
    const blocks = await readCollection<OptionNarrativeResponse>(
      'OptionNarratives',
      'narrativeRun_ID',
      narrativeRun.ID,
    );
    const references = await readCollection<FactReferenceResponse>(
      'NarrativeFactReferences',
      'narrativeRun_ID',
      narrativeRun.ID,
    );
    const aiRun = await readAiRun(narrativeRun.aiRunId);

    expect(observation).toMatchObject({
      adapterCalls: 1,
      profileTaskType: AiTaskType.GENERATE,
      startedSeenByAdapter: {
        status: 'STARTED',
        taskType: 'GENERATE',
        planningRun_ID: planningRunId,
      },
    });
    expect(narrativeRun).toMatchObject({
      planningRun_ID: planningRunId,
      rankedOption_ID: option.ID,
      aiRunId: observation.aiRunId,
      status: 'SUCCEEDED',
      contextVersion: 'grounded-option-context-v1',
      promptVersion: 'grounded-option-narrative-prompt-v1',
      schemaVersion: 'grounded-option-narrative-schema-v1',
      blockCount: 2,
    });
    expect(narrativeRun.contextFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(blocks).toHaveLength(2);
    expect(blocks.every((block) => block.narrativeRun_ID === narrativeRun.ID)).toBe(true);
    expect(references).toHaveLength(2);
    expect(
      references.every((reference) => observation.requestFactIds?.includes(reference.factId)),
    ).toBe(true);
    expect(aiRun).toMatchObject({
      ID: narrativeRun.aiRunId,
      planningRun_ID: planningRunId,
      status: 'SUCCEEDED',
      taskType: 'GENERATE',
      provider: 'ANTHROPIC',
      responseModel: 'claude-sonnet-5-offline-snapshot',
      errorCode: null,
    });
  });

  it('deletes an expired AiRun while keeping durable narrative product data consistent', async () => {
    const { planningRunId, option } = await createPlannedOption();
    const observation: NarrativeObservation = { adapterCalls: 0 };
    narrativeService.createNarrativeGateway = () => createOfflineGateway(observation);
    const created = await withHardTimeout(POST(narrativeActionUrl(option.ID), {}));
    const narrativeRun = created.data as NarrativeRunResponse;

    await cds.db.run(
      cds.ql.UPDATE.entity('trip.planner.AiRuns')
        .set({ expiresAt: '2026-01-01T00:00:00.000Z' })
        .where({ ID: narrativeRun.aiRunId }),
    );
    const deleted = await new CapAiRunStore().deleteExpired('2026-01-02T00:00:00.000Z');

    expect(deleted).toBe(1);
    expect(await readAiRun(narrativeRun.aiRunId)).toBeUndefined();
    const persistedRun = await GET(`/trip-planner/NarrativeRuns(${narrativeRun.ID})`);
    const blocks = await readCollection<OptionNarrativeResponse>(
      'OptionNarratives',
      'narrativeRun_ID',
      narrativeRun.ID,
    );
    const references = await readCollection<FactReferenceResponse>(
      'NarrativeFactReferences',
      'narrativeRun_ID',
      narrativeRun.ID,
    );
    expect(persistedRun.data).toMatchObject({
      ID: narrativeRun.ID,
      planningRun_ID: planningRunId,
      rankedOption_ID: option.ID,
      aiRunId: narrativeRun.aiRunId,
      status: 'SUCCEEDED',
      blockCount: blocks.length,
    });
    expect(blocks).toHaveLength(2);
    expect(references).toHaveLength(2);
    expect(
      references.every(
        (reference) =>
          reference.narrativeRun_ID === narrativeRun.ID &&
          blocks.some((block) => block.ID === reference.optionNarrative_ID),
      ),
    ).toBe(true);

    const internalRuns = (await readAllInternal('NarrativeRuns')) as Record<string, unknown>[];
    const internalBlocks = (await readAllInternal('OptionNarratives')) as Record<string, unknown>[];
    const internalReferences = (await readAllInternal('NarrativeFactReferences')) as Record<
      string,
      unknown
    >[];
    expect(internalRuns[0]).toMatchObject({ aiRunId: narrativeRun.aiRunId });
    expect(internalRuns[0]).not.toHaveProperty('aiRun_ID');
    expect(internalBlocks.every((block) => !('aiRun_ID' in block))).toBe(true);
    expect(internalReferences.every((reference) => !('aiRun_ID' in reference))).toBe(true);
  });

  it('rejects an invalid cross-context reference and leaves every deterministic option unchanged', async () => {
    const { option } = await createPlannedOption();
    const observation: NarrativeObservation = { adapterCalls: 0 };
    narrativeService.createNarrativeGateway = () =>
      createOfflineGateway(observation, 'INVALID_REFERENCE');

    await expect(withHardTimeout(POST(narrativeActionUrl(option.ID), {}))).rejects.toMatchObject({
      status: 502,
      response: { data: { error: { code: 'INVALID_STRUCTURED_OUTPUT' } } },
    });

    const persistedOption = await GET(`/trip-planner/RankedOptions(${option.ID})`);
    expect(persistedOption.data).toMatchObject({
      ID: option.ID,
      rank: option.rank,
      role: option.role,
      destinationCity: option.destinationCity,
      totalAmountMinor: option.totalAmountMinor,
      totalScore: option.totalScore,
    });
    expect(await readAllInternal('NarrativeRuns')).toHaveLength(0);
    expect(await readAllInternal('OptionNarratives')).toHaveLength(0);
    expect(await readAllInternal('NarrativeFactReferences')).toHaveLength(0);
    expect(await readAiRun(observation.aiRunId!)).toMatchObject({
      status: 'FAILED',
      taskType: 'GENERATE',
      errorCode: 'INVALID_STRUCTURED_OUTPUT',
    });
  });

  it('blocks the product action before audit and provider calls when live AI is not opted in', async () => {
    const { option } = await createPlannedOption();
    const observation: NarrativeObservation = { adapterCalls: 0 };
    narrativeService.createNarrativeGateway = () =>
      createOfflineGateway(observation, 'SUCCESS', false);

    await expect(POST(narrativeActionUrl(option.ID), {})).rejects.toMatchObject({
      status: 503,
      response: { data: { error: { code: 'AI_DISABLED' } } },
    });

    expect(observation.adapterCalls).toBe(0);
    expect(await readAllInternal('AiRuns')).toHaveLength(0);
    expect(await readAllInternal('NarrativeRuns')).toHaveLength(0);
    await expect(GET(`/trip-planner/RankedOptions(${option.ID})`)).resolves.toMatchObject({
      data: { ID: option.ID, destinationCity: option.destinationCity },
    });
  });

  it('keeps SUCCEEDED audit committed when the later narrative product write rolls back', async () => {
    const { option } = await createPlannedOption();
    const observation: NarrativeObservation = { adapterCalls: 0 };
    narrativeService.createNarrativeGateway = () => createOfflineGateway(observation);

    await expect(
      withHardTimeout(
        POST(
          narrativeActionUrl(option.ID),
          {},
          { headers: { [forceProductRollbackHeader]: 'true' } },
        ),
      ),
    ).rejects.toMatchObject({ status: 500 });

    expect(observation).toMatchObject({
      adapterCalls: 1,
      startedSeenByAdapter: { status: 'STARTED' },
    });
    expect(await readAiRun(observation.aiRunId!)).toMatchObject({
      status: 'SUCCEEDED',
      taskType: 'GENERATE',
    });
    expect(await readAllInternal('NarrativeRuns')).toHaveLength(0);
    expect(await readAllInternal('OptionNarratives')).toHaveLength(0);
    expect(await readAllInternal('NarrativeFactReferences')).toHaveLength(0);
  });

  it('maps provider failure safely without changing the option or persisting a narrative', async () => {
    const { option } = await createPlannedOption();
    const observation: NarrativeObservation = { adapterCalls: 0 };
    narrativeService.createNarrativeGateway = () =>
      createOfflineGateway(observation, 'PROVIDER_FAILURE');

    await expect(POST(narrativeActionUrl(option.ID), {})).rejects.toMatchObject({
      status: 502,
      response: { data: { error: { code: 'PROVIDER_UNAVAILABLE' } } },
    });

    expect(await readAiRun(observation.aiRunId!)).toMatchObject({
      status: 'FAILED',
      errorCode: 'PROVIDER_UNAVAILABLE',
    });
    expect(await readAllInternal('NarrativeRuns')).toHaveLength(0);
    await expect(GET(`/trip-planner/RankedOptions(${option.ID})`)).resolves.toMatchObject({
      data: { ID: option.ID, totalAmountMinor: option.totalAmountMinor },
    });
  });

  it('fails closed before the provider when durable STARTED cannot be recorded', async () => {
    const { option } = await createPlannedOption();
    const observation: NarrativeObservation = { adapterCalls: 0 };
    const failingStore: AiRunStore = {
      insertStarted: () => Promise.reject(new Error('Offline audit insert failure.')),
      completeSucceeded: () => Promise.resolve(),
      completeFailed: () => Promise.resolve(),
      deleteExpired: () => Promise.resolve(0),
    };
    narrativeService.createNarrativeGateway = () =>
      createPersistentAiGateway(loadAiConfig({ AI_ENABLED: 'true' }), {
        adapters: [new OfflineNarrativeAdapter(observation, 'SUCCESS')],
        store: failingStore,
      });

    await expect(POST(narrativeActionUrl(option.ID), {})).rejects.toMatchObject({
      status: 500,
      response: { data: { error: { code: 'AI_AUDIT_FAILED' } } },
    });

    expect(observation.adapterCalls).toBe(0);
    expect(await readAllInternal('NarrativeRuns')).toHaveLength(0);
    await expect(GET(`/trip-planner/RankedOptions(${option.ID})`)).resolves.toMatchObject({
      data: { ID: option.ID, role: option.role },
    });
  });

  it('rejects product persistence when a terminal AI audit belongs to another context', async () => {
    const { option } = await createPlannedOption();
    const mismatched = createMismatchedAuditGateway();
    narrativeService.createNarrativeGateway = () => mismatched.gateway;

    await expect(POST(narrativeActionUrl(option.ID), {})).rejects.toMatchObject({
      status: 500,
      response: { data: { error: { code: 'INVALID_NARRATIVE_AUDIT_LINK' } } },
    });

    expect(await readAiRun(mismatched.aiRunId)).toMatchObject({
      status: 'SUCCEEDED',
      taskType: 'GENERATE',
      planningRun_ID: null,
    });
    expect(await readAllInternal('NarrativeRuns')).toHaveLength(0);
    expect(await readAllInternal('OptionNarratives')).toHaveLength(0);
    expect(await readAllInternal('NarrativeFactReferences')).toHaveLength(0);
  });

  it.each([
    ['PlanningRun scoringVersion', 'PlanningRuns', 'ID', 'planningRun', 'scoringVersion'],
    [
      'RankedOption providerFixtureVersion',
      'RankedOptions',
      'ID',
      'rankedOption',
      'providerFixtureVersion',
    ],
    [
      'BudgetItem scoringVersion',
      'BudgetItems',
      'rankedOption_ID',
      'rankedOption',
      'scoringVersion',
    ],
    [
      'SourceSnapshot providerFixtureVersion',
      'SourceSnapshots',
      'rankedOption_ID',
      'rankedOption',
      'providerFixtureVersion',
    ],
  ] as const)(
    'fails closed before the provider for inconsistent %s lineage',
    async (_case, entity, key, target, field) => {
      const { planningRunId, option } = await createPlannedOption();
      const targetId = target === 'planningRun' ? planningRunId : option.ID;
      await cds.db.run(
        cds.ql.UPDATE.entity(`trip.planner.${entity}`)
          .set({ [field]: 'corrupt-lineage-version' })
          .where({ [key]: targetId }),
      );
      let gatewayCreations = 0;
      narrativeService.createNarrativeGateway = () => {
        gatewayCreations += 1;
        return createOfflineGateway({ adapterCalls: 0 });
      };

      await expect(POST(narrativeActionUrl(option.ID), {})).rejects.toMatchObject({
        status: 500,
        response: { data: { error: { code: 'INVALID_GROUNDED_OPTION_CONTEXT' } } },
      });
      expect(gatewayCreations).toBe(0);
      expect(await readAllInternal('AiRuns')).toHaveLength(0);
    },
  );

  it('maps invalid grounded provenance to HTTP 500 before constructing the gateway', async () => {
    const { option } = await createPlannedOption();
    const sourceSnapshots = (await readAllInternal('SourceSnapshots')) as Array<{
      ID: string;
      rankedOption_ID: string;
      contexts: string;
    }>;
    const source = sourceSnapshots.find(
      (candidate) =>
        candidate.rankedOption_ID === option.ID && candidate.contexts.includes('TRANSPORT_FACT'),
    );
    if (source === undefined) throw new Error('Planning fixture has no transport source context.');
    await cds.db.run(
      cds.ql.UPDATE.entity('trip.planner.SourceSnapshots')
        .set({ contexts: source.contexts.replace('TRANSPORT_FACT', 'REMOVED_TRANSPORT_FACT') })
        .where({ ID: source.ID }),
    );
    let gatewayCreations = 0;
    narrativeService.createNarrativeGateway = () => {
      gatewayCreations += 1;
      return createOfflineGateway({ adapterCalls: 0 });
    };

    await expect(POST(narrativeActionUrl(option.ID), {})).rejects.toMatchObject({
      status: 500,
      response: { data: { error: { code: 'INVALID_GROUNDED_OPTION_CONTEXT' } } },
    });
    expect(gatewayCreations).toBe(0);
    expect(await readAllInternal('AiRuns')).toHaveLength(0);
  });

  it('maps invalid narrative persistence to HTTP 500', async () => {
    const { option } = await createPlannedOption();
    narrativeService.createNarrativeGateway = createInvalidPersistenceGateway;

    await expect(POST(narrativeActionUrl(option.ID), {})).rejects.toMatchObject({
      status: 500,
      response: { data: { error: { code: 'INVALID_NARRATIVE_PERSISTENCE' } } },
    });
    expect(await readAllInternal('NarrativeRuns')).toHaveLength(0);
    expect(await readAllInternal('OptionNarratives')).toHaveLength(0);
    expect(await readAllInternal('NarrativeFactReferences')).toHaveLength(0);
  });

  it('rejects a missing option before constructing the gateway', async () => {
    let gatewayCreations = 0;
    narrativeService.createNarrativeGateway = () => {
      gatewayCreations += 1;
      return createOfflineGateway({ adapterCalls: 0 });
    };

    await expect(POST(narrativeActionUrl(randomUUID()), {})).rejects.toMatchObject({
      status: 404,
      response: { data: { error: { code: 'RANKED_OPTION_NOT_FOUND' } } },
    });
    expect(gatewayCreations).toBe(0);
    expect(await readAllInternal('AiRuns')).toHaveLength(0);
  });
});
