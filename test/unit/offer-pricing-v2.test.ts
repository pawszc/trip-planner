import { describe, expect, it } from 'vitest';
import type { RankedOption, TripCandidate } from '../../srv/domain/candidate.js';
import { CURRENCY_CONTRACT_VERSION } from '../../srv/domain/currency.js';
import { createMoney, unknownMoney, type SourceSnapshot } from '../../srv/domain/money.js';
import {
  OFFER_PRICING_CONTRACT_VERSION,
  chargeCollectionValidationIssues,
  offerPricingValidationIssues,
  type ConditionalChargeDisclosure,
  type OfferChargeCollection,
  type OptionalAncillaryDisclosure,
} from '../../srv/domain/offer-pricing.js';
import type { CandidateEngineResult } from '../../srv/orchestration/candidate-engine.js';
import { createPlanningFingerprint } from '../../srv/orchestration/planning-request.js';
import { buildPlanningPersistenceBundle } from '../../srv/persistence/planning-result-records.js';
import {
  MOCK_PROVIDER_MANIFEST,
  providerManifestLineage,
} from '../../srv/providers/provider-manifest.js';
import { createProviderFingerprint } from '../../srv/providers/provider-fingerprint.js';
import { transportResultView } from '../../srv/providers/normalized-result.js';
import { validateCandidate } from '../../srv/ranking/candidate-filter.js';
import { scoreCandidate } from '../../srv/ranking/candidate-scoring.js';
import { DEFAULT_CANDIDATE_ENGINE_CONFIG } from '../../srv/ranking/config.js';
import { candidateContext, candidateFixture } from './candidate-fixtures.js';

function resultFor(candidate: TripCandidate): CandidateEngineResult {
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
      policyVersion: MOCK_PROVIDER_MANIFEST.executionPolicy.version,
      resultFingerprint: 'a'.repeat(64),
      calls: [],
    },
  };
}

function persistenceBundle(candidate: TripCandidate) {
  const providerLineage = providerManifestLineage(MOCK_PROVIDER_MANIFEST);
  const versions = {
    currencyContractVersion: CURRENCY_CONTRACT_VERSION,
    offerPricingContractVersion: OFFER_PRICING_CONTRACT_VERSION,
    providerManifestVersion: providerLineage.manifestVersion,
    providerManifestFingerprint: providerLineage.manifestFingerprint,
    engineVersion: DEFAULT_CANDIDATE_ENGINE_CONFIG.version,
    scoringVersion: 'candidate-score-v1',
  };
  return buildPlanningPersistenceBundle({
    tripRequestId: candidateContext.tripRequestId,
    workflowRunId: '5f78c735-8a6d-45ef-a021-34950d605ccc',
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
    result: resultFor(candidate),
  });
}

function reasonCodes(candidate: TripCandidate): readonly string[] {
  return validateCandidate(candidate, candidateContext).reasons.map((reason) => reason.code);
}

