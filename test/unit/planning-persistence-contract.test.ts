import { describe, expect, it } from 'vitest';
import type { RankedOption, TripCandidate } from '../../srv/domain/candidate.ts';
import { CURRENCY_CONTRACT_VERSION } from '../../srv/domain/currency.ts';
import { OFFER_PRICING_CONTRACT_VERSION } from '../../srv/domain/offer-pricing.ts';
import type { CandidateEngineResult } from '../../srv/orchestration/candidate-engine.ts';
import { createPlanningFingerprint } from '../../srv/orchestration/planning-request.ts';
import {
  buildPlanningPersistenceBundle,
  type PlanningPersistenceInput,
} from '../../srv/persistence/planning-result-records.ts';
import {
  MOCK_PROVIDER_MANIFEST,
  providerManifestLineage,
} from '../../srv/providers/provider-manifest.ts';
import { calculateBudgetBreakdown } from '../../srv/ranking/budget.ts';
import { scoreCandidate } from '../../srv/ranking/candidate-scoring.ts';
import { DEFAULT_CANDIDATE_ENGINE_CONFIG } from '../../srv/ranking/config.ts';
import { candidateContext, candidateFixture } from './candidate-fixtures.ts';

function engineResult(options: readonly RankedOption[]): CandidateEngineResult {
  const candidates = options.map((option) => option.candidate);
  return {
    configVersion: DEFAULT_CANDIDATE_ENGINE_CONFIG.version,
    counts: {
      destinations: 1,
      transportOptions: candidates.length,
      stayOptions: candidates.length,
      builtCandidates: candidates.length,
      validCandidates: candidates.length,
      rejectedCandidates: 0,
    },
    candidates,
    validCandidates: candidates,
    rejectedCandidates: [],
    rejectionReasons: [],
    rankedCandidates: options.map((option) => ({
      candidate: option.candidate,
      score: option.score,
    })),
    options,
    shortage: null,
    providerExecution: {
      policyVersion: MOCK_PROVIDER_MANIFEST.executionPolicy.version,
      resultFingerprint: 'a'.repeat(64),
      calls: [],
    },
  };
}

function persistenceInput(result: CandidateEngineResult): PlanningPersistenceInput {
  const providerLineage = providerManifestLineage(MOCK_PROVIDER_MANIFEST);
  const versions = {
    currencyContractVersion: CURRENCY_CONTRACT_VERSION,
    offerPricingContractVersion: OFFER_PRICING_CONTRACT_VERSION,
    providerManifestVersion: providerLineage.manifestVersion,
    providerManifestFingerprint: providerLineage.manifestFingerprint,
    engineVersion: DEFAULT_CANDIDATE_ENGINE_CONFIG.version,
    scoringVersion: 'candidate-score-v1',
  };
  return {
    tripRequestId: candidateContext.tripRequestId,
    workflowRunId: '30f76ef1-86f2-4ef1-a624-55ea78e43ba3',
    requestFingerprint: createPlanningFingerprint(candidateContext, versions),
    currencyContractVersion: versions.currencyContractVersion,
    offerPricingContractVersion: versions.offerPricingContractVersion,
    providerFixtureVersion: providerLineage.fixtureVersion,
    providerManifestVersion: providerLineage.manifestVersion,
    providerManifestFingerprint: providerLineage.manifestFingerprint,
    providerManifestJson: providerLineage.manifestJson,
    startedAt: '2026-08-27T10:00:00.000Z',
    completedAt: '2026-08-27T10:00:01.000Z',
    context: candidateContext,
    result,
  };
}

function rankedOption(
  candidate: TripCandidate,
  rank: number,
  role: RankedOption['role'],
): RankedOption {
  return { rank, role, candidate, score: scoreCandidate(candidate, candidateContext) };
}

