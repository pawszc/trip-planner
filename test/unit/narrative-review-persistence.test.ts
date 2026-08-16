import { describe, expect, it } from 'vitest';
import {
  OPTION_NARRATIVE_PROMPT_VERSION,
  OPTION_NARRATIVE_SCHEMA_VERSION,
} from '../../srv/narratives/option-narrative.js';
import { NARRATIVE_MODEL_VIEW_VERSION } from '../../srv/narratives/narrative-model-view.js';
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
import type { NarrativePersistenceBundle } from '../../srv/narratives/narrative-persistence.js';
import {
  NARRATIVE_REVIEW_DIMENSION_VALUES,
  buildNarrativeReviewPublicationBundle,
  buildNarrativeReviewRejectionBundle,
  type NarrativeReviewAiRunExpectation,
  type NarrativeReviewDimensionResults,
  type NarrativeReviewPersistenceVersions,
} from '../../srv/narratives/narrative-review-persistence.js';
import {
  CapNarrativeReviewStore,
  type NarrativeReviewTransactionalDatabase,
} from '../../srv/narratives/cap-narrative-review-store.js';
import { CapNarrativeReviewWriter } from '../../srv/narratives/cap-narrative-review-writer.js';

const planningRunId = '10000000-0000-4000-8000-000000000001';
const rankedOptionId = '10000000-0000-4000-8000-000000000002';
const generateAiRunId = '10000000-0000-4000-8000-000000000003';
const judgeAiRunId = '10000000-0000-4000-8000-000000000004';
const contextFingerprint = '1'.repeat(64);
const modelViewFingerprint = '2'.repeat(64);
const narrativeFingerprint = '3'.repeat(64);
const qualityContextFingerprint = '4'.repeat(64);
const generateInputFingerprint = '5'.repeat(64);
const judgeInputFingerprint = '6'.repeat(64);
const factId = `fact_${'a'.repeat(64)}`;

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

function audit(
  taskType: 'GENERATE' | 'JUDGE',
  status: 'STARTED' | 'SUCCEEDED' | 'FAILED' = 'SUCCEEDED',
): NarrativeReviewAiRunExpectation {
  return {
    ID: taskType === 'GENERATE' ? generateAiRunId : judgeAiRunId,
    planningRun_ID: planningRunId,
    status,
    taskType,
    promptVersion:
      taskType === 'GENERATE' ? OPTION_NARRATIVE_PROMPT_VERSION : NARRATIVE_JUDGE_PROMPT_VERSION,
    schemaVersion:
      taskType === 'GENERATE' ? OPTION_NARRATIVE_SCHEMA_VERSION : NARRATIVE_JUDGE_SCHEMA_VERSION,
    inputFingerprint: taskType === 'GENERATE' ? generateInputFingerprint : judgeInputFingerprint,
  };
}

function dimensions(failed?: (typeof NARRATIVE_REVIEW_DIMENSION_VALUES)[number]) {
  return Object.fromEntries(
    NARRATIVE_REVIEW_DIMENSION_VALUES.map((dimension) => [
      dimension,
      dimension === failed ? 'FAIL' : 'PASS',
    ]),
  ) as NarrativeReviewDimensionResults;
}

function generatedIds() {
  let sequence = 0;
  return () => `20000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`;
}

function common() {
  return {
    planningRunId,
    rankedOptionId,
    generateAudit: audit('GENERATE'),
    contextFingerprint,
    modelViewFingerprint,
    narrativeFingerprint,
    qualityContextFingerprint,
    versions,
    completedAt: '2026-08-15T10:00:00.000Z',
    generateId: generatedIds(),
  } as const;
}

function narrativeBundle(): NarrativePersistenceBundle {
  const narrativeRunId = '30000000-0000-4000-8000-000000000001';
  const blockId = '30000000-0000-4000-8000-000000000002';
  return {
    expectedAiRun: {
      ID: generateAiRunId,
      planningRun_ID: planningRunId,
      status: 'SUCCEEDED',
      taskType: 'GENERATE',
      promptVersion: OPTION_NARRATIVE_PROMPT_VERSION,
      schemaVersion: OPTION_NARRATIVE_SCHEMA_VERSION,
      inputFingerprint: generateInputFingerprint,
    },
    narrativeRun: {
      ID: narrativeRunId,
      planningRun_ID: planningRunId,
      rankedOption_ID: rankedOptionId,
      aiRunId: generateAiRunId,
      status: 'SUCCEEDED',
      contextVersion: versions.groundedContextVersion,
      contextFingerprint,
      promptVersion: OPTION_NARRATIVE_PROMPT_VERSION,
      schemaVersion: OPTION_NARRATIVE_SCHEMA_VERSION,
      blockCount: 1,
      completedAt: '2026-08-15T10:00:00.000Z',
    },
    optionNarratives: [
      {
        ID: blockId,
        narrativeRun_ID: narrativeRunId,
        planningRun_ID: planningRunId,
        rankedOption_ID: rankedOptionId,
        sequence: 1,
        kind: 'SUMMARY',
        text: 'Exact locally validated candidate.',
      },
    ],
    factReferences: [
      {
        ID: '30000000-0000-4000-8000-000000000003',
        narrativeRun_ID: narrativeRunId,
        optionNarrative_ID: blockId,
        planningRun_ID: planningRunId,
        rankedOption_ID: rankedOptionId,
        sequence: 1,
        factId,
      },
    ],
  };
}