describe('offer price v2', () => {
  it('accepts an explicitly PARTIAL collection with no disclosed items', () => {
    expect(
      chargeCollectionValidationIssues(
        { completeness: 'PARTIAL', items: [] },
        'pricing.optionalAncillaries',
      ),
    ).toEqual([]);
  });

  it('reconciles the mandatory all-in total with subtotal plus mandatory fees', () => {
    const candidate = candidateFixture();

    expect(
      offerPricingValidationIssues(
        candidate.transport.price,
        candidate.transport.additionalFees,
        candidate.transport.pricing,
        'transport.pricing',
      ),
    ).toEqual([]);

    const inconsistent = {
      ...candidate,
      transport: {
        ...candidate.transport,
        pricing: {
          ...candidate.transport.pricing,
          mandatoryTotal: createMoney(
            candidate.transport.pricing.mandatoryTotal.amountMinor! + 1,
            'PLN',
            'LIVE_PRICE',
            candidate.transport.sourceSnapshot,
          ),
        },
      },
    };

    expect(reasonCodes(inconsistent)).toContain('INCOMPLETE_DATA');
    expect(
      validateCandidate(inconsistent, candidateContext).reasons.find(
        (reason) => reason.code === 'INCOMPLETE_DATA',
      )?.details.fields,
    ).toContain('transport.pricing.mandatoryTotal');
  });

  it('rejects a mandatory total whose classification contradicts its mandatory components', () => {
    const candidate = candidateFixture();
    const source = candidate.transport.sourceSnapshot;
    if (source === null) throw new Error('Missing transport source fixture.');
    const pricing = {
      ...candidate.transport.pricing,
      mandatoryTotal: createMoney(
        candidate.transport.pricing.mandatoryTotal.amountMinor!,
        'PLN',
        'ESTIMATE',
        source,
      ),
    };

    expect(
      offerPricingValidationIssues(
        candidate.transport.price,
        candidate.transport.additionalFees,
        pricing,
        'transport.pricing',
      ),
    ).toContain('transport.pricing.mandatoryTotalClassification');
  });

  it('blocks UNKNOWN mandatory totals and mandatory fees without treating them as zero', () => {
    const candidate = candidateFixture();
    const unknownTotal = {
      ...candidate,
      transport: {
        ...candidate.transport,
        pricing: {
          ...candidate.transport.pricing,
          mandatoryTotal: unknownMoney('PLN', candidate.transport.sourceSnapshot),
        },
      },
    };
    const unknownFeesAndTotal = {
      ...candidate,
      stay: {
        ...candidate.stay,
        additionalFees: unknownMoney('PLN', candidate.stay.sourceSnapshot),
        pricing: {
          ...candidate.stay.pricing,
          mandatoryTotal: unknownMoney('PLN', candidate.stay.sourceSnapshot),
        },
      },
    };

    expect(reasonCodes(unknownTotal)).toContain('REQUIRED_PRICE_UNKNOWN');
    expect(reasonCodes(unknownFeesAndTotal)).toContain('REQUIRED_PRICE_UNKNOWN');
    expect(candidate.budget.totalAmountMinor).not.toBeNull();
    expect(unknownTotal.transport.pricing.mandatoryTotal.amountMinor).toBeNull();
    expect(unknownFeesAndTotal.stay.additionalFees.amountMinor).toBeNull();
  });

  it('keeps conditional and optional charges explicit, non-additive and outside required-price blocking', () => {
    const base = candidateFixture();
    const transportSource = base.transport.sourceSnapshot;
    if (transportSource === null) throw new Error('Missing transport source fixture.');
    const conditionalCharges: OfferChargeCollection<ConditionalChargeDisclosure> = {
      completeness: 'COMPLETE',
      items: [
        {
          id: 'city-tax',
          code: 'CITY_TAX',
          label: 'City tax',
          condition: 'Charged when the destination requires a local visitor tax.',
          payableAt: 'PROPERTY',
          mandatoryWhenConditionMet: true,
          amount: createMoney(2_500, 'PLN', 'FIXED_PRICE', transportSource),
        },
      ],
    };
    const optionalAncillaries: OfferChargeCollection<OptionalAncillaryDisclosure> = {
      completeness: 'PARTIAL',
      items: [
        {
          id: 'checked-baggage',
          code: 'CHECKED_BAGGAGE',
          label: 'Checked baggage',
          amount: unknownMoney('PLN', transportSource),
        },
      ],
    };
    const candidate: TripCandidate = {
      ...base,
      transport: {
        ...base.transport,
        pricing: {
          ...base.transport.pricing,
          conditionalCharges,
          optionalAncillaries,
        },
      },
      stay: {
        ...base.stay,
        pricing: {
          ...base.stay.pricing,
          optionalAncillaries: { completeness: 'UNKNOWN', items: [] },
        },
      },
    };

    expect(reasonCodes(candidate)).not.toContain('REQUIRED_PRICE_UNKNOWN');
    expect(reasonCodes(candidate)).toEqual([]);
    expect(candidate.budget).toStrictEqual(base.budget);
    expect(scoreCandidate(candidate, candidateContext)).toStrictEqual(
      scoreCandidate(base, candidateContext),
    );

    const bundle = persistenceBundle(candidate);
    const firstOption = bundle.rankedOptions.find((record) => record.rank === 1);
    if (firstOption === undefined) throw new Error('Missing persisted rank-one option.');
    const collections = bundle.offerChargeCollections.filter(
      (record) => record.rankedOption_ID === firstOption.ID,
    );
    const conditional = collections.find(
      (record) => record.scope === 'TRANSPORT' && record.kind === 'CONDITIONAL',
    );
    const optional = collections.find(
      (record) => record.scope === 'TRANSPORT' && record.kind === 'OPTIONAL',
    );
    const unknownStayOptional = collections.find(
      (record) => record.scope === 'ACCOMMODATION' && record.kind === 'OPTIONAL',
    );
    const disclosures = bundle.offerChargeDisclosures.filter(
      (record) => record.rankedOption_ID === firstOption.ID,
    );
    const budgetItems = bundle.budgetItems.filter(
      (record) => record.rankedOption_ID === firstOption.ID,
    );

    expect(collections).toHaveLength(4);
    expect(conditional).toMatchObject({ completeness: 'COMPLETE', itemCount: 1 });
    expect(optional).toMatchObject({ completeness: 'PARTIAL', itemCount: 1 });
    expect(unknownStayOptional).toMatchObject({ completeness: 'UNKNOWN', itemCount: 0 });
    expect(disclosures).toHaveLength(2);
    expect(budgetItems).toHaveLength(7);
    expect(disclosures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          chargeId: 'city-tax',
          label: 'City tax',
          condition: 'Charged when the destination requires a local visitor tax.',
          payableAt: 'PROPERTY',
          mandatoryWhenConditionMet: true,
          amountMinor: 2_500,
          classification: 'CONFIRMED',
          includedInBudget: false,
        }),
        expect.objectContaining({
          chargeId: 'checked-baggage',
          label: 'Checked baggage',
          condition: null,
          payableAt: null,
          mandatoryWhenConditionMet: null,
          amountMinor: null,
          classification: 'UNKNOWN',
          includedInBudget: false,
        }),
      ]),
    );
    expect(firstOption.totalAmountMinor).toBe(base.budget.totalAmountMinor);

    const baselineFingerprint = createProviderFingerprint(transportResultView(candidate.transport));
    for (const changedCharge of [
      { ...conditionalCharges.items[0]!, condition: 'Different normalized condition.' },
      { ...conditionalCharges.items[0]!, payableAt: 'AIRPORT' as const },
      { ...conditionalCharges.items[0]!, mandatoryWhenConditionMet: false },
      { ...conditionalCharges.items[0]!, label: 'Different label' },
    ]) {
      expect(
        createProviderFingerprint(
          transportResultView({
            ...candidate.transport,
            pricing: {
              ...candidate.transport.pricing,
              conditionalCharges: { completeness: 'COMPLETE', items: [changedCharge] },
            },
          }),
        ),
      ).not.toBe(baselineFingerprint);
    }
  });

  it('fails closed in candidate validation and persistence when one source ID has different lineage', () => {
    const base = candidateFixture();
    const transportSource = base.transport.sourceSnapshot;
    const staySource = base.stay.sourceSnapshot;
    if (transportSource === null || staySource === null) {
      throw new Error('Missing offer source fixture.');
    }
    const collision: SourceSnapshot = {
      ...staySource,
      id: transportSource.id,
      resultFingerprint: createProviderFingerprint({ collision: 'different-result' }),
    };
    const candidate: TripCandidate = {
      ...base,
      stay: { ...base.stay, sourceSnapshot: collision },
    };

    const validation = validateCandidate(candidate, candidateContext);
    expect(validation.reasons.map((reason) => reason.code)).toContain('INCOMPLETE_DATA');
    expect(
      validation.reasons.find((reason) => reason.code === 'INCOMPLETE_DATA')?.details.fields,
    ).toContain('sourceCollision:stay');
    expect(() => persistenceBundle(candidate)).toThrowError(
      expect.objectContaining({
        code: 'INVALID_FINAL_OPTION',
        message: 'Finalny wariant zawiera kolizję identyfikatora SourceSnapshot.',
      }),
    );
  });
});