describe('planning persistence contract', () => {
  it('persists deterministic provider and selected-source commitments', () => {
    const candidate = candidateFixture();
    const options = [
      rankedOption(candidate, 1, 'BEST_OVERALL'),
      rankedOption(candidate, 2, 'MOST_CONVENIENT'),
      rankedOption(candidate, 3, 'BEST_VALUE'),
    ];

    const forward = buildPlanningPersistenceBundle(persistenceInput(engineResult(options)));
    const reverse = buildPlanningPersistenceBundle(
      persistenceInput(engineResult([...options].reverse())),
    );

    expect(forward.planningRun.providerResultFingerprint).toBe('a'.repeat(64));
    expect(forward.planningRun.selectedSourceFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(reverse.planningRun.selectedSourceFingerprint).toBe(
      forward.planningRun.selectedSourceFingerprint,
    );
  });

  it('rejects a malformed aggregate provider result fingerprint', () => {
    const candidate = candidateFixture();
    const result = engineResult([
      rankedOption(candidate, 1, 'BEST_OVERALL'),
      rankedOption(candidate, 2, 'MOST_CONVENIENT'),
      rankedOption(candidate, 3, 'BEST_VALUE'),
    ]);

    expect(() =>
      buildPlanningPersistenceBundle(
        persistenceInput({
          ...result,
          providerExecution: { ...result.providerExecution, resultFingerprint: 'invalid' },
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_PLANNING_RESULT' }));
  });

  it('rejects a SourceSnapshot id collision across selected options', () => {
    const first = candidateFixture();
    const baseSecond = candidateFixture();
    const originalSource = baseSecond.transport.sourceSnapshot;
    if (originalSource === null) throw new Error('Fixture transport source is required.');
    const conflictingSource = { ...originalSource, resultFingerprint: 'f'.repeat(64) };
    const transport = {
      ...baseSecond.transport,
      sourceSnapshot: conflictingSource,
      price: { ...baseSecond.transport.price, sourceSnapshot: conflictingSource },
      additionalFees: {
        ...baseSecond.transport.additionalFees,
        sourceSnapshot: conflictingSource,
      },
      pricing: {
        ...baseSecond.transport.pricing,
        mandatoryTotal: {
          ...baseSecond.transport.pricing.mandatoryTotal,
          sourceSnapshot: conflictingSource,
        },
      },
    };
    const second: TripCandidate = {
      ...baseSecond,
      id: `${baseSecond.id}:collision`,
      transport,
      budget: calculateBudgetBreakdown(candidateContext, {
        transport,
        stay: baseSecond.stay,
        localCostEstimates: baseSecond.localCostEstimates,
      }),
    };
    const options = [
      rankedOption(first, 1, 'BEST_OVERALL'),
      rankedOption(second, 2, 'MOST_CONVENIENT'),
      rankedOption(first, 3, 'BEST_VALUE'),
    ];

    expect(() =>
      buildPlanningPersistenceBundle(persistenceInput(engineResult(options))),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_FINAL_OPTION' }));
  });

  it('rejects malformed provider audit metadata before any persistence record is returned', () => {
    const candidate = candidateFixture();
    const options = [
      rankedOption(candidate, 1, 'BEST_OVERALL'),
      rankedOption(candidate, 2, 'MOST_CONVENIENT'),
      rankedOption(candidate, 3, 'BEST_VALUE'),
    ];
    const result = engineResult(options);
    const malformed: CandidateEngineResult = {
      ...result,
      providerExecution: {
        ...result.providerExecution,
        calls: [
          {
            sequence: 2,
            policyVersion: 'provider-execution-policy-v1',
            providerKey: 'mock-transport',
            operation: 'TRANSPORT_SEARCH',
            destinationCode: null,
            status: 'SUCCEEDED',
            providerCallAttempted: true,
            attempts: 1,
            latencyMs: 1,
            queryFingerprint: 'a'.repeat(64),
            resultFingerprint: 'b'.repeat(64),
            resultCount: 1,
            failureCategory: null,
            underlyingFailureCategory: null,
            httpStatus: null,
            rateLimitRetryAfterMs: null,
            rateLimitLimit: null,
            rateLimitRemaining: null,
            rateLimitResetAt: null,
          },
        ],
      },
    };

    expect(() => buildPlanningPersistenceBundle(persistenceInput(malformed))).toThrowError(
      expect.objectContaining({ code: 'INVALID_PLANNING_RESULT' }),
    );
  });
});
