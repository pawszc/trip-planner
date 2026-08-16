import { randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AiProvider, AiTaskType } from '../../srv/ai/contracts.js';
import { CapAiRunStore } from '../../srv/ai/persistence/cap-ai-run-store.js';
import { PersistentAiRunRecorder } from '../../srv/ai/persistence/persistent-ai-run-recorder.js';
import type { AiRunTelemetryEvent } from '../../srv/ai/telemetry.js';
import { CapNarrativeReviewStore } from '../../srv/narratives/cap-narrative-review-store.js';
import { CapNarrativeReviewWriter } from '../../srv/narratives/cap-narrative-review-writer.js';
import { NARRATIVE_MODEL_VIEW_VERSION } from '../../srv/narratives/narrative-model-view.js';
import type { NarrativePersistenceBundle } from '../../srv/narratives/narrative-persistence.js';
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
} from '../../srv/narratives/narrative-quality-versions.js';
import {
  NARRATIVE_REVIEW_DIMENSION_VALUES,
  buildNarrativeReviewPublicationBundle,
  buildNarrativeReviewRejectionBundle,
  type NarrativeReviewAiRunExpectation,
  type NarrativeReviewDimensionResults,
  type NarrativeReviewPersistenceVersions,
} from '../../srv/narratives/narrative-review-persistence.js';
import {
  OPTION_NARRATIVE_PROMPT_VERSION,
  OPTION_NARRATIVE_SCHEMA_VERSION,
} from '../../srv/narratives/option-narrative.js';
import { referenceTripRequestODataPayload } from '../fixtures/trip-request.js';

process.env.CDS_TYPESCRIPT = 'true';
const { default: cds } = await import('@sap/cds');
const test = cds.test('serve', 'all', '--from', 'db,srv', '--in-memory').in(process.cwd());
const { GET, POST } = test;

const aiRunStore = new CapAiRunStore();
const recorder = new PersistentAiRunRecorder(aiRunStore, 30);
const contextFingerprint = 'a'.repeat(64);
const modelViewFingerprint = 'b'.repeat(64);
const narrativeFingerprint = 'c'.repeat(64);
const qualityContextFingerprint = 'd'.repeat(64);
const generateInputFingerprint = 'e'.repeat(64);
const judgeInputFingerprint = 'f'.repeat(64);
const factId = `fact_${'1'.repeat(64)}`;

const versions = {
  groundedContextVersion: 'grounded-option-context-v1',
  modelViewVersion: NARRATIVE_MODEL_VIEW_VERSION,
  qualityContextVersion: NARRATIVE_QUALITY_CONTEXT_VERSION,
  constraintSnapshotVersion: NARRATIVE_CONSTRAINT_SNAPSHOT_VERSION,
  generatePromptVersion: OPTION_NARRATIVE_PROMPT_VERSION,
  generateSchemaVersion: OPTION_NARRATIVE_SCHEMA_VERSION,
  judgePromptVersion: NARRATIVE_JUDGE_PROMPT_VERSION,
  judgeSchemaVersion: NARRATIVE_JUDGE_SCHEMA_VERSION,
  rubricVersion: NARRATIVE_QUALITY_RUBRIC_VERSION,
  datasetVersion: NARRATIVE_QUALITY_DATASET_VERSION,
  publicationPolicyVersion: NARRATIVE_PUBLICATION_POLICY_VERSION,
  modelProfileVersion: NARRATIVE_MODEL_PROFILE_VERSION,
  priceCatalogVersion: NARRATIVE_PRICE_CATALOG_VERSION,
  safetyPrecheckVersion: NARRATIVE_SAFETY_PRECHECK_VERSION,
} satisfies NarrativeReviewPersistenceVersions;

interface PlannedOption {
  readonly planningRunId: string;
  readonly rankedOptionId: string;
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
  const rankedOption = (await cds.db.run(
    cds.ql.SELECT.one.from('trip.planner.RankedOptions').where({ planningRun_ID: planningRunId }),
  )) as { ID: string } | undefined;
  if (rankedOption === undefined) throw new Error('Planning fixture has no ranked option.');
  return { planningRunId, rankedOptionId: rankedOption.ID };
}

