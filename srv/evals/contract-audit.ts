import {
  NARRATIVE_JUDGE_DIMENSIONS,
  NARRATIVE_JUDGE_REASON_CODES,
  NARRATIVE_QUALITY_RUBRIC_CONTRACT,
  type NarrativeJudgeDimension,
  type NarrativeJudgeReasonCode,
  type NarrativeQualityRubricContract,
} from '../narratives/narrative-quality-rubric.ts';
import { EvalContractError, type NarrativeQualityDataset } from './dataset.ts';

export interface NarrativeQualityContractAuditSummary {
  readonly rubricVersion: string;
  readonly semanticCaseCount: number;
  readonly positiveCaseCount: number;
  readonly judgeNegativeCaseCount: number;
  readonly criticalJudgeNegativeCaseCount: number;
  readonly auditedReasonCount: number;
  readonly auditedDimensionCount: number;
}

function invalidContract(message: string): never {
  throw new EvalContractError('INVALID_DATASET_AUTHORING', message);
}

/**
 * Proves the authored expected evidence can be expressed by the exact runtime rubric. This audit
 * never changes a label and uses only closed IDs, dimensions, reasons, and severities.
 */
export function auditNarrativeQualityDatasetRubricConsistency(
  dataset: NarrativeQualityDataset,
  rubric: NarrativeQualityRubricContract = NARRATIVE_QUALITY_RUBRIC_CONTRACT,
): NarrativeQualityContractAuditSummary {
  if (dataset.rubricVersion !== rubric.rubricVersion) {
    invalidContract('The dataset and runtime rubric versions do not match.');
  }
  const dimensions = new Set<NarrativeJudgeDimension>(NARRATIVE_JUDGE_DIMENSIONS);
  const reasonCodes = new Set<NarrativeJudgeReasonCode>(NARRATIVE_JUDGE_REASON_CODES);
  const rules = new Map(rubric.reasons.map((reason) => [reason.code, reason]));

  for (const reason of rubric.reasons) {
    if (!reasonCodes.has(reason.code) || reason.dimensions.some((item) => !dimensions.has(item))) {
      invalidContract('The rubric contains an unknown reason or dimension mapping.');
    }
    if (reason.dimensions.length > 1 && reason.multiDimensionRationale === null) {
      invalidContract(
        'Every multi-dimension reason requires an explicit independent-violation rationale.',
      );
    }
    if (reason.dimensions.length === 1 && reason.multiDimensionRationale !== null) {
      invalidContract(
        'A canonical single-dimension reason cannot claim multi-dimension semantics.',
      );
    }
  }

  let positiveCaseCount = 0;
  let judgeNegativeCaseCount = 0;
  let criticalJudgeNegativeCaseCount = 0;
  for (const qualityCase of dataset.cases) {
    const expected = qualityCase.expected;
    if (expected.decision === 'PUBLISH') {
      positiveCaseCount += 1;
      if (
        expected.stage !== 'JUDGE' ||
        expected.critical ||
        expected.failedDimensions.length !== 0 ||
        expected.requiredReasonCodes.length !== 0
      ) {
        invalidContract(`Positive case ${qualityCase.id} contains negative expected evidence.`);
      }
      continue;
    }
    if (expected.stage !== 'JUDGE') continue;
    judgeNegativeCaseCount += 1;
    if (expected.critical) criticalJudgeNegativeCaseCount += 1;

    const failedDimensions = new Set(expected.failedDimensions);
    for (const reasonCode of expected.requiredReasonCodes) {
      const rule = rules.get(reasonCode);
      if (
        rule === undefined ||
        !reasonCodes.has(reasonCode) ||
        !rule.dimensions.some((dimension) => failedDimensions.has(dimension))
      ) {
        invalidContract(`JUDGE case ${qualityCase.id} has an incompatible required reason.`);
      }
      if (expected.critical && !rule.allowedSeverities.includes('CRITICAL')) {
        invalidContract(`Critical JUDGE case ${qualityCase.id} uses a non-critical reason.`);
      }
    }
    for (const failedDimension of expected.failedDimensions) {
      if (
        !dimensions.has(failedDimension) ||
        !expected.requiredReasonCodes.some((reasonCode) =>
          rules.get(reasonCode)?.dimensions.includes(failedDimension),
        )
      ) {
        invalidContract(`JUDGE case ${qualityCase.id} has an unexplained failed dimension.`);
      }
    }
  }

  return Object.freeze({
    rubricVersion: rubric.rubricVersion,
    semanticCaseCount: dataset.cases.length,
    positiveCaseCount,
    judgeNegativeCaseCount,
    criticalJudgeNegativeCaseCount,
    auditedReasonCount: rules.size,
    auditedDimensionCount: dimensions.size,
  });
}
