import cds from '@sap/cds';
import { DomainError } from '../domain/domain-error.ts';
import {
  assertExpectedNarrativeReviewAiRun,
  insertNarrativeReview,
  type NarrativeReviewTransactionRunner,
} from './cap-narrative-review-store.ts';
import type { NarrativeReviewPublicationBundle } from './narrative-review-persistence.ts';

const NARRATIVE_RUN_ENTITY = 'trip.planner.NarrativeRuns';
const OPTION_NARRATIVE_ENTITY = 'trip.planner.OptionNarratives';
const NARRATIVE_FACT_REFERENCE_ENTITY = 'trip.planner.NarrativeFactReferences';

/** Writes one prevalidated PUBLISH review and its exact narrative product rows atomically. */
export class CapNarrativeReviewWriter {
  async writePublication(
    transaction: NarrativeReviewTransactionRunner,
    bundle: NarrativeReviewPublicationBundle,
  ): Promise<void> {
    if (
      bundle.reviewRun.decision !== 'PUBLISH' ||
      bundle.reviewRun.stage !== 'JUDGE' ||
      bundle.reviewRun.failureCode !== null ||
      bundle.reviewRun.failedDimensionCount !== 0 ||
      bundle.reviewRun.passedDimensionCount !== 8 ||
      bundle.reviewRun.findingCount !== 0 ||
      bundle.expectedGenerateAiRun.status !== 'SUCCEEDED' ||
      bundle.expectedJudgeAiRun.status !== 'SUCCEEDED' ||
      bundle.narrativeRun.reviewRunId !== bundle.reviewRun.ID ||
      bundle.narrativeRun.aiRunId !== bundle.expectedGenerateAiRun.ID ||
      bundle.narrativeRun.judgeAiRunId !== bundle.expectedJudgeAiRun.ID
    ) {
      throw new DomainError(
        'INVALID_NARRATIVE_REVIEW_PERSISTENCE',
        'Narrative publication bundle is not eligible for atomic persistence.',
      );
    }

    await assertExpectedNarrativeReviewAiRun(transaction, bundle.expectedGenerateAiRun);
    await assertExpectedNarrativeReviewAiRun(transaction, bundle.expectedJudgeAiRun);
    await insertNarrativeReview(transaction, bundle);
    await transaction.run(cds.ql.INSERT.into(NARRATIVE_RUN_ENTITY).entries(bundle.narrativeRun));
    await transaction.run(
      cds.ql.INSERT.into(OPTION_NARRATIVE_ENTITY).entries(...bundle.optionNarratives),
    );
    await transaction.run(
      cds.ql.INSERT.into(NARRATIVE_FACT_REFERENCE_ENTITY).entries(...bundle.factReferences),
    );
  }
}