function startedEvent(
  expectation: NarrativeReviewAiRunExpectation,
  provider: AiProvider,
): AiRunTelemetryEvent {
  const isGenerate = expectation.taskType === 'GENERATE';
  return {
    aiRunId: expectation.ID,
    planningRunId: expectation.planningRun_ID,
    status: 'STARTED',
    provider,
    configuredModel: isGenerate ? 'generate-offline-v1' : 'judge-offline-v1',
    configuredEffort: 'low',
    configuredMaxOutputTokens: isGenerate ? 1_600 : 768,
    effectiveMaxOutputTokens: isGenerate ? 1_200 : 600,
    taskType: isGenerate ? AiTaskType.GENERATE : AiTaskType.JUDGE,
    promptVersion: expectation.promptVersion,
    schemaVersion: expectation.schemaVersion,
    inputFingerprint: expectation.inputFingerprint,
    startedAt: '2026-08-15T10:00:00.000Z',
  };
}

async function persistSucceededAudit(
  expectation: NarrativeReviewAiRunExpectation,
  provider: AiProvider,
): Promise<void> {
  const started = startedEvent(expectation, provider);
  await recorder.record(started);
  await recorder.record({
    ...started,
    status: 'SUCCEEDED',
    responseModel: `${started.configuredModel}-snapshot`,
    completedAt: '2026-08-15T10:00:01.000Z',
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    latencyMs: 1_000,
    attempts: 1,
    refusal: { refused: false },
    retryable: false,
  });
}

function expectation(
  taskType: 'GENERATE' | 'JUDGE',
  planningRunId: string,
): NarrativeReviewAiRunExpectation {
  return {
    ID: randomUUID(),
    planningRun_ID: planningRunId,
    status: 'SUCCEEDED',
    taskType,
    promptVersion:
      taskType === 'GENERATE' ? OPTION_NARRATIVE_PROMPT_VERSION : NARRATIVE_JUDGE_PROMPT_VERSION,
    schemaVersion:
      taskType === 'GENERATE' ? OPTION_NARRATIVE_SCHEMA_VERSION : NARRATIVE_JUDGE_SCHEMA_VERSION,
    inputFingerprint: taskType === 'GENERATE' ? generateInputFingerprint : judgeInputFingerprint,
  };
}

function allPassDimensions(): NarrativeReviewDimensionResults {
  return Object.fromEntries(
    NARRATIVE_REVIEW_DIMENSION_VALUES.map((dimension) => [dimension, 'PASS']),
  ) as NarrativeReviewDimensionResults;
}

function common(
  option: PlannedOption,
  generateAudit: NarrativeReviewAiRunExpectation,
  generateId: () => string = randomUUID,
) {
  return {
    planningRunId: option.planningRunId,
    rankedOptionId: option.rankedOptionId,
    generateAudit,
    contextFingerprint,
    modelViewFingerprint,
    narrativeFingerprint,
    qualityContextFingerprint,
    versions,
    completedAt: '2026-08-15T10:00:02.000Z',
    generateId,
  } as const;
}

function narrativeBundle(
  option: PlannedOption,
  generateAudit: NarrativeReviewAiRunExpectation,
): NarrativePersistenceBundle {
  const narrativeRunId = randomUUID();
  const blockId = randomUUID();
  return {
    expectedAiRun: generateAudit,
    narrativeRun: {
      ID: narrativeRunId,
      planningRun_ID: option.planningRunId,
      rankedOption_ID: option.rankedOptionId,
      aiRunId: generateAudit.ID,
      status: 'SUCCEEDED',
      contextVersion: versions.groundedContextVersion,
      contextFingerprint,
      promptVersion: versions.generatePromptVersion,
      schemaVersion: versions.generateSchemaVersion,
      blockCount: 1,
      completedAt: '2026-08-15T10:00:02.000Z',
    },
    optionNarratives: [
      {
        ID: blockId,
        narrativeRun_ID: narrativeRunId,
        planningRun_ID: option.planningRunId,
        rankedOption_ID: option.rankedOptionId,
        sequence: 1,
        kind: 'SUMMARY',
        text: 'Validated and judged publication text.',
      },
    ],
    factReferences: [
      {
        ID: randomUUID(),
        narrativeRun_ID: narrativeRunId,
        optionNarrative_ID: blockId,
        planningRun_ID: option.planningRunId,
        rankedOption_ID: option.rankedOptionId,
        sequence: 1,
        factId,
      },
    ],
  };
}

