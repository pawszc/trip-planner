import {
  loadNarrativeQualityDataset,
  resolveNarrativeQualityDataset,
  type ResolvedNarrativeQualityCase,
} from '../srv/evals/dataset.ts';
import {
  runDeterministicContractReplay,
  type OfflineNarrativeEvalAdapter,
} from '../srv/evals/offline-harness.ts';
import { NARRATIVE_EVAL_CONTRACT_VERSIONS } from '../srv/evals/report.ts';
import {
  NARRATIVE_E2E_REQUIRED_PROPERTY_CATALOG_VERSION,
  type NarrativeE2eRequiredPropertyId,
} from '../srv/evals/required-properties.ts';
import { resolveSyntheticNarrativeQualityFixture } from '../srv/evals/synthetic-fixtures.ts';

/**
 * Credential-free contract evaluation. The adapter replays frozen expected evidence against the
 * real loader, production grounded-context builder, metrics, gates and privacy-safe report path.
 * Provider behavior is measured only by the separately guarded live baseline.
 */
const deterministicContractAdapter: OfflineNarrativeEvalAdapter = {
  async evaluateSemanticCase(qualityCase: ResolvedNarrativeQualityCase) {
    const expected = qualityCase.authored.expected;
    return {
      actualDecision: expected.decision,
      actualStage: expected.stage,
      failedDimensions: expected.failedDimensions,
      reasonCodes: expected.requiredReasonCodes,
      strictJudgeOutputValid: expected.stage === 'JUDGE' ? true : null,
    };
  },
  async evaluateEndToEndCase(qualityCase) {
    return {
      generateLogicalCalls: 1,
      judgeLogicalCalls: 1,
      generatedSchemaValid: true,
      exactReferencesValid: true,
      actualDecision: 'PUBLISH' as const,
      judgeStructuredOutputValid: true,
      requiredPropertyCatalogVersion: NARRATIVE_E2E_REQUIRED_PROPERTY_CATALOG_VERSION,
      requiredPropertyResults: qualityCase.authored.requiredProperties.map((propertyId) => ({
        propertyId: propertyId as NarrativeE2eRequiredPropertyId,
        passed: true,
        failureCode: null,
      })),
      generateAuditSucceeded: true,
      judgeAuditSucceeded: true,
      publicationBundleLinkageValidInMemory: true,
      deterministicStateUnchanged: true,
    };
  },
};

const dataset = loadNarrativeQualityDataset();
const resolvedDataset = resolveNarrativeQualityDataset(
  dataset,
  resolveSyntheticNarrativeQualityFixture,
);
const result = await runDeterministicContractReplay({
  resolvedDataset,
  versions: NARRATIVE_EVAL_CONTRACT_VERSIONS,
  adapter: deterministicContractAdapter,
});

if (
  !result.report.semantic.gates.passed ||
  !result.report.stability.gates.passed ||
  !result.report.endToEnd.gates.passed ||
  result.report.operationalSummary.logicalCalls !== 0 ||
  result.report.operationalSummary.providerAttempts !== 0 ||
  result.report.operationalSummary.estimatedCostUsdMicros !== 0
) {
  throw new Error('Offline narrative-quality contract replay failed closed.');
}

console.log(
  JSON.stringify({
    status: 'PASS',
    evidenceKind: 'CONTRACT_REPLAY',
    modelQualityMeasured: false,
    datasetVersion: result.report.datasetVersion,
    datasetFingerprint: result.report.datasetFingerprint,
    reportFingerprint: result.report.reportFingerprint,
    semanticCases: result.primaryOutcomes.length,
    sentinelRepeats: result.repeatedSentinelOutcomes.length,
    endToEndCases: result.endToEndOutcomes.length,
    liveCalls: 0,
    providerAttempts: 0,
    estimatedCostUsdMicros: 0,
  }),
);
