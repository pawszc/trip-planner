import { describe, expect, it } from 'vitest';
import type { PlanningContext, TripCandidate } from '../../srv/domain/candidate.js';
import { filterCandidates } from '../../srv/ranking/candidate-filter.js';
import { rankCandidates, scoreCandidate } from '../../srv/ranking/candidate-scoring.js';
import { selectDiverseOptions } from '../../srv/ranking/candidate-selection.js';
import { CANDIDATE_SCORING_WEIGHTS } from '../../srv/ranking/config.js';
import { candidateContext, candidateFixture } from './candidate-fixtures.js';

function withDestination(
  candidate: TripCandidate,
  code: string,
  centralityScore: number,
  totalAmountMinor: number,
): TripCandidate {
  return {
    ...candidate,
    id: `candidate-${code}`,
    destination: { code, city: `City ${code}`, countryCode: 'EU' },
    transport: { ...candidate.transport, id: `transport-${code}`, destinationCode: code },
    stay: {
      ...candidate.stay,
      id: `stay-${code}`,
      destinationCode: code,
      name: `Hotel ${code}`,
      centralityScore,
    },
    places: candidate.places.map((place) => ({
      ...place,
      id: `${place.id}-${code}`,
      destinationCode: code,
    })),
    budget: {
      ...candidate.budget,
      totalAmountMinor,
      costPerPersonMinor: Number(
        (BigInt(totalAmountMinor) + BigInt(candidateContext.adults) - 1n) /
          BigInt(candidateContext.adults),
      ),
      remainingBudgetMinor: candidateContext.totalBudgetMinor - totalAmountMinor,
    },
  };
}

