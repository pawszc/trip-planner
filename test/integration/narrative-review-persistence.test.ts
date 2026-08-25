import { randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AiProvider, AiTaskType, createInputFingerprint } from '../../srv/ai/contracts.js';
import { CapAiRunStore } from '../../srv/ai/persistence/cap-ai-run-store.js';
import { PersistentAiRunRecorder } from '../../srv/ai/persistence/persistent-ai-run-recorder.js';
import type { AiRunTelemetryEvent } from '../../srv/ai/telemetry.js';
import {
  loadNarrativeQualityDataset,
  resolveNarrativeQualityDataset,
} from '../../srv/evals/dataset.js';
import { NARRATIVE_EVAL_CONTRACT_VERSIONS } from '../../srv/evals/report.js';
import {
  buildSyntheticNarrativeConstraintSnapshot,
  resolveSyntheticNarrativeQualityFixture,
} from '../../srv/evals/synthetic-fixtures-v2.js';
import { CapNarrativeReviewStore } from '../../srv/narratives/cap-narrative-review-store.js';
import { CapNarrativeReviewWriter } from '../../srv/narratives/cap-narrative-review-writer.js';
import type { GroundedOptionContext } from '../../srv/narratives/grounded-option-context.js';
import {
  NARRATIVE_FINALIZATION_VERSION,
  finalizeNarrativeOutput,
} from '../../srv/narratives/narrative-finalization.js';
import {
  buildNarrativeGenerationView,
  NARRATIVE_GENERATION_VIEW_VERSION,
} from '../../srv/narratives/narrative-generation-view.js';
import {
  buildNarrativeModelView,
  NARRATIVE_MODEL_VIEW_VERSION,
} from '../../srv/narratives/narrative-model-view.js';
import { createNarrativeJudgeRequest } from '../../srv/narratives/narrative-judge.js';
import { buildNarrativePersistenceBundle } from '../../srv/narratives/narrative-persistence.js';
import { buildNarrativeQualityContext } from '../../srv/narratives/narrative-quality-context.js';
import { NARRATIVE_QUALITY_RUBRIC_FINGERPRINT } from '../../srv/narratives/narrative-quality-rubric.js';
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
  createOptionNarrativeRequest,
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
  generationViewVersion: NARRATIVE_GENERATION_VIEW_VERSION,
  finalizationVersion: NARRATIVE_FINALIZATION_VERSION,
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
    configuredMaxOutputTokens: isGenerate ? 1_600 : 2_048,
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

