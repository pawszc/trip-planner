import { randomUUID } from 'node:crypto';
import type { Request } from '@sap/cds';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AiGateway } from '../../srv/ai/ai-gateway.ts';
import { loadAiConfig } from '../../srv/ai/config.ts';
import { createPersistentAiGateway } from '../../srv/ai/create-persistent-ai-gateway.ts';
import {
  AiProvider,
  AiTaskType,
  createInputFingerprint,
  type AiCallResult,
  type AiExecutionProfile,
  type StructuredAiAdapter,
  type StructuredAiRequest,
} from '../../srv/ai/contracts.ts';
import { AiError, type AiErrorCode } from '../../srv/ai/errors.ts';
import { CapAiRunStore } from '../../srv/ai/persistence/cap-ai-run-store.ts';
import type {
  AiRunFailedUpdate,
  AiRunStartedRecord,
  AiRunStore,
  AiRunSucceededUpdate,
} from '../../srv/ai/persistence/ai-run-store.ts';
import type { AiOperationalSignalSink, AiPreStartFailureSignal } from '../../srv/ai/telemetry.ts';
import { NARRATIVE_JUDGE_DIMENSIONS } from '../../srv/narratives/narrative-judge.ts';
import { NARRATIVE_MODEL_VIEW_VERSION } from '../../srv/narratives/narrative-model-view.ts';
import { NARRATIVE_QUALITY_RUBRIC_FINGERPRINT } from '../../srv/narratives/narrative-quality-rubric.ts';
import {
  NARRATIVE_CONSTRAINT_SNAPSHOT_VERSION,
  NARRATIVE_JUDGE_PROMPT_VERSION,
  NARRATIVE_JUDGE_SCHEMA_VERSION,
  NARRATIVE_MODEL_PROFILE_VERSION,
  NARRATIVE_PRICE_CATALOG_VERSION,
  NARRATIVE_PUBLICATION_POLICY_VERSION,
  NARRATIVE_QUALITY_CONTEXT_VERSION,
  NARRATIVE_QUALITY_DATASET_VERSION,
  NARRATIVE_QUALITY_RUBRIC_VERSION,
  NARRATIVE_SAFETY_PRECHECK_VERSION,
} from '../../srv/narratives/narrative-quality-versions.ts';
import {
  OPTION_NARRATIVE_PROMPT_VERSION,
  OPTION_NARRATIVE_SCHEMA_VERSION,
} from '../../srv/narratives/option-narrative.ts';
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
const test = cds.test('serve', 'all', '--from', 'db,srv', '--in-memory').in(process.cwd());
const { GET, POST } = test;

const PUBLISHED_SUMMARY = 'The option is described from the exact deterministic planning facts.';
const PUBLISHED_RISK = 'The source snapshots are demonstration data, not current availability.';
const forceRollbackHeader = 'x-test-force-quality-gate-rollback';
const RAW_STARTED_ERROR_SENTINEL = 'RAW_STARTED_ERROR_SENTINEL must never be emitted';

type Scenario =
  | 'PUBLISH'
  | 'PRECHECK_REJECT'
  | 'SEMANTIC_REJECT'
  | 'INVALID_JUDGE_OUTPUT'
  | 'MODEL_REFUSAL'
  | 'AI_TIMEOUT'
  | 'PROVIDER_UNAVAILABLE';

interface AdapterCallObservation {
  readonly taskType: string;
  readonly provider: string;
  readonly aiRunId: string;
  readonly durableStatusSeenByAdapter: string | null;
}

interface NarrativeServiceSeam {
  createNarrativeGateway(): AiGateway;
  after(event: string, handler: (result: unknown, request: Request) => void): void;
}

interface PlannedOption {
  readonly planningRunId: string;
  readonly rankedOptionId: string;
}

interface ModelViewInput {
  readonly groundedContextFingerprint: string;
  readonly facts: readonly { readonly factId: string }[];
}

interface QualityContextInput {
  readonly fingerprint: string;
  readonly narrativeFingerprint: string;
}

let narrativeService: NarrativeServiceSeam;
let originalGatewayFactory: () => AiGateway;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null;
}

function requireModelView(input: unknown): ModelViewInput {
  if (
    !isRecord(input) ||
    typeof input.groundedContextFingerprint !== 'string' ||
    !Array.isArray(input.facts) ||
    input.facts.length < 2 ||
    !input.facts.every((fact) => isRecord(fact) && typeof fact.factId === 'string')
  ) {
    throw new Error('Offline GENERATE adapter received no valid narrative model view.');
  }
  return input as unknown as ModelViewInput;
}

