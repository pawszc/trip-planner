import { loadNarrativeQualityDataset, type NarrativeQualityCase } from '../../srv/evals/dataset.ts';
import { resolveSyntheticNarrativeQualityFixture } from '../../srv/evals/synthetic-fixtures-v2.ts';
import type { EndToEndCaseOutcome, SemanticCaseOutcome } from '../../srv/evals/metrics.ts';
import { NARRATIVE_EVAL_CONTRACT_VERSIONS } from '../../srv/evals/report.ts';
import {
  NARRATIVE_E2E_REQUIRED_PROPERTY_CATALOG_VERSION,
  type NarrativeE2eRequiredPropertyId,
} from '../../srv/evals/required-properties.ts';

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
  const authored = loadNarrativeQualityDataset().endToEndCases.find(({ id }) => id === caseId);
  if (authored === undefined) throw new Error('Unknown frozen E2E case.');
  return {
    caseId,
    generateLogicalCalls: 1,
    judgeLogicalCalls: 1,
    generatedSchemaValid: true,
    exactReferencesValid: true,
    actualDecision: 'PUBLISH',
    actualFailedDimensions: [],
    actualReasonCodes: [],
    judgeStructuredOutputValid: true,
    requiredPropertyCatalogVersion: NARRATIVE_E2E_REQUIRED_PROPERTY_CATALOG_VERSION,
    requiredPropertyResults: authored.requiredProperties.map((propertyId) => ({
      propertyId: propertyId as NarrativeE2eRequiredPropertyId,
      passed: true,
      failureCode: null,
    })),
    generateAuditSucceeded: true,
    judgeAuditSucceeded: true,
    publicationBundleLinkageValidInMemory: true,
    deterministicStateUnchanged: true,
  };
}

export const evalContractVersions = NARRATIVE_EVAL_CONTRACT_VERSIONS;
