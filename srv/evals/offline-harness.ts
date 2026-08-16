import {
  NARRATIVE_QUALITY_SENTINEL_CASE_IDS,
  type ResolvedNarrativeQualityCase,
  type ResolvedNarrativeQualityDataset,
  type ResolvedNarrativeQualityEndToEndCase,
} from './dataset.ts';
import { type EndToEndCaseOutcome, type SemanticCaseOutcome } from './metrics.ts';
import {
  buildPrivacySafeEvalReport,
  type EvalContractVersions,
  type EvalOperationEvidence,
  type NarrativeEvalReport,
} from './report.ts';

export type OfflineEvaluationPass = 'PRIMARY' | 'STABILITY_REPEAT';

export type OfflineSemanticAdapterResult = Omit<SemanticCaseOutcome, 'caseId'>;
export type OfflineEndToEndAdapterResult = Omit<EndToEndCaseOutcome, 'caseId'>;

/** The harness owns ordering and IDs; adapters receive only already resolved synthetic cases. */
export interface OfflineNarrativeEvalAdapter {
  evaluateSemanticCase(
    qualityCase: ResolvedNarrativeQualityCase,
    pass: OfflineEvaluationPass,
  ): Promise<OfflineSemanticAdapterResult>;
  evaluateEndToEndCase(
    qualityCase: ResolvedNarrativeQualityEndToEndCase,
  ): Promise<OfflineEndToEndAdapterResult>;
}

export interface RunOfflineEvaluationInput {
  readonly resolvedDataset: ResolvedNarrativeQualityDataset;
  readonly versions: EvalContractVersions;
  readonly adapter: OfflineNarrativeEvalAdapter;
  /** Normally empty for offline verification; retained for deterministic in-memory evidence. */
  readonly operations?: readonly EvalOperationEvidence[];
}

export interface OfflineEvaluationResult {
  readonly primaryOutcomes: readonly SemanticCaseOutcome[];
  readonly repeatedSentinelOutcomes: readonly SemanticCaseOutcome[];
  readonly endToEndOutcomes: readonly EndToEndCaseOutcome[];
  readonly report: NarrativeEvalReport;
}

/**
 * Deterministic orchestration only: 32 primary cases, the exact eight sentinels once more, then
 * four synthetic E2E contexts. The injected adapter is the sole execution seam; this module has
 * no provider, credential, environment, clock, random or network dependency.
 */
export async function runDeterministicOfflineEvaluation(
  input: RunOfflineEvaluationInput,
): Promise<OfflineEvaluationResult> {
  const primaryOutcomes: SemanticCaseOutcome[] = [];
  for (const qualityCase of input.resolvedDataset.cases) {
    primaryOutcomes.push({
      caseId: qualityCase.authored.id,
      ...(await input.adapter.evaluateSemanticCase(qualityCase, 'PRIMARY')),
    });
  }

  const byId = new Map(
    input.resolvedDataset.cases.map((qualityCase) => [qualityCase.authored.id, qualityCase]),
  );
  const repeatedSentinelOutcomes: SemanticCaseOutcome[] = [];
  for (const caseId of NARRATIVE_QUALITY_SENTINEL_CASE_IDS) {
    const qualityCase = byId.get(caseId)!;
    repeatedSentinelOutcomes.push({
      caseId,
      ...(await input.adapter.evaluateSemanticCase(qualityCase, 'STABILITY_REPEAT')),
    });
  }

  const endToEndOutcomes: EndToEndCaseOutcome[] = [];
  for (const qualityCase of input.resolvedDataset.endToEndCases) {
    endToEndOutcomes.push({
      caseId: qualityCase.authored.id,
      ...(await input.adapter.evaluateEndToEndCase(qualityCase)),
    });
  }

  const dataset = input.resolvedDataset.dataset;
  const report = buildPrivacySafeEvalReport({
    dataset,
    versions: input.versions,
    outcomes: primaryOutcomes,
    repeatedSentinelOutcomes,
    endToEndOutcomes,
    operations: input.operations ?? [],
  });
  return { primaryOutcomes, repeatedSentinelOutcomes, endToEndOutcomes, report };
}