describe('candidate scoring and diversity', () => {
  it('keeps every component and the weighted total in 0..100 with explicit versioned weights', () => {
    const score = scoreCandidate(candidateFixture(), candidateContext);
    const weighted =
      (score.budgetFit * CANDIDATE_SCORING_WEIGHTS.budgetFit +
        score.travelTime * CANDIDATE_SCORING_WEIGHTS.travelTime +
        score.effectiveTimeAtDestination * CANDIDATE_SCORING_WEIGHTS.effectiveTimeAtDestination +
        score.accommodationLocation * CANDIDATE_SCORING_WEIGHTS.accommodationLocation +
        score.dataCompleteness * CANDIDATE_SCORING_WEIGHTS.dataCompleteness +
        score.priceConfidence * CANDIDATE_SCORING_WEIGHTS.priceConfidence +
        score.deterministicPreferenceFit * CANDIDATE_SCORING_WEIGHTS.deterministicPreferenceFit) /
      100;

    for (const component of [
      score.budgetFit,
      score.travelTime,
      score.effectiveTimeAtDestination,
      score.accommodationLocation,
      score.dataCompleteness,
      score.priceConfidence,
      score.deterministicPreferenceFit,
      score.total,
    ]) {
      expect(component).toBeGreaterThanOrEqual(0);
      expect(component).toBeLessThanOrEqual(100);
    }
    expect(score.total).toBeCloseTo(weighted, 2);
    expect(score.scoreVersion).toContain('candidate-score-v1');
    expect(score.reasonCodes).toHaveLength(7);
    expect(score.reasonTexts).toHaveLength(7);
    expect(score).toStrictEqual({
      scoreVersion: 'candidate-score-v1:candidate-engine-v1',
      budgetFit: 32.53,
      travelTime: 50,
      effectiveTimeAtDestination: 79.17,
      accommodationLocation: 90,
      dataCompleteness: 100,
      priceConfidence: 86.21,
      deterministicPreferenceFit: 65.38,
      total: 67.81,
      reasonCodes: [
        'BUDGET_FIT',
        'TRAVEL_TIME',
        'EFFECTIVE_TIME',
        'ACCOMMODATION_LOCATION',
        'DATA_COMPLETENESS',
        'PRICE_CONFIDENCE',
        'PREFERENCE_FIT',
      ],
      reasonTexts: [
        'Dopasowanie do budżetu: 32.53/100.',
        'Czas podróży: 50.00/100.',
        'Efektywny czas na miejscu: 79.17/100.',
        'Lokalizacja noclegu: 90.00/100.',
        'Kompletność danych: 100.00/100.',
        'Pewność ceny: 86.21/100.',
        'Dopasowanie preferencji: 65.38/100.',
      ],
    });
  });

  it('changes deterministic preference fit when the user weights matching interests', () => {
    const candidate = candidateFixture();
    const place = candidate.places[0];
    if (!place) throw new Error('Missing place fixture.');
    const focused = {
      ...candidate,
      places: [
        {
          ...place,
          preferenceScores: { ...place.preferenceScores, food: 100, nature: 0 },
        },
      ],
    };
    const foodContext: PlanningContext = {
      ...candidateContext,
      softPreferences: {
        ...candidateContext.softPreferences,
        food: 5,
        nature: 1,
      },
    };
    const natureContext: PlanningContext = {
      ...candidateContext,
      softPreferences: {
        ...candidateContext.softPreferences,
        food: 1,
        nature: 5,
      },
    };

    expect(scoreCandidate(focused, foodContext).deterministicPreferenceFit).toBeGreaterThan(
      scoreCandidate(focused, natureContext).deterministicPreferenceFit,
    );
  });

  it('has stable ranking independent of provider input order', () => {
    const base = candidateFixture();
    const candidates = [
      withDestination(base, 'VIE', 80, 280_000),
      withDestination(base, 'BER', 75, 260_000),
      withDestination(base, 'PRG', 90, 300_000),
    ];
    const forward = rankCandidates(candidates, candidateContext).map((item) => item.candidate.id);
    const reverse = rankCandidates([...candidates].reverse(), candidateContext).map(
      (item) => item.candidate.id,
    );
    expect(reverse).toEqual(forward);
  });

  it('assigns all three roles while preferring different destinations', () => {
    const base = candidateFixture();
    const ranked = rankCandidates(
      [
        withDestination(base, 'PRG', 95, 300_000),
        withDestination(base, 'VIE', 85, 270_000),
        withDestination(base, 'BER', 75, 240_000),
      ],
      candidateContext,
    );
    const result = selectDiverseOptions(ranked);

    expect(result.options.map((option) => option.role)).toEqual([
      'BEST_OVERALL',
      'MOST_CONVENIENT',
      'BEST_VALUE',
    ]);
    expect(new Set(result.options.map((option) => option.candidate.destination.code)).size).toBe(3);
    expect(result.shortage).toBeNull();
  });

  it('does not select the same semantic transport + hotel twice', () => {
    const original = candidateFixture();
    const duplicate = {
      ...original,
      id: 'duplicate-provider-candidate',
      transport: { ...original.transport, id: 'other-provider-id' },
    };
    const distinct = withDestination(original, 'VIE', 80, 250_000);
    const result = selectDiverseOptions(
      rankCandidates([original, duplicate, distinct], candidateContext),
    );

    expect(result.options).toHaveLength(2);
    expect(result.shortage).toMatchObject({ required: 3, available: 2, missing: 1 });
  });

  it('returns exactly two distinct valid candidates with an explicit one-option shortage', () => {
    const base = candidateFixture();
    const ranked = rankCandidates(
      [withDestination(base, 'PRG', 95, 300_000), withDestination(base, 'VIE', 85, 270_000)],
      candidateContext,
    );
    const result = selectDiverseOptions(ranked);

    expect(result.options).toHaveLength(2);
    expect(result.options.map((option) => option.candidate.id).sort()).toEqual(
      ranked.map((item) => item.candidate.id).sort(),
    );
    expect(result.shortage).toStrictEqual({
      code: 'INSUFFICIENT_VALID_CANDIDATES',
      required: 3,
      available: 2,
      missing: 1,
      message: 'Dostępne warianty: 2 z wymaganych 3; ograniczenia nie zostały poluzowane.',
    });
  });

  it('returns the valid shortage without relaxing a hard budget', () => {
    const candidate = candidateFixture();
    const overBudget = {
      ...candidate,
      budget: {
        ...candidate.budget,
        totalAmountMinor: candidateContext.totalBudgetMinor + 1,
      },
    };
    const filtered = filterCandidates([overBudget], candidateContext);
    const result = selectDiverseOptions(rankCandidates(filtered.validCandidates, candidateContext));

    expect(filtered.validCandidates).toEqual([]);
    expect(filtered.rejectedCandidates[0]?.reasons.map((reason) => reason.code)).toContain(
      'BUDGET_EXCEEDED',
    );
    expect(result.options).toEqual([]);
    expect(result.shortage).toMatchObject({ required: 3, available: 0, missing: 3 });
  });
});