async function seedExactSyntheticOptionLineage(
  context: GroundedOptionContext,
): Promise<PlannedOption> {
  const source = await createPlannedOption();
  const sourcePlanningRun = (await cds.db.run(
    cds.ql.SELECT.one.from('trip.planner.PlanningRuns').where({ ID: source.planningRunId }),
  )) as Record<string, unknown> | undefined;
  const sourceRankedOption = (await cds.db.run(
    cds.ql.SELECT.one.from('trip.planner.RankedOptions').where({ ID: source.rankedOptionId }),
  )) as Record<string, unknown> | undefined;
  if (sourcePlanningRun === undefined || sourceRankedOption === undefined) {
    throw new Error('Production planning seed has no complete persisted lineage.');
  }

  await cds.db.run(
    cds.ql.INSERT.into('trip.planner.PlanningRuns').entries({
      ...sourcePlanningRun,
      ID: context.planningRun.id,
      requestFingerprint: context.planningRun.requestFingerprint,
      currencyContractVersion: context.planningRun.currencyContractVersion,
      providerFixtureVersion: context.planningRun.providerFixtureVersion,
      engineVersion: context.planningRun.engineVersion,
      scoringVersion: context.planningRun.scoringVersion,
    }),
  );
  await cds.db.run(
    cds.ql.INSERT.into('trip.planner.RankedOptions').entries({
      ...sourceRankedOption,
      ID: context.rankedOption.id,
      planningRun_ID: context.planningRun.id,
      providerFixtureVersion: context.planningRun.providerFixtureVersion,
      scoringVersion: context.planningRun.scoringVersion,
      rank: context.rankedOption.rank,
      role: context.rankedOption.role,
    }),
  );

  return {
    planningRunId: context.planningRun.id,
    rankedOptionId: context.rankedOption.id,
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
      rubricFingerprint: NARRATIVE_QUALITY_RUBRIC_FINGERPRINT,
      stage: 'PRECHECK',
      failureCode: 'PRECHECK_REJECTED',
      findings: [
        {
          dimension: 'SAFETY_INSTRUCTION_INTEGRITY',
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
      dimension: 'SAFETY_INSTRUCTION_INTEGRITY',
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

  it('persists the exact frozen E2E lineage through production builders and survives audit cleanup', async () => {
    const dataset = loadNarrativeQualityDataset();
    const resolved = resolveNarrativeQualityDataset(
      dataset,
      resolveSyntheticNarrativeQualityFixture,
    );
    const authoredE2e = dataset.endToEndCases.find(({ id }) => id === 'E01');
    const authoredContext = dataset.contexts.find(({ id }) => id === authoredE2e?.contextId);
    const e2eCase = resolved.endToEndCases.find(({ authored }) => authored.id === 'E01');
    const frozenCandidateCase = resolved.cases.find(({ authored }) => authored.id === 'P01');
    if (
      authoredE2e === undefined ||
      authoredContext === undefined ||
      e2eCase === undefined ||
      frozenCandidateCase === undefined
    ) {
      throw new Error('Frozen E01/P01 publication fixture is incomplete.');
    }

    // The E2E contract authors no provider output. P01 supplies the frozen provider prefix over
    // the same production-built context; code appends the exact mandatory finalization tail.
    const context = e2eCase.groundedContext;
    expect(frozenCandidateCase.authored.contextId).toBe(authoredE2e.contextId);
    expect(frozenCandidateCase.groundedContext.fingerprint).toBe(context.fingerprint);
    expect(frozenCandidateCase.candidate.contextFingerprint).toBe(context.fingerprint);

    const option = await seedExactSyntheticOptionLineage(context);
    const seededPlanningRun = (await cds.db.run(
      cds.ql.SELECT.one.from('trip.planner.PlanningRuns').where({ ID: option.planningRunId }),
    )) as Record<string, unknown> | undefined;
    const seededRankedOption = (await cds.db.run(
      cds.ql.SELECT.one.from('trip.planner.RankedOptions').where({ ID: option.rankedOptionId }),
    )) as Record<string, unknown> | undefined;
    expect(seededPlanningRun).toMatchObject({
      ID: context.planningRun.id,
      requestFingerprint: context.planningRun.requestFingerprint,
      currencyContractVersion: context.planningRun.currencyContractVersion,
      providerFixtureVersion: context.planningRun.providerFixtureVersion,
      engineVersion: context.planningRun.engineVersion,
      scoringVersion: context.planningRun.scoringVersion,
    });
    expect(seededRankedOption).toMatchObject({
      ID: context.rankedOption.id,
      planningRun_ID: context.planningRun.id,
      providerFixtureVersion: context.planningRun.providerFixtureVersion,
      scoringVersion: context.planningRun.scoringVersion,
      rank: context.rankedOption.rank,
      role: context.rankedOption.role,
    });

    const modelView = buildNarrativeModelView(context);
    const generationView = buildNarrativeGenerationView(context, modelView);
    const finalizedCandidate = finalizeNarrativeOutput({
      context,
      modelView,
      generationView,
      providerBlocks: frozenCandidateCase.candidate.blocks,
    });
    const generateRequest = createOptionNarrativeRequest(context, modelView, generationView);
    expect(generateRequest).toMatchObject({
      planningRunId: context.planningRun.id,
      rankedOptionId: context.rankedOption.id,
      input: generationView,
    });
    const qualityContext = buildNarrativeQualityContext({
      context,
      modelView,
      narrativeOutput: finalizedCandidate,
      constraints: buildSyntheticNarrativeConstraintSnapshot(authoredContext),
      versions: NARRATIVE_EVAL_CONTRACT_VERSIONS,
    });
    const judgeRequest = createNarrativeJudgeRequest(qualityContext);
    expect(judgeRequest).toMatchObject({
      planningRunId: context.planningRun.id,
      rankedOptionId: context.rankedOption.id,
      input: {
        qualityContextFingerprint: qualityContext.fingerprint,
        rubricVersion: NARRATIVE_QUALITY_RUBRIC_VERSION,
        rubricFingerprint: NARRATIVE_QUALITY_RUBRIC_FINGERPRINT,
      },
    });

    const generateAudit = {
      ...expectation('GENERATE', option.planningRunId),
      inputFingerprint: createInputFingerprint(generateRequest.input),
    };
    const judgeAudit = {
      ...expectation('JUDGE', option.planningRunId),
      inputFingerprint: createInputFingerprint(judgeRequest.input),
    };
    await persistSucceededAudit(generateAudit, AiProvider.ANTHROPIC);
    await persistSucceededAudit(judgeAudit, AiProvider.OPENAI);
    const narrativeBundle = buildNarrativePersistenceBundle({
      context,
      modelView,
      generationView,
      output: finalizedCandidate,
      aiRunId: generateAudit.ID,
      completedAt: '2026-08-15T10:00:02.000Z',
    });
    expect(narrativeBundle.expectedAiRun).toEqual(generateAudit);
    expect(narrativeBundle.narrativeRun).toMatchObject({
      planningRun_ID: context.planningRun.id,
      rankedOption_ID: context.rankedOption.id,
      aiRunId: generateAudit.ID,
      contextFingerprint: context.fingerprint,
    });
    const publication = buildNarrativeReviewPublicationBundle({
      planningRunId: option.planningRunId,
      rankedOptionId: option.rankedOptionId,
      generateAudit,
      judgeAudit,
      contextFingerprint: context.fingerprint,
      modelViewFingerprint: modelView.fingerprint,
      narrativeFingerprint: qualityContext.narrativeFingerprint,
      qualityContextFingerprint: qualityContext.fingerprint,
      versions: NARRATIVE_EVAL_CONTRACT_VERSIONS,
      dimensions: allPassDimensions(),
      narrativeBundle,
      completedAt: '2026-08-15T10:00:02.000Z',
    });

    await cds.db.tx((transaction) =>
      new CapNarrativeReviewWriter().writePublication(transaction, publication),
    );

    const reviews = await readAll('NarrativeReviewRuns');
    const narratives = await readAll('NarrativeRuns');
    const blocks = await readAll('OptionNarratives');
    const references = await readAll('NarrativeFactReferences');
    const audits = await readAll('AiRuns');
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({
      planningRun_ID: context.planningRun.id,
      rankedOption_ID: context.rankedOption.id,
      generateAiRunId: generateAudit.ID,
      judgeAiRunId: judgeAudit.ID,
      contextFingerprint: context.fingerprint,
      modelViewFingerprint: modelView.fingerprint,
      narrativeFingerprint: qualityContext.narrativeFingerprint,
      qualityContextFingerprint: qualityContext.fingerprint,
      rubricFingerprint: NARRATIVE_QUALITY_RUBRIC_FINGERPRINT,
      decision: 'PUBLISH',
      passedDimensionCount: 8,
      failedDimensionCount: 0,
      findingCount: 0,
    });
    expect(await readAll('NarrativeReviewFindings')).toHaveLength(0);
    expect(narratives).toHaveLength(1);
    expect(narratives[0]).toMatchObject({
      planningRun_ID: context.planningRun.id,
      rankedOption_ID: context.rankedOption.id,
      aiRunId: generateAudit.ID,
      judgeAiRunId: judgeAudit.ID,
      reviewRunId: publication.reviewRun.ID,
      contextFingerprint: context.fingerprint,
      modelViewFingerprint: modelView.fingerprint,
      narrativeFingerprint: qualityContext.narrativeFingerprint,
      qualityContextFingerprint: qualityContext.fingerprint,
      modelViewVersion: NARRATIVE_MODEL_VIEW_VERSION,
      generationViewVersion: NARRATIVE_GENERATION_VIEW_VERSION,
      finalizationVersion: NARRATIVE_FINALIZATION_VERSION,
      qualityContextVersion: NARRATIVE_QUALITY_CONTEXT_VERSION,
      rubricVersion: NARRATIVE_QUALITY_RUBRIC_VERSION,
      rubricFingerprint: NARRATIVE_QUALITY_RUBRIC_FINGERPRINT,
      publicationPolicyVersion: NARRATIVE_PUBLICATION_POLICY_VERSION,
    });
    expect(audits).toHaveLength(2);
    expect(audits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ID: generateAudit.ID,
          planningRun_ID: context.planningRun.id,
          taskType: 'GENERATE',
          inputFingerprint: createInputFingerprint(generateRequest.input),
        }),
        expect.objectContaining({
          ID: judgeAudit.ID,
          planningRun_ID: context.planningRun.id,
          taskType: 'JUDGE',
          inputFingerprint: createInputFingerprint(judgeRequest.input),
        }),
      ]),
    );
    expect(blocks).toHaveLength(finalizedCandidate.blocks.length);
    for (const [blockIndex, expectedBlock] of finalizedCandidate.blocks.entries()) {
      const sequence = blockIndex + 1;
      const persistedBlock = blocks.find((block) => block.sequence === sequence);
      expect(persistedBlock).toMatchObject({
        narrativeRun_ID: publication.narrativeRun.ID,
        planningRun_ID: context.planningRun.id,
        rankedOption_ID: context.rankedOption.id,
        sequence,
        kind: expectedBlock.kind,
        text: expectedBlock.text,
      });
      const persistedReferences = references
        .filter((reference) => reference.optionNarrative_ID === persistedBlock?.ID)
        .sort((left, right) => Number(left.sequence) - Number(right.sequence));
      expect(persistedReferences).toHaveLength(expectedBlock.factReferences.length);
      expect(persistedReferences.map(({ factId: persistedFactId }) => persistedFactId)).toEqual(
        expectedBlock.factReferences,
      );
      for (const reference of persistedReferences) {
        expect(reference).toMatchObject({
          narrativeRun_ID: publication.narrativeRun.ID,
          planningRun_ID: context.planningRun.id,
          rankedOption_ID: context.rankedOption.id,
        });
      }
    }
    expect(references).toHaveLength(
      finalizedCandidate.blocks.reduce((count, block) => count + block.factReferences.length, 0),
    );
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
    expect(await readAll('NarrativeReviewRuns')).toEqual([
      expect.objectContaining({
        ID: publication.reviewRun.ID,
        planningRun_ID: context.planningRun.id,
        rankedOption_ID: context.rankedOption.id,
        generateAiRunId: generateAudit.ID,
        judgeAiRunId: judgeAudit.ID,
        contextFingerprint: context.fingerprint,
        modelViewFingerprint: modelView.fingerprint,
        narrativeFingerprint: qualityContext.narrativeFingerprint,
        qualityContextFingerprint: qualityContext.fingerprint,
        rubricFingerprint: NARRATIVE_QUALITY_RUBRIC_FINGERPRINT,
      }),
    ]);
    expect(await readAll('NarrativeRuns')).toEqual([
      expect.objectContaining({
        ID: publication.narrativeRun.ID,
        reviewRunId: publication.reviewRun.ID,
        aiRunId: generateAudit.ID,
        judgeAiRunId: judgeAudit.ID,
      }),
    ]);
    expect(await readAll('OptionNarratives')).toHaveLength(blocks.length);
    expect(await readAll('NarrativeFactReferences')).toHaveLength(references.length);
  });

  it('keeps legacy AiRuns, NarrativeRuns and reviews null instead of backfilling quality evidence', async () => {
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
    await cds.db.run(
      cds.ql.INSERT.into('trip.planner.NarrativeReviewRuns').entries({
        ID: randomUUID(),
        planningRun_ID: option.planningRunId,
        rankedOption_ID: option.rankedOptionId,
        generateAiRunId: legacyAiRunId,
        contextVersion: versions.groundedContextVersion,
        contextFingerprint,
        modelViewVersion: versions.modelViewVersion,
        modelViewFingerprint,
        qualityContextVersion: versions.qualityContextVersion,
        constraintSnapshotVersion: versions.constraintSnapshotVersion,
        safetyPrecheckVersion: versions.safetyPrecheckVersion,
        generatePromptVersion: versions.generatePromptVersion,
        generateSchemaVersion: versions.generateSchemaVersion,
        judgePromptVersion: versions.judgePromptVersion,
        judgeSchemaVersion: versions.judgeSchemaVersion,
        rubricVersion: versions.rubricVersion,
        publicationPolicyVersion: versions.publicationPolicyVersion,
        datasetVersion: versions.datasetVersion,
        modelProfileVersion: versions.modelProfileVersion,
        priceCatalogVersion: versions.priceCatalogVersion,
        stage: 'GENERATE',
        decision: 'REJECT',
        failureCode: 'AI_TIMEOUT',
        passedDimensionCount: 0,
        failedDimensionCount: 0,
        findingCount: 0,
        majorFindingCount: 0,
        criticalFindingCount: 0,
        completedAt: '2026-08-14T10:00:01.000Z',
      }),
    );

    expect((await readAll('AiRuns'))[0]).toMatchObject({
      configuredEffort: null,
      configuredMaxOutputTokens: null,
      effectiveMaxOutputTokens: null,
      providerCallAttempted: null,
      validationFailureStage: null,
    });
    expect((await readAll('NarrativeRuns'))[0]).toMatchObject({
      reviewRunId: null,
      judgeAiRunId: null,
      modelViewVersion: null,
      modelViewFingerprint: null,
      generationViewVersion: null,
      finalizationVersion: null,
      narrativeFingerprint: null,
      qualityContextVersion: null,
      qualityContextFingerprint: null,
      judgePromptVersion: null,
      judgeSchemaVersion: null,
      rubricVersion: null,
      rubricFingerprint: null,
      publicationPolicyVersion: null,
      modelProfileVersion: null,
      priceCatalogVersion: null,
    });
    expect((await readAll('NarrativeReviewRuns'))[0]).toMatchObject({
      rubricVersion: NARRATIVE_QUALITY_RUBRIC_VERSION,
      rubricFingerprint: null,
      generationViewVersion: null,
      finalizationVersion: null,
    });
  });

  it('does not expose review or finding entities through public OData', async () => {
    await expect(GET('/trip-planner/NarrativeReviewRuns')).rejects.toMatchObject({ status: 404 });
    await expect(GET('/trip-planner/NarrativeReviewFindings')).rejects.toMatchObject({
      status: 404,
    });
  });
});