function requireQualityContext(input: unknown): QualityContextInput {
  if (
    !isRecord(input) ||
    typeof input.fingerprint !== 'string' ||
    typeof input.narrativeFingerprint !== 'string'
  ) {
    throw new Error('Offline JUDGE adapter received no valid quality context.');
  }
  return input as unknown as QualityContextInput;
}

function judgeFailure(scenario: Scenario): AiErrorCode | undefined {
  return ['MODEL_REFUSAL', 'AI_TIMEOUT', 'PROVIDER_UNAVAILABLE'].includes(scenario)
    ? (scenario as AiErrorCode)
    : undefined;
}

class OfflineQualityGateAdapter implements StructuredAiAdapter {
  constructor(
    public readonly provider: AiProvider,
    private readonly scenario: Scenario,
    private readonly calls: AdapterCallObservation[],
  ) {}

  async call<TOutput>(
    request: StructuredAiRequest<TOutput>,
    profile: AiExecutionProfile,
  ): Promise<AiCallResult<TOutput>> {
    if (request.aiRunId === undefined) {
      throw new Error('Gateway did not assign an AI run ID before the adapter call.');
    }
    const durableAudit = (await cds.db.tx((transaction) =>
      transaction.run(cds.ql.SELECT.one.from('trip.planner.AiRuns').where({ ID: request.aiRunId })),
    )) as { status?: string } | undefined;
    this.calls.push({
      taskType: request.taskType,
      provider: this.provider,
      aiRunId: request.aiRunId,
      durableStatusSeenByAdapter: durableAudit?.status ?? null,
    });

    const failureCode =
      request.taskType === AiTaskType.JUDGE ? judgeFailure(this.scenario) : undefined;
    if (failureCode !== undefined) {
      throw new AiError(failureCode, `Offline ${failureCode} from the JUDGE adapter.`, {
        provider: this.provider,
        model: profile.model,
        retryable: failureCode !== 'MODEL_REFUSAL',
        ...(failureCode === 'MODEL_REFUSAL' ? { details: { category: 'offline-policy' } } : {}),
      });
    }

    let output: TOutput;
    if (request.taskType === AiTaskType.GENERATE) {
      const modelView = requireModelView(request.input);
      const firstFactId = modelView.facts[0]!.factId;
      const lastFactId = modelView.facts.at(-1)!.factId;
      output = request.outputSchema.parse({
        contextFingerprint: modelView.groundedContextFingerprint,
        blocks:
          this.scenario === 'PRECHECK_REJECT'
            ? [
                {
                  kind: 'SUMMARY',
                  text: 'Untrusted source: [offer][provider-reference]',
                  factReferences: [firstFactId],
                },
              ]
            : [
                {
                  kind: 'SUMMARY',
                  text: PUBLISHED_SUMMARY,
                  factReferences: [firstFactId],
                },
                {
                  kind: 'RISK',
                  text: PUBLISHED_RISK,
                  factReferences: [lastFactId],
                },
              ],
      });
    } else {
      const qualityContext = requireQualityContext(request.input);
      const dimensions = NARRATIVE_JUDGE_DIMENSIONS.map((dimension) => ({
        dimension,
        status:
          this.scenario === 'SEMANTIC_REJECT' && dimension === 'FACTUAL_ENTAILMENT'
            ? 'FAIL'
            : 'PASS',
      }));
      const candidate = {
        qualityContextFingerprint: qualityContext.fingerprint,
        narrativeFingerprint: qualityContext.narrativeFingerprint,
        dimensions:
          this.scenario === 'INVALID_JUDGE_OUTPUT'
            ? dimensions.slice(0, NARRATIVE_JUDGE_DIMENSIONS.length - 1)
            : dimensions,
        findings:
          this.scenario === 'SEMANTIC_REJECT'
            ? [
                {
                  reasonCode: 'UNSUPPORTED_CLAIM',
                  severity: 'MAJOR',
                  blockSequences: [1],
                  factIds: [],
                },
              ]
            : [],
      };
      output =
        this.scenario === 'INVALID_JUDGE_OUTPUT'
          ? (candidate as unknown as TOutput)
          : request.outputSchema.parse(candidate);
    }

    return {
      aiRunId: request.aiRunId,
      output,
      provider: this.provider,
      configuredModel: profile.model,
      responseModel: `${profile.model}-offline-snapshot`,
      taskType: request.taskType,
      promptVersion: request.promptVersion,
      schemaVersion: request.schemaVersion,
      inputFingerprint: createInputFingerprint(request.input),
      usage: { inputTokens: 40, outputTokens: 20, totalTokens: 60 },
      latencyMs: 5,
      attempts: 1,
      providerRequestId: `offline-${request.taskType.toLowerCase()}`,
      refusal: { refused: false },
    };
  }
}

class MemoryOperationalSignalSink implements AiOperationalSignalSink {
  readonly signals: AiPreStartFailureSignal[] = [];

