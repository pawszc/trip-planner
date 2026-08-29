import { describe, expect, it } from 'vitest';
import type { RankedOption, TripCandidate } from '../../srv/domain/candidate.ts';
import { CURRENCY_CONTRACT_VERSION } from '../../srv/domain/currency.ts';
import { createMoney } from '../../srv/domain/money.ts';
import { OFFER_PRICING_CONTRACT_VERSION } from '../../srv/domain/offer-pricing.ts';
import {
  buildGroundedOptionContext,
  type GroundedBudgetItemRecord,
  type GroundedPlanningRunRecord,
  type GroundedRankedOptionRecord,
  type GroundedSourceSnapshotRecord,
} from '../../srv/narratives/grounded-option-context.ts';
import type { CandidateEngineResult } from '../../srv/orchestration/candidate-engine.ts';
import { createPlanningFingerprint } from '../../srv/orchestration/planning-request.ts';
import { buildPlanningPersistenceBundle } from '../../srv/persistence/planning-result-records.ts';
import {
  MOCK_PROVIDER_MANIFEST,
  providerManifestLineage,
} from '../../srv/providers/provider-manifest.ts';
import { calculateBudgetBreakdown } from '../../srv/ranking/budget.ts';
import { scoreCandidate } from '../../srv/ranking/candidate-scoring.ts';
import { DEFAULT_CANDIDATE_ENGINE_CONFIG } from '../../srv/ranking/config.ts';
import { candidateContext, candidateFixture } from './candidate-fixtures.ts';

function candidateWithMixedAdditionalFees(): TripCandidate {
  const base = candidateFixture();
  const transport = {
    ...base.transport,
    additionalFees: createMoney(
      4_000,
      'PLN',
      'FIXED_PRICE',
      base.transport.additionalFees.sourceSnapshot,
    ),
  };
  const stay = {
    ...base.stay,
    additionalFees: createMoney(6_000, 'PLN', 'ESTIMATE', base.stay.additionalFees.sourceSnapshot),
    pricing: {
      ...base.stay.pricing,
      mandatoryTotal: createMoney(
        base.stay.pricing.mandatoryTotal.amountMinor!,
        'PLN',
        'ESTIMATE',
        base.stay.pricing.mandatoryTotal.sourceSnapshot,
      ),
    },
  };
  return {
    ...base,
    transport,
    stay,
    budget: calculateBudgetBreakdown(candidateContext, {
      transport,
      stay,
      localCostEstimates: base.localCostEstimates,
    }),
  };
}

function successfulResult(candidate: TripCandidate): CandidateEngineResult {
  const score = scoreCandidate(candidate, candidateContext);
  const options = [
    { rank: 1, role: 'BEST_OVERALL', candidate, score },
    { rank: 2, role: 'MOST_CONVENIENT', candidate, score },
    { rank: 3, role: 'BEST_VALUE', candidate, score },
  ] satisfies readonly RankedOption[];
  return {
    configVersion: DEFAULT_CANDIDATE_ENGINE_CONFIG.version,
    counts: {
      destinations: 1,
      transportOptions: 1,
      stayOptions: 1,
      builtCandidates: 1,
      validCandidates: 1,
      rejectedCandidates: 0,
    },
    candidates: [candidate],
    validCandidates: [candidate],
    rejectedCandidates: [],
    rejectionReasons: [],
    rankedCandidates: [{ candidate, score }],
    options,
    shortage: null,
    providerExecution: {
      policyVersion: 'provider-execution-policy-v1',
      resultFingerprint: 'a'.repeat(64),
      calls: [],
    },
  };
}

describe('mixed additional-fee persistence', () => {
  it('preserves the calculator split through persistence and grounded context', () => {
    const candidate = candidateWithMixedAdditionalFees();
    expect(candidate.budget.additionalFees).toMatchObject({
      amountMinor: 10_000,
      priceType: 'ESTIMATE',
    });
    expect(candidate.budget.categoryAmounts.ADDITIONAL_FEES).toEqual({
      confirmedAmountMinor: 4_000,
      estimatedAmountMinor: 6_000,
    });

    const versions = {
      currencyContractVersion: CURRENCY_CONTRACT_VERSION,
      offerPricingContractVersion: OFFER_PRICING_CONTRACT_VERSION,
      providerManifestVersion: providerManifestLineage(MOCK_PROVIDER_MANIFEST).manifestVersion,
      providerManifestFingerprint:
        providerManifestLineage(MOCK_PROVIDER_MANIFEST).manifestFingerprint,
      engineVersion: DEFAULT_CANDIDATE_ENGINE_CONFIG.version,
      scoringVersion: 'candidate-score-v1',
    };
    const providerLineage = providerManifestLineage(MOCK_PROVIDER_MANIFEST);
    const bundle = buildPlanningPersistenceBundle({
      tripRequestId: candidateContext.tripRequestId,
      workflowRunId: '50000000-0000-4000-8000-000000000001',
      requestFingerprint: createPlanningFingerprint(candidateContext, versions),
      currencyContractVersion: versions.currencyContractVersion,
      offerPricingContractVersion: versions.offerPricingContractVersion,
      providerFixtureVersion: 'candidate-test-v1',
      providerManifestVersion: providerLineage.manifestVersion,
      providerManifestFingerprint: providerLineage.manifestFingerprint,
      providerManifestJson: providerLineage.manifestJson,
      startedAt: '2026-08-14T12:00:00.000Z',
      completedAt: '2026-08-14T12:00:01.000Z',
      context: candidateContext,
      result: successfulResult(candidate),
    });
    const rankedOption = bundle.rankedOptions[0] as unknown as GroundedRankedOptionRecord;
    const budgetItems = bundle.budgetItems.filter(
      (item) => item.rankedOption_ID === rankedOption.ID,
    ) as unknown as GroundedBudgetItemRecord[];
    const sourceSnapshots = bundle.sourceSnapshots.filter(
      (source) => source.rankedOption_ID === rankedOption.ID,
    ) as unknown as GroundedSourceSnapshotRecord[];
    const persistedFees = budgetItems.find((item) => item.category === 'ADDITIONAL_FEES');

    expect(bundle.planningRun.currencyContractVersion).toBe(CURRENCY_CONTRACT_VERSION);
    expect(persistedFees).toMatchObject({
      amountMinor: 10_000,
      confirmedAmountMinor: 4_000,
      estimatedAmountMinor: 6_000,
      priceType: 'ESTIMATE',
      classification: 'ESTIMATED',
    });

    const grounded = buildGroundedOptionContext({
      tripRequest: {
        ID: candidateContext.tripRequestId,
        adults: candidateContext.adults,
        totalBudget: '4500.00',
        currency: candidateContext.currency,
      },
      planningRun: bundle.planningRun as GroundedPlanningRunRecord,
      rankedOption,
      budgetItems,
      sourceSnapshots,
    });
    const feeFact = grounded.facts.find(
      (fact) => fact.key === 'option.budget.category.ADDITIONAL_FEES',
    );
    const summaryFact = grounded.facts.find((fact) => fact.key === 'option.budget.summary');
    expect(feeFact).toMatchObject({
      status: 'KNOWN',
      value: {
        amountMinor: '10000',
        confirmedAmountMinor: '4000',
        estimatedAmountMinor: '6000',
      },
    });
    expect(summaryFact).toMatchObject({
      status: 'KNOWN',
      value: {
        confirmedAmountMinor: String(candidate.budget.confirmedAmountMinor),
        estimatedAmountMinor: String(candidate.budget.estimatedAmountMinor),
        totalAmountMinor: String(candidate.budget.totalAmountMinor),
      },
    });
  });
});