async function readAll(entity: string): Promise<Record<string, unknown>[]> {
  return cds.db.run(cds.ql.SELECT.from(`trip.planner.${entity}`)) as Promise<
    Record<string, unknown>[]
  >;
}

beforeAll(async () => {
  await test;
});

beforeEach(async () => {
  await test.data.reset();
});

describe('CAP/SQLite narrative review persistence', () => {
  it('keeps a safe precheck rejection after GENERATE audit cleanup and creates no product text', async () => {
    const option = await createPlannedOption();
    const generateAudit = expectation('GENERATE', option.planningRunId);
    await persistSucceededAudit(generateAudit, AiProvider.ANTHROPIC);
    const rejection = buildNarrativeReviewRejectionBundle({
      ...common(option, generateAudit),
      qualityContextFingerprint: null,
      stage: 'PRECHECK',
      failureCode: 'PRECHECK_REJECTED',
      findings: [
        {
          reasonCode: 'UNTRUSTED_CONTENT_EXPOSED',
          severity: 'CRITICAL',
          blockSequences: [1],
          factIds: [factId],
        },
      ],
    });

    await new CapNarrativeReviewStore().persistRejection(rejection);

    const reviews = await readAll('NarrativeReviewRuns');
    const findings = await readAll('NarrativeReviewFindings');
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({
      ID: rejection.reviewRun.ID,
      planningRun_ID: option.planningRunId,
      rankedOption_ID: option.rankedOptionId,
      generateAiRunId: generateAudit.ID,
      judgeAiRunId: null,
      stage: 'PRECHECK',
      decision: 'REJECT',
      failureCode: 'PRECHECK_REJECTED',
      qualityContextFingerprint: null,
      findingCount: 1,
      criticalFindingCount: 1,
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      reasonCode: 'UNTRUSTED_CONTENT_EXPOSED',
      severity: 'CRITICAL',
      blockSequences: '1',
      factIds: factId,
    });
    expect(await readAll('NarrativeRuns')).toHaveLength(0);
    expect(await readAll('OptionNarratives')).toHaveLength(0);
    expect(await readAll('NarrativeFactReferences')).toHaveLength(0);

    await cds.db.run(
      cds.ql.UPDATE.entity('trip.planner.AiRuns')
        .set({ expiresAt: '2026-01-01T00:00:00.000Z' })
        .where({ ID: generateAudit.ID }),
    );
    await expect(aiRunStore.deleteExpired('2026-01-02T00:00:00.000Z')).resolves.toBe(1);
    expect(await readAll('AiRuns')).toHaveLength(0);
    expect(await readAll('NarrativeReviewRuns')).toHaveLength(1);
    expect(await readAll('NarrativeReviewFindings')).toHaveLength(1);

    const safeReview = JSON.stringify((await readAll('NarrativeReviewRuns'))[0]);
    expect(safeReview).not.toMatch(
      /promptText|instructions|candidate|rawJudge|rationale|sourceUrl|externalItemId|credential|secret/i,
    );
  });

  it('atomically publishes review plus narrative and survives cleanup of both scalar audit links', async () => {
    const option = await createPlannedOption();
    const generateAudit = expectation('GENERATE', option.planningRunId);
    const judgeAudit = expectation('JUDGE', option.planningRunId);
    await persistSucceededAudit(generateAudit, AiProvider.ANTHROPIC);
    await persistSucceededAudit(judgeAudit, AiProvider.OPENAI);
    const publication = buildNarrativeReviewPublicationBundle({
      ...common(option, generateAudit),
      judgeAudit,
      dimensions: allPassDimensions(),
      narrativeBundle: narrativeBundle(option, generateAudit),
    });

    await cds.db.tx((transaction) =>
      new CapNarrativeReviewWriter().writePublication(transaction, publication),
    );

    const reviews = await readAll('NarrativeReviewRuns');
    const narratives = await readAll('NarrativeRuns');
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({
      generateAiRunId: generateAudit.ID,
      judgeAiRunId: judgeAudit.ID,
      decision: 'PUBLISH',
      passedDimensionCount: 8,
      failedDimensionCount: 0,
      findingCount: 0,
    });
    expect(narratives).toHaveLength(1);
    expect(narratives[0]).toMatchObject({
      aiRunId: generateAudit.ID,
      judgeAiRunId: judgeAudit.ID,
      reviewRunId: publication.reviewRun.ID,
      narrativeFingerprint,
      modelViewVersion: NARRATIVE_MODEL_VIEW_VERSION,
      qualityContextVersion: NARRATIVE_QUALITY_CONTEXT_VERSION,
      rubricVersion: NARRATIVE_QUALITY_RUBRIC_VERSION,
      publicationPolicyVersion: NARRATIVE_PUBLICATION_POLICY_VERSION,
    });
    expect(await readAll('OptionNarratives')).toHaveLength(1);
    expect(await readAll('NarrativeFactReferences')).toHaveLength(1);
    expect(reviews[0]).not.toHaveProperty('generateAiRun_ID');
    expect(reviews[0]).not.toHaveProperty('judgeAiRun_ID');
    expect(narratives[0]).not.toHaveProperty('judgeAiRun_ID');
    expect(narratives[0]).not.toHaveProperty('reviewRun_ID');

    await cds.db.run(
      cds.ql.UPDATE.entity('trip.planner.AiRuns')
        .set({ expiresAt: '2026-01-01T00:00:00.000Z' })
        .where({ ID: { in: [generateAudit.ID, judgeAudit.ID] } }),
    );
    await expect(aiRunStore.deleteExpired('2026-01-02T00:00:00.000Z')).resolves.toBe(2);
    expect(await readAll('AiRuns')).toHaveLength(0);
    expect(await readAll('NarrativeReviewRuns')).toHaveLength(1);
    expect(await readAll('NarrativeRuns')).toHaveLength(1);
    expect(await readAll('OptionNarratives')).toHaveLength(1);
    expect(await readAll('NarrativeFactReferences')).toHaveLength(1);
  });

  it('keeps legacy AiRuns and NarrativeRuns explicitly null instead of backfilling quality evidence', async () => {
    const option = await createPlannedOption();
    const legacyAiRunId = randomUUID();
    await cds.db.run(
      cds.ql.INSERT.into('trip.planner.AiRuns').entries({
        ID: legacyAiRunId,
        planningRun_ID: option.planningRunId,
        status: 'STARTED',
        taskType: 'GENERATE',
        provider: 'ANTHROPIC',
        configuredModel: 'legacy-model',
        promptVersion: OPTION_NARRATIVE_PROMPT_VERSION,
        schemaVersion: OPTION_NARRATIVE_SCHEMA_VERSION,
        inputFingerprint: generateInputFingerprint,
        startedAt: '2026-08-14T10:00:00.000Z',
        expiresAt: '2026-09-13T10:00:00.000Z',
        refusal: false,
      }),
    );
    await cds.db.run(
      cds.ql.INSERT.into('trip.planner.NarrativeRuns').entries({
        ID: randomUUID(),
        planningRun_ID: option.planningRunId,
        rankedOption_ID: option.rankedOptionId,
        aiRunId: legacyAiRunId,
        status: 'SUCCEEDED',
        contextVersion: versions.groundedContextVersion,
        contextFingerprint,
        promptVersion: OPTION_NARRATIVE_PROMPT_VERSION,
        schemaVersion: OPTION_NARRATIVE_SCHEMA_VERSION,
        blockCount: 1,
        completedAt: '2026-08-14T10:00:01.000Z',
      }),
    );

    expect((await readAll('AiRuns'))[0]).toMatchObject({
      configuredEffort: null,
      configuredMaxOutputTokens: null,
      effectiveMaxOutputTokens: null,
    });
    expect((await readAll('NarrativeRuns'))[0]).toMatchObject({
      reviewRunId: null,
      judgeAiRunId: null,
      modelViewVersion: null,
      modelViewFingerprint: null,
      narrativeFingerprint: null,
      qualityContextVersion: null,
      qualityContextFingerprint: null,
      judgePromptVersion: null,
      judgeSchemaVersion: null,
      rubricVersion: null,
      publicationPolicyVersion: null,
      modelProfileVersion: null,
      priceCatalogVersion: null,
    });
  });

  it('does not expose review or finding entities through public OData', async () => {
    await expect(GET('/trip-planner/NarrativeReviewRuns')).rejects.toMatchObject({ status: 404 });
    await expect(GET('/trip-planner/NarrativeReviewFindings')).rejects.toMatchObject({
      status: 404,
    });
  });
});