function persistedAudit(expectation: NarrativeReviewAiRunExpectation) {
  return { ...expectation };
}

class FakeDatabase implements NarrativeReviewTransactionalDatabase {
  readonly queries: object[] = [];
  readonly results: unknown[] = [];
  transactions = 0;

  async tx<T>(handler: (transaction: { run(query: object): Promise<unknown> }) => Promise<T>) {
    this.transactions += 1;
    return handler({
      run: async (query) => {
        this.queries.push(query);
        const result = this.results.shift();
        if (result instanceof Error) throw result;
        return result;
      },
    });
  }
}

describe('narrative review persistence bundles', () => {
  it('builds a precheck rejection with safe metadata and no candidate or raw content', () => {
    const unsafeInput = {
      ...common(),
      stage: 'PRECHECK',
      failureCode: 'PRECHECK_REJECTED',
      qualityContextFingerprint: null,
      findings: [
        {
          reasonCode: 'UNTRUSTED_CONTENT_EXPOSED',
          severity: 'CRITICAL',
          blockSequences: [2, 1],
          factIds: [factId],
          rationale: 'raw judge rationale must be dropped',
        },
      ],
      candidate: 'private candidate text',
      prompt: 'private prompt',
      rawJudgeOutput: 'private judge output',
      sourceUrl: 'https://private.invalid',
      externalItemId: 'external-private-id',
      credential: 'sk-private-secret',
    } as const;

    const bundle = buildNarrativeReviewRejectionBundle(unsafeInput);
    const serialized = JSON.stringify(bundle);

    expect(bundle.reviewRun).toMatchObject({
      stage: 'PRECHECK',
      decision: 'REJECT',
      failureCode: 'PRECHECK_REJECTED',
      judgeAiRunId: null,
      narrativeFingerprint,
      qualityContextFingerprint: null,
      findingCount: 1,
      majorFindingCount: 0,
      criticalFindingCount: 1,
      passedDimensionCount: 0,
      failedDimensionCount: 0,
    });
    expect(bundle.findings[0]).toMatchObject({
      blockSequences: '1,2',
      factIds: factId,
      blockSequenceCount: 2,
      factIdCount: 1,
    });
    expect(serialized).not.toMatch(
      /private candidate|private prompt|private judge|raw judge rationale|private\.invalid|external-private|sk-private/,
    );
  });

  it('persists semantic dimensions and normalized controlled findings only', () => {
    const bundle = buildNarrativeReviewRejectionBundle({
      ...common(),
      judgeAudit: audit('JUDGE'),
      stage: 'JUDGE',
      failureCode: 'SEMANTIC_REJECTED',
      dimensions: dimensions('FACTUAL_ENTAILMENT'),
      findings: [
        {
          reasonCode: 'UNSUPPORTED_CLAIM',
          severity: 'MAJOR',
          blockSequences: [1],
          factIds: [],
        },
      ],
    });

    expect(bundle.expectedJudgeAiRun).toEqual(audit('JUDGE'));
    expect(bundle.reviewRun).toMatchObject({
      stage: 'JUDGE',
      decision: 'REJECT',
      factualEntailmentResult: 'FAIL',
      referenceRelevanceResult: 'PASS',
      passedDimensionCount: 7,
      failedDimensionCount: 1,
      findingCount: 1,
      majorFindingCount: 1,
    });
    expect(bundle.findings[0]?.factIds).toBeNull();
  });

  it('records a technical GENERATE failure without candidate fingerprints', () => {
    const bundle = buildNarrativeReviewRejectionBundle({
      ...common(),
      generateAudit: audit('GENERATE', 'FAILED'),
      narrativeFingerprint: null,
      qualityContextFingerprint: null,
      stage: 'GENERATE',
      failureCode: 'AI_TIMEOUT',
    });

    expect(bundle.reviewRun).toMatchObject({
      stage: 'GENERATE',
      generateAiRunId,
      judgeAiRunId: null,
      narrativeFingerprint: null,
      qualityContextFingerprint: null,
      findingCount: 0,
    });
    expect(bundle.expectedGenerateAiRun.status).toBe('FAILED');
  });

  it('allows a technical JUDGE/product-write rejection with exact successful audits but no untrusted findings', () => {
    const bundle = buildNarrativeReviewRejectionBundle({
      ...common(),
      judgeAudit: audit('JUDGE'),
      stage: 'JUDGE',
      failureCode: 'PRODUCT_WRITE_FAILED',
    });

    expect(bundle.reviewRun).toMatchObject({
      judgeAiRunId,
      failureCode: 'PRODUCT_WRITE_FAILED',
      passedDimensionCount: 0,
      failedDimensionCount: 0,
      findingCount: 0,
    });
    expect(bundle.expectedJudgeAiRun?.status).toBe('SUCCEEDED');
  });

  it('builds reviewed narrative linkage only for both SUCCEEDED audits and all-pass policy', () => {
    const bundle = buildNarrativeReviewPublicationBundle({
      ...common(),
      judgeAudit: audit('JUDGE'),
      dimensions: dimensions(),
      narrativeBundle: narrativeBundle(),
    });

    expect(bundle.reviewRun).toMatchObject({
      decision: 'PUBLISH',
      failureCode: null,
      passedDimensionCount: 8,
      failedDimensionCount: 0,
      findingCount: 0,
    });
    expect(bundle.narrativeRun).toMatchObject({
      reviewRunId: bundle.reviewRun.ID,
      aiRunId: generateAiRunId,
      judgeAiRunId,
      modelViewVersion: NARRATIVE_MODEL_VIEW_VERSION,
      qualityContextVersion: NARRATIVE_QUALITY_CONTEXT_VERSION,
      rubricVersion: NARRATIVE_QUALITY_RUBRIC_VERSION,
      publicationPolicyVersion: NARRATIVE_PUBLICATION_POLICY_VERSION,
    });
  });

  it('rejects invalid publication/rejection state combinations before persistence', () => {
    expect(() =>
      buildNarrativeReviewPublicationBundle({
        ...common(),
        judgeAudit: audit('JUDGE'),
        dimensions: dimensions('PROVENANCE_INTEGRITY'),
        narrativeBundle: narrativeBundle(),
      }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_NARRATIVE_REVIEW_PERSISTENCE' }));
    expect(() =>
      buildNarrativeReviewRejectionBundle({
        ...common(),
        stage: 'GENERATE',
        failureCode: 'AI_TIMEOUT',
      }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_NARRATIVE_REVIEW_PERSISTENCE' }));
  });
});

describe('CAP narrative review persistence', () => {
  it('persists rejection evidence in one independent short transaction after exact audit validation', async () => {
    const bundle = buildNarrativeReviewRejectionBundle({
      ...common(),
      stage: 'PRECHECK',
      failureCode: 'PRECHECK_REJECTED',
      qualityContextFingerprint: null,
    });
    const database = new FakeDatabase();
    database.results.push(persistedAudit(bundle.expectedGenerateAiRun), 1);
    const store = new CapNarrativeReviewStore(
      () => database,
      () => false,
    );

    await expect(store.persistRejection(bundle)).resolves.toBeUndefined();

    expect(database.transactions).toBe(1);
    const queries = JSON.stringify(database.queries);
    expect(queries).toContain('trip.planner.AiRuns');
    expect(queries).toContain('trip.planner.NarrativeReviewRuns');
    expect(queries).not.toContain('OptionNarratives');
    expect(queries).not.toContain('Exact locally validated candidate');
  });

  it('validates both SUCCEEDED audits before writing review and narrative rows atomically', async () => {
    const bundle = buildNarrativeReviewPublicationBundle({
      ...common(),
      judgeAudit: audit('JUDGE'),
      dimensions: dimensions(),
      narrativeBundle: narrativeBundle(),
    });
    const database = new FakeDatabase();
    database.results.push(
      persistedAudit(bundle.expectedGenerateAiRun),
      persistedAudit(bundle.expectedJudgeAiRun),
    );

    await database.tx((transaction) =>
      new CapNarrativeReviewWriter().writePublication(transaction, bundle),
    );

    expect(database.transactions).toBe(1);
    const queries = JSON.stringify(database.queries);
    expect(queries).toContain('trip.planner.NarrativeReviewRuns');
    expect(queries).toContain('trip.planner.NarrativeRuns');
    expect(queries).toContain('trip.planner.OptionNarratives');
    expect(queries).toContain('trip.planner.NarrativeFactReferences');
  });

  it('rejects active transaction nesting and audit linkage mismatches fail-closed', async () => {
    const bundle = buildNarrativeReviewRejectionBundle({
      ...common(),
      stage: 'PRECHECK',
      failureCode: 'PRECHECK_REJECTED',
      qualityContextFingerprint: null,
    });
    const database = new FakeDatabase();
    const nestedStore = new CapNarrativeReviewStore(
      () => database,
      () => true,
    );
    await expect(nestedStore.persistRejection(bundle)).rejects.toMatchObject({
      code: 'INVALID_NARRATIVE_REVIEW_PERSISTENCE',
    });
    expect(database.transactions).toBe(0);

    database.results.push({ ...persistedAudit(bundle.expectedGenerateAiRun), status: 'STARTED' });
    await expect(
      new CapNarrativeReviewStore(
        () => database,
        () => false,
      ).persistRejection(bundle),
    ).rejects.toMatchObject({ code: 'INVALID_NARRATIVE_AUDIT_LINK' });
  });
});
