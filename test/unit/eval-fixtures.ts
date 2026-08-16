import { loadNarrativeQualityDataset, type NarrativeQualityCase } from '../../srv/evals/dataset.ts';
import { resolveSyntheticNarrativeQualityFixture } from '../../srv/evals/synthetic-fixtures.ts';
import type { EndToEndCaseOutcome, SemanticCaseOutcome } from '../../srv/evals/metrics.ts';
import { NARRATIVE_EVAL_CONTRACT_VERSIONS } from '../../srv/evals/report.ts';

export const syntheticGroundedFixtureResolver = resolveSyntheticNarrativeQualityFixture;

export function frozenNarrativeQualityDataset() {
  return loadNarrativeQualityDataset();
}

export function perfectSemanticOutcome(authored: NarrativeQualityCase): SemanticCaseOutcome {
  return {
    caseId: authored.id,
    actualDecision: authored.expected.decision,
    actualStage: authored.expected.stage,
    failedDimensions: authored.expected.failedDimensions,
    reasonCodes: authored.expected.requiredReasonCodes,
    strictJudgeOutputValid: authored.expected.stage === 'JUDGE' ? true : null,
  };
}

export function passingEndToEndOutcome(caseId: string): EndToEndCaseOutcome {
  return {
    caseId,
    generateLogicalCalls: 1,
    judgeLogicalCalls: 1,
    generatedSchemaValid: true,
    exactReferencesValid: true,
    actualDecision: 'PUBLISH',
    criticalNarrativePublished: false,
    adversarialPayloadPropagated: false,
    generateAuditSucceeded: true,
    judgeAuditSucceeded: true,
    reviewLinked: true,
    deterministicStateUnchanged: true,
  };
}

export const evalContractVersions = NARRATIVE_EVAL_CONTRACT_VERSIONS;
