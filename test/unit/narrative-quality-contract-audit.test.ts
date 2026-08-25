import { describe, expect, it } from 'vitest';
import { auditNarrativeQualityDatasetRubricConsistency } from '../../srv/evals/contract-audit.ts';
import { loadNarrativeQualityDataset } from '../../srv/evals/dataset.ts';
import {
  NARRATIVE_QUALITY_RUBRIC_CONTRACT,
  type NarrativeQualityRubricContract,
} from '../../srv/narratives/narrative-quality-rubric.ts';

describe('narrative-quality dataset/rubric consistency audit', () => {
  it('proves every JUDGE golden is expressible by the exact v2 rubric', () => {
    expect(auditNarrativeQualityDatasetRubricConsistency(loadNarrativeQualityDataset())).toEqual({
      rubricVersion: 'narrative-quality-rubric-v2',
      semanticCaseCount: 32,
      positiveCaseCount: 12,
      judgeNegativeCaseCount: 18,
      criticalJudgeNegativeCaseCount: 16,
      auditedReasonCount: 19,
      auditedDimensionCount: 8,
    });
  });

  it('fails closed on an incompatible reason/dimension expectation without relabeling it', () => {
    const dataset = structuredClone(loadNarrativeQualityDataset());
    const qualityCase = dataset.cases.find(({ id }) => id === 'R03');
    if (qualityCase === undefined) throw new Error('Missing synthetic R03 contract case.');
    qualityCase.expected.requiredReasonCodes = ['REFERENCE_DOES_NOT_SUPPORT_CLAIM'];

    expect(() => auditNarrativeQualityDatasetRubricConsistency(dataset)).toThrowError(
      expect.objectContaining({ code: 'INVALID_DATASET_AUTHORING' }),
    );
  });

  it('fails closed if a critical golden reason loses critical severity', () => {
    const rubric = structuredClone(
      NARRATIVE_QUALITY_RUBRIC_CONTRACT,
    ) as NarrativeQualityRubricContract;
    const reason = rubric.reasons.find(({ code }) => code === 'MONEY_VALUE_MISMATCH');
    if (reason === undefined) throw new Error('Missing money mismatch rubric reason.');
    (reason as unknown as { allowedSeverities: ('MAJOR' | 'CRITICAL')[] }).allowedSeverities = [
      'MAJOR',
    ];

    expect(() =>
      auditNarrativeQualityDatasetRubricConsistency(loadNarrativeQualityDataset(), rubric),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_DATASET_AUTHORING' }));
  });

  it('requires documentation for every genuinely multi-dimension reason mapping', () => {
    const rubric = structuredClone(
      NARRATIVE_QUALITY_RUBRIC_CONTRACT,
    ) as NarrativeQualityRubricContract;
    const reason = rubric.reasons.find(({ code }) => code === 'DATE_TIME_MISMATCH');
    if (reason === undefined) throw new Error('Missing date/time rubric reason.');
    (reason as { multiDimensionRationale: string | null }).multiDimensionRationale = null;

    expect(() =>
      auditNarrativeQualityDatasetRubricConsistency(loadNarrativeQualityDataset(), rubric),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_DATASET_AUTHORING' }));
  });
});