  emit(signal: AiPreStartFailureSignal): Promise<void> {
    this.signals.push(signal);
    return Promise.resolve();
  }
}

class FailNthStartedAiRunStore implements AiRunStore {
  private readonly delegate = new CapAiRunStore();
  insertAttempts = 0;

  constructor(private readonly failureAttempt: number) {}

  async insertStarted(record: AiRunStartedRecord): Promise<void> {
    this.insertAttempts += 1;
    if (this.insertAttempts === this.failureAttempt) {
      throw new Error(RAW_STARTED_ERROR_SENTINEL);
    }
    await this.delegate.insertStarted(record);
  }

  completeSucceeded(ID: string, update: AiRunSucceededUpdate): Promise<void> {
    return this.delegate.completeSucceeded(ID, update);
  }

  completeFailed(ID: string, update: AiRunFailedUpdate): Promise<void> {
    return this.delegate.completeFailed(ID, update);
  }

  deleteExpired(now: string): Promise<number> {
    return this.delegate.deleteExpired(now);
  }
}

function createOfflineGateway(scenario: Scenario, calls: AdapterCallObservation[]): AiGateway {
  return createPersistentAiGateway(loadAiConfig({ AI_ENABLED: 'true' }), {
    adapters: [
      new OfflineQualityGateAdapter(AiProvider.ANTHROPIC, scenario, calls),
      new OfflineQualityGateAdapter(AiProvider.OPENAI, scenario, calls),
    ],
    generateAiRunId: randomUUID,
  });
}

function createStartedFailureGateway(
  calls: AdapterCallObservation[],
  store: AiRunStore,
  operationalSignalSink: AiOperationalSignalSink,
  enabled = true,
): AiGateway {
  return createPersistentAiGateway(loadAiConfig({ AI_ENABLED: enabled ? 'true' : 'false' }), {
    adapters: [
      new OfflineQualityGateAdapter(AiProvider.ANTHROPIC, 'PUBLISH', calls),
      new OfflineQualityGateAdapter(AiProvider.OPENAI, 'PUBLISH', calls),
    ],
    store,
    generateAiRunId: randomUUID,
    operationalSignalSink,
  });
}

async function createPlannedOption(): Promise<PlannedOption> {
  const created = await POST('/trip-planner/TripRequests', referenceTripRequestODataPayload);
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
  const option = (await cds.db.run(
    cds.ql.SELECT.one
      .from('trip.planner.RankedOptions')
      .where({ planningRun_ID: planningRunId })
      .orderBy('rank'),
  )) as { ID: string } | undefined;
  if (option === undefined) throw new Error('Planning fixture produced no ranked option.');
  return { planningRunId, rankedOptionId: option.ID };
}

function narrativeActionUrl(rankedOptionId: string): string {
  return `/trip-planner/RankedOptions(${rankedOptionId})/TripPlannerService.generateNarrative`;
}

async function readAll<T extends Record<string, unknown>>(entity: string): Promise<T[]> {
  return cds.db.run(cds.ql.SELECT.from(`trip.planner.${entity}`)) as Promise<T[]>;
}

async function runScenario(scenario: Scenario): Promise<{
  readonly option: PlannedOption;
  readonly calls: AdapterCallObservation[];
}> {
  const option = await createPlannedOption();
  const calls: AdapterCallObservation[] = [];
  narrativeService.createNarrativeGateway = () => createOfflineGateway(scenario, calls);
  return { option, calls };
}

function expectFullVersionEvidence(row: Readonly<Record<string, unknown>>): void {
  expect(row).toMatchObject({
    contextVersion: 'grounded-option-context-v1',
    modelViewVersion: NARRATIVE_MODEL_VIEW_VERSION,
    qualityContextVersion: NARRATIVE_QUALITY_CONTEXT_VERSION,
    constraintSnapshotVersion: NARRATIVE_CONSTRAINT_SNAPSHOT_VERSION,
    safetyPrecheckVersion: NARRATIVE_SAFETY_PRECHECK_VERSION,
    generatePromptVersion: OPTION_NARRATIVE_PROMPT_VERSION,
    generateSchemaVersion: OPTION_NARRATIVE_SCHEMA_VERSION,
    judgePromptVersion: NARRATIVE_JUDGE_PROMPT_VERSION,
    judgeSchemaVersion: NARRATIVE_JUDGE_SCHEMA_VERSION,
    rubricVersion: NARRATIVE_QUALITY_RUBRIC_VERSION,
    rubricFingerprint: NARRATIVE_QUALITY_RUBRIC_FINGERPRINT,
    publicationPolicyVersion: NARRATIVE_PUBLICATION_POLICY_VERSION,
    datasetVersion: NARRATIVE_QUALITY_DATASET_VERSION,
    modelProfileVersion: NARRATIVE_MODEL_PROFILE_VERSION,
    priceCatalogVersion: NARRATIVE_PRICE_CATALOG_VERSION,
  });
}

function expectNoNarrativeProduct(): Promise<void> {
  return Promise.all([
    readAll('NarrativeRuns'),
    readAll('OptionNarratives'),
    readAll('NarrativeFactReferences'),
  ]).then(([runs, blocks, references]) => {
    expect(runs).toHaveLength(0);
    expect(blocks).toHaveLength(0);
    expect(references).toHaveLength(0);
  });
}

function expectSafePreStartSignal(
  signal: AiPreStartFailureSignal,
  taskType: 'GENERATE' | 'JUDGE',
  option: PlannedOption,
  failureCode: AiPreStartFailureSignal['failureCode'],
): void {
  expect(signal).toMatchObject({
    eventType: 'AI_PRE_START_FAILURE',
    stage: 'BEFORE_DURABLE_STARTED',
    taskType,
    failureCode,
    planningRunId: option.planningRunId,
    rankedOptionId: option.rankedOptionId,
    providerCallAttempted: false,
  });
  expect(signal).not.toHaveProperty('aiRunId');
  expect(JSON.stringify(signal)).not.toMatch(
    /RAW_STARTED_ERROR_SENTINEL|The option is described|demonstration data|candidate|instructions|rawJudge|rationale|cause|stack/iu,
  );
}

beforeAll(async () => {
  await test;
  const service = cds.services.TripPlannerService as unknown as NarrativeServiceSeam | undefined;
  if (service === undefined) throw new Error('TripPlannerService was not started.');
  narrativeService = service;
  originalGatewayFactory = service.createNarrativeGateway;
  service.after('generateNarrative', (_result: unknown, request: Request) => {
    if (request.headers[forceRollbackHeader] === 'true') {
      throw new Error('Intentional quality-gate product rollback.');
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

describe('Phase 3B3 narrative quality gate runtime', () => {
  it('publishes only after exact terminal GENERATE and JUDGE audits with complete linkage', async () => {
    const { option, calls } = await runScenario('PUBLISH');

    await expect(POST(narrativeActionUrl(option.rankedOptionId), {})).resolves.toMatchObject({
      data: { status: 'SUCCEEDED' },
    });

    expect(calls).toMatchObject([
      {
        taskType: 'GENERATE',
        provider: 'ANTHROPIC',
        durableStatusSeenByAdapter: 'STARTED',
      },
      { taskType: 'JUDGE', provider: 'OPENAI', durableStatusSeenByAdapter: 'STARTED' },
    ]);
    const aiRuns = await readAll('AiRuns');
    const reviews = await readAll('NarrativeReviewRuns');
    const narratives = await readAll('NarrativeRuns');
    const blocks = await readAll('OptionNarratives');
    const references = await readAll('NarrativeFactReferences');
    expect(aiRuns).toHaveLength(2);
    const generateAudit = aiRuns.find((run) => run.taskType === 'GENERATE');
    const judgeAudit = aiRuns.find((run) => run.taskType === 'JUDGE');
    expect(generateAudit).toMatchObject({
      ID: calls[0]!.aiRunId,
      planningRun_ID: option.planningRunId,
      status: 'SUCCEEDED',
      provider: 'ANTHROPIC',
      configuredEffort: 'low',
      configuredMaxOutputTokens: 1600,
      effectiveMaxOutputTokens: 1600,
      errorCode: null,
    });
    expect(judgeAudit).toMatchObject({
      ID: calls[1]!.aiRunId,
      planningRun_ID: option.planningRunId,
      status: 'SUCCEEDED',
      provider: 'OPENAI',
      configuredEffort: 'low',
      configuredMaxOutputTokens: 768,
      effectiveMaxOutputTokens: 768,
      errorCode: null,
    });
    expect(reviews).toHaveLength(1);
    const review = reviews[0]!;
    expect(review).toMatchObject({
      planningRun_ID: option.planningRunId,
      rankedOption_ID: option.rankedOptionId,
      generateAiRunId: generateAudit!.ID,
      judgeAiRunId: judgeAudit!.ID,
      stage: 'JUDGE',
      decision: 'PUBLISH',
      failureCode: null,
      factualEntailmentResult: 'PASS',
      referenceRelevanceResult: 'PASS',
      unknownMissingDisciplineResult: 'PASS',
      constraintRankingFidelityResult: 'PASS',
      moneyDateTimeFidelityResult: 'PASS',
      provenanceIntegrityResult: 'PASS',
      safetyInstructionIntegrityResult: 'PASS',
      relevanceAndBlockKindResult: 'PASS',
      passedDimensionCount: 8,
      failedDimensionCount: 0,
      findingCount: 0,
      majorFindingCount: 0,
      criticalFindingCount: 0,
    });
    expectFullVersionEvidence(review);
    for (const field of [
      'contextFingerprint',
      'modelViewFingerprint',
      'narrativeFingerprint',
      'qualityContextFingerprint',
    ]) {
      expect(review[field]).toMatch(/^[0-9a-f]{64}$/u);
    }

    expect(narratives).toHaveLength(1);
    const narrative = narratives[0]!;
    expect(narrative).toMatchObject({
      planningRun_ID: option.planningRunId,
      rankedOption_ID: option.rankedOptionId,
      aiRunId: generateAudit!.ID,
      judgeAiRunId: judgeAudit!.ID,
      reviewRunId: review.ID,
      status: 'SUCCEEDED',
      contextFingerprint: review.contextFingerprint,
      modelViewFingerprint: review.modelViewFingerprint,
      narrativeFingerprint: review.narrativeFingerprint,
      qualityContextFingerprint: review.qualityContextFingerprint,
      blockCount: 2,
    });
    expectFullVersionEvidence({
      ...narrative,
      generatePromptVersion: narrative.promptVersion,
      generateSchemaVersion: narrative.schemaVersion,
    });
    expect(blocks.map((block) => block.text)).toEqual([PUBLISHED_SUMMARY, PUBLISHED_RISK]);
    expect(references).toHaveLength(2);
    expect(
      references.every(
        (reference) =>
          reference.narrativeRun_ID === narrative.ID &&
          blocks.some((block) => block.ID === reference.optionNarrative_ID),
      ),
    ).toBe(true);
    expect(await readAll('NarrativeReviewFindings')).toHaveLength(0);
  });

  it('stops after GENERATE on deterministic precheck rejection and stores safe evidence only', async () => {
    const { option, calls } = await runScenario('PRECHECK_REJECT');

    await expect(POST(narrativeActionUrl(option.rankedOptionId), {})).rejects.toMatchObject({
      status: 409,
      response: { data: { error: { code: 'NARRATIVE_QUALITY_REJECTED' } } },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      taskType: 'GENERATE',
      provider: 'ANTHROPIC',
      durableStatusSeenByAdapter: 'STARTED',
    });
    expect(await readAll('AiRuns')).toMatchObject([
      { ID: calls[0]!.aiRunId, status: 'SUCCEEDED', taskType: 'GENERATE' },
    ]);
    const reviews = await readAll('NarrativeReviewRuns');
    const findings = await readAll('NarrativeReviewFindings');
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({
      planningRun_ID: option.planningRunId,
      rankedOption_ID: option.rankedOptionId,
      generateAiRunId: calls[0]!.aiRunId,
      judgeAiRunId: null,
      stage: 'PRECHECK',
      decision: 'REJECT',
      failureCode: 'PRECHECK_REJECTED',
      qualityContextFingerprint: null,
      passedDimensionCount: 0,
      failedDimensionCount: 0,
      findingCount: 1,
      majorFindingCount: 0,
      criticalFindingCount: 1,
    });
    expect(reviews[0]!.narrativeFingerprint).toMatch(/^[0-9a-f]{64}$/u);
    expectFullVersionEvidence(reviews[0]!);
    expect(findings).toMatchObject([
      {
        narrativeReviewRun_ID: reviews[0]!.ID,
        reasonCode: 'UNTRUSTED_CONTENT_EXPOSED',
        severity: 'CRITICAL',
        blockSequences: '1',
        factIds: null,
        blockSequenceCount: 1,
        factIdCount: 0,
      },
    ]);
    expect(JSON.stringify({ review: reviews[0], findings })).not.toMatch(
      /example\.com|candidate|instructions|rawJudge|rationale|sourceUrl|externalItemId/i,
    );
    await expectNoNarrativeProduct();
  });

  it('persists controlled semantic dimensions and findings without candidate text', async () => {
    const { option, calls } = await runScenario('SEMANTIC_REJECT');

    await expect(POST(narrativeActionUrl(option.rankedOptionId), {})).rejects.toMatchObject({
      status: 409,
      response: { data: { error: { code: 'NARRATIVE_QUALITY_REJECTED' } } },
    });

    expect(calls.map((call) => call.taskType)).toEqual(['GENERATE', 'JUDGE']);
    expect((await readAll('AiRuns')).map((run) => run.status)).toEqual(['SUCCEEDED', 'SUCCEEDED']);
    const reviews = await readAll('NarrativeReviewRuns');
    const findings = await readAll('NarrativeReviewFindings');
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({
      generateAiRunId: calls[0]!.aiRunId,
      judgeAiRunId: calls[1]!.aiRunId,
      stage: 'JUDGE',
      decision: 'REJECT',
      failureCode: 'SEMANTIC_REJECTED',
      factualEntailmentResult: 'FAIL',
      referenceRelevanceResult: 'PASS',
      unknownMissingDisciplineResult: 'PASS',
      constraintRankingFidelityResult: 'PASS',
      moneyDateTimeFidelityResult: 'PASS',
      provenanceIntegrityResult: 'PASS',
      safetyInstructionIntegrityResult: 'PASS',
      relevanceAndBlockKindResult: 'PASS',
      passedDimensionCount: 7,
      failedDimensionCount: 1,
      findingCount: 1,
      majorFindingCount: 1,
      criticalFindingCount: 0,
    });
    expectFullVersionEvidence(reviews[0]!);
    expect(findings).toMatchObject([
      {
        narrativeReviewRun_ID: reviews[0]!.ID,
        reasonCode: 'UNSUPPORTED_CLAIM',
        severity: 'MAJOR',
        blockSequences: '1',
        factIds: null,
      },
    ]);
    expect(JSON.stringify({ review: reviews[0], findings })).not.toContain(PUBLISHED_SUMMARY);
    await expectNoNarrativeProduct();
  });

  it('records invalid JUDGE structured output as a FAILED audit and safe technical review', async () => {
    const { option, calls } = await runScenario('INVALID_JUDGE_OUTPUT');

    await expect(POST(narrativeActionUrl(option.rankedOptionId), {})).rejects.toMatchObject({
      status: 502,
      response: { data: { error: { code: 'INVALID_STRUCTURED_OUTPUT' } } },
    });

    expect(calls.map((call) => call.taskType)).toEqual(['GENERATE', 'JUDGE']);
    const aiRuns = await readAll('AiRuns');
    expect(aiRuns.find((run) => run.taskType === 'GENERATE')).toMatchObject({
      status: 'SUCCEEDED',
      errorCode: null,
    });
    expect(aiRuns.find((run) => run.taskType === 'JUDGE')).toMatchObject({
      ID: calls[1]!.aiRunId,
      status: 'FAILED',
      errorCode: 'INVALID_STRUCTURED_OUTPUT',
    });
    const reviews = await readAll('NarrativeReviewRuns');
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({
      generateAiRunId: calls[0]!.aiRunId,
      judgeAiRunId: calls[1]!.aiRunId,
      stage: 'JUDGE',
      decision: 'REJECT',
      failureCode: 'INVALID_STRUCTURED_OUTPUT',
      passedDimensionCount: 0,
      failedDimensionCount: 0,
      findingCount: 0,
    });
    expect(await readAll('NarrativeReviewFindings')).toHaveLength(0);
    await expectNoNarrativeProduct();
  });

  it.each(['MODEL_REFUSAL', 'AI_TIMEOUT', 'PROVIDER_UNAVAILABLE'] as const)(
    'fails closed on JUDGE %s with a linked FAILED audit and no narrative',
    async (failureCode) => {
      const { option, calls } = await runScenario(failureCode);

      await expect(POST(narrativeActionUrl(option.rankedOptionId), {})).rejects.toMatchObject({
        status: 502,
        response: { data: { error: { code: failureCode } } },
      });

      expect(calls.map((call) => call.taskType)).toEqual(['GENERATE', 'JUDGE']);
      const aiRuns = await readAll('AiRuns');
      expect(aiRuns.find((run) => run.taskType === 'GENERATE')).toMatchObject({
        status: 'SUCCEEDED',
      });
      expect(aiRuns.find((run) => run.taskType === 'JUDGE')).toMatchObject({
        ID: calls[1]!.aiRunId,
        status: 'FAILED',
        errorCode: failureCode,
        retryable: failureCode !== 'MODEL_REFUSAL',
        refusal: failureCode === 'MODEL_REFUSAL',
      });
      const reviews = await readAll('NarrativeReviewRuns');
      expect(reviews).toHaveLength(1);
      expect(reviews[0]).toMatchObject({
        generateAiRunId: calls[0]!.aiRunId,
        judgeAiRunId: calls[1]!.aiRunId,
        stage: 'JUDGE',
        decision: 'REJECT',
        failureCode,
        passedDimensionCount: 0,
        failedDimensionCount: 0,
        findingCount: 0,
      });
      expectFullVersionEvidence(reviews[0]!);
      await expectNoNarrativeProduct();
    },
  );

  it('emits one safe GENERATE signal and no audit, review, or product row when STARTED fails', async () => {
    const option = await createPlannedOption();
    const calls: AdapterCallObservation[] = [];
    const sink = new MemoryOperationalSignalSink();
    const store = new FailNthStartedAiRunStore(1);
    narrativeService.createNarrativeGateway = () => createStartedFailureGateway(calls, store, sink);

    await expect(POST(narrativeActionUrl(option.rankedOptionId), {})).rejects.toMatchObject({
      status: 500,
      response: { data: { error: { code: 'AI_AUDIT_FAILED' } } },
    });

    expect(store.insertAttempts).toBe(1);
    expect(calls).toHaveLength(0);
    expect(await readAll('AiRuns')).toHaveLength(0);
    expect(await readAll('NarrativeReviewRuns')).toHaveLength(0);
    expect(await readAll('NarrativeReviewFindings')).toHaveLength(0);
    await expectNoNarrativeProduct();
    expect(sink.signals).toHaveLength(1);
    expectSafePreStartSignal(sink.signals[0]!, 'GENERATE', option, 'AI_AUDIT_FAILED');
  });

  it('keeps only the real GENERATE audit when STARTED fails before the JUDGE provider call', async () => {
    const option = await createPlannedOption();
    const calls: AdapterCallObservation[] = [];
    const sink = new MemoryOperationalSignalSink();
    const store = new FailNthStartedAiRunStore(2);
    narrativeService.createNarrativeGateway = () => createStartedFailureGateway(calls, store, sink);

    await expect(POST(narrativeActionUrl(option.rankedOptionId), {})).rejects.toMatchObject({
      status: 500,
      response: { data: { error: { code: 'AI_AUDIT_FAILED' } } },
    });

    expect(store.insertAttempts).toBe(2);
    expect(calls.map(({ taskType }) => taskType)).toEqual(['GENERATE']);
    expect(await readAll('AiRuns')).toMatchObject([
      {
        ID: calls[0]!.aiRunId,
        planningRun_ID: option.planningRunId,
        taskType: 'GENERATE',
        status: 'SUCCEEDED',
      },
    ]);
    expect(await readAll('NarrativeReviewRuns')).toHaveLength(0);
    expect(await readAll('NarrativeReviewFindings')).toHaveLength(0);
    await expectNoNarrativeProduct();
    expect(sink.signals).toHaveLength(1);
    expectSafePreStartSignal(sink.signals[0]!, 'JUDGE', option, 'AI_AUDIT_FAILED');
  });

  it('emits one safe GENERATE signal for AI_DISABLED without fake audit or review evidence', async () => {
    const option = await createPlannedOption();
    const calls: AdapterCallObservation[] = [];
    const sink = new MemoryOperationalSignalSink();
    const store = new FailNthStartedAiRunStore(99);
    narrativeService.createNarrativeGateway = () =>
      createStartedFailureGateway(calls, store, sink, false);

    await expect(POST(narrativeActionUrl(option.rankedOptionId), {})).rejects.toMatchObject({
      status: 503,
      response: { data: { error: { code: 'AI_DISABLED' } } },
    });

    expect(store.insertAttempts).toBe(0);
    expect(calls).toHaveLength(0);
    expect(await readAll('AiRuns')).toHaveLength(0);
    expect(await readAll('NarrativeReviewRuns')).toHaveLength(0);
    expect(await readAll('NarrativeReviewFindings')).toHaveLength(0);
    await expectNoNarrativeProduct();
    expect(sink.signals).toHaveLength(1);
    expectSafePreStartSignal(sink.signals[0]!, 'GENERATE', option, 'AI_DISABLED');
    expect(sink.signals[0]).not.toHaveProperty('inputFingerprint');
  });

  it('emits one controlled signal for invalid GENERATE configuration before STARTED', async () => {
    const option = await createPlannedOption();
    const calls: AdapterCallObservation[] = [];
    const sink = new MemoryOperationalSignalSink();
    const config = loadAiConfig({ AI_ENABLED: 'true' });
    const invalidConfig = {
      ...config,
      taskProfiles: {
        ...config.taskProfiles,
        GENERATE: { ...config.taskProfiles.GENERATE, maxOutputTokens: 0 },
      },
    };
    narrativeService.createNarrativeGateway = () =>
      createPersistentAiGateway(invalidConfig, {
        adapters: [
          new OfflineQualityGateAdapter(AiProvider.ANTHROPIC, 'PUBLISH', calls),
          new OfflineQualityGateAdapter(AiProvider.OPENAI, 'PUBLISH', calls),
        ],
        store: new CapAiRunStore(),
        generateAiRunId: randomUUID,
        operationalSignalSink: sink,
      });

    await expect(POST(narrativeActionUrl(option.rankedOptionId), {})).rejects.toMatchObject({
      status: 503,
      response: { data: { error: { code: 'INVALID_AI_CONFIGURATION' } } },
    });

    expect(calls).toHaveLength(0);
    expect(await readAll('AiRuns')).toHaveLength(0);
    expect(await readAll('NarrativeReviewRuns')).toHaveLength(0);
    expect(await readAll('NarrativeReviewFindings')).toHaveLength(0);
    await expectNoNarrativeProduct();
    expect(sink.signals).toHaveLength(1);
    expectSafePreStartSignal(sink.signals[0]!, 'GENERATE', option, 'INVALID_AI_CONFIGURATION');
  });

  it('does not fabricate or persist an AiRun when the generated ID is invalid', async () => {
    const option = await createPlannedOption();
    const calls: AdapterCallObservation[] = [];
    const sink = new MemoryOperationalSignalSink();
    narrativeService.createNarrativeGateway = () =>
      createPersistentAiGateway(loadAiConfig({ AI_ENABLED: 'true' }), {
        adapters: [
          new OfflineQualityGateAdapter(AiProvider.ANTHROPIC, 'PUBLISH', calls),
          new OfflineQualityGateAdapter(AiProvider.OPENAI, 'PUBLISH', calls),
        ],
        store: new CapAiRunStore(),
        generateAiRunId: () => 'RAW_FAKE_AI_RUN_ID_SENTINEL',
        operationalSignalSink: sink,
      });

    await expect(POST(narrativeActionUrl(option.rankedOptionId), {})).rejects.toMatchObject({
      status: 503,
      response: { data: { error: { code: 'INVALID_AI_CONFIGURATION' } } },
    });

    expect(calls).toHaveLength(0);
    expect(await readAll('AiRuns')).toHaveLength(0);
    expect(await readAll('NarrativeReviewRuns')).toHaveLength(0);
    expect(await readAll('NarrativeReviewFindings')).toHaveLength(0);
    await expectNoNarrativeProduct();
    expect(sink.signals).toHaveLength(1);
    expectSafePreStartSignal(sink.signals[0]!, 'GENERATE', option, 'INVALID_AI_CONFIGURATION');
    expect(JSON.stringify(sink.signals)).not.toContain('RAW_FAKE_AI_RUN_ID_SENTINEL');
  });

  it('keeps published review and narrative after both ephemeral AI audits are cleaned up', async () => {
    const { option, calls } = await runScenario('PUBLISH');
    await POST(narrativeActionUrl(option.rankedOptionId), {});
    const reviewsBefore = await readAll('NarrativeReviewRuns');
    const narrativesBefore = await readAll('NarrativeRuns');

    await cds.db.run(
      cds.ql.UPDATE.entity('trip.planner.AiRuns')
        .set({ expiresAt: '2026-01-01T00:00:00.000Z' })
        .where({ ID: { in: calls.map((call) => call.aiRunId) } }),
    );
    await expect(new CapAiRunStore().deleteExpired('2026-01-02T00:00:00.000Z')).resolves.toBe(2);

    expect(await readAll('AiRuns')).toHaveLength(0);
    expect(await readAll('NarrativeReviewRuns')).toEqual(reviewsBefore);
    expect(await readAll('NarrativeRuns')).toEqual(narrativesBefore);
    expect(await readAll('OptionNarratives')).toHaveLength(2);
    expect(await readAll('NarrativeFactReferences')).toHaveLength(2);
  });

  it('does not expose review metadata, findings, or AI audits through public OData', async () => {
    await expect(GET('/trip-planner/NarrativeReviewRuns')).rejects.toMatchObject({ status: 404 });
    await expect(GET('/trip-planner/NarrativeReviewFindings')).rejects.toMatchObject({
      status: 404,
    });
    await expect(GET('/trip-planner/AiRuns')).rejects.toMatchObject({ status: 404 });
  });

  it('persists PRODUCT_WRITE_FAILED evidence after a late product transaction rollback', async () => {
    const { option, calls } = await runScenario('PUBLISH');

    await expect(
      POST(
        narrativeActionUrl(option.rankedOptionId),
        {},
        { headers: { [forceRollbackHeader]: 'true' } },
      ),
    ).rejects.toMatchObject({ status: 500 });

    expect(calls.map((call) => call.taskType)).toEqual(['GENERATE', 'JUDGE']);
    await expect
      .poll(async () => (await readAll('NarrativeReviewRuns')).length, { timeout: 2_000 })
      .toBe(1);
    const reviews = await readAll('NarrativeReviewRuns');
    expect(reviews[0]).toMatchObject({
      generateAiRunId: calls[0]!.aiRunId,
      judgeAiRunId: calls[1]!.aiRunId,
      stage: 'JUDGE',
      decision: 'REJECT',
      failureCode: 'PRODUCT_WRITE_FAILED',
      passedDimensionCount: 0,
      failedDimensionCount: 0,
      findingCount: 0,
    });
    expect((await readAll('AiRuns')).map((run) => run.status)).toEqual(['SUCCEEDED', 'SUCCEEDED']);
    await expectNoNarrativeProduct();
  });
});
