import { describe, expect, it } from 'vitest';
import { buildCandidates } from '../../srv/ranking/candidate-builder.js';
import {
  divideMinorUnitsCeil,
  INTERNAL_COST_FIXTURE_VERSION,
  INTERNAL_COST_RATES,
} from '../../srv/ranking/budget.js';
import {
  candidateContext,
  candidateDestination,
  candidatePlace,
  candidateStay,
  candidateTransport,
} from './candidate-fixtures.js';
import { createMoney, unknownMoney } from '../../srv/domain/money.js';

describe('candidate builder and budget', () => {
  it('enforces every configured per-destination bound deterministically', () => {
    const transports = [candidateTransport('z'), candidateTransport('a'), candidateTransport('m')];
    const stays = [candidateStay('z'), candidateStay('a'), candidateStay('m')];
    const places = [candidatePlace('z'), candidatePlace('a'), candidatePlace('m')];
    const result = buildCandidates({
      context: candidateContext,
      destinations: [candidateDestination],
      transportOptions: transports,
      stayOptions: stays,
      places,
      config: {
        limits: {
          maxTransportOptionsPerDestination: 2,
          maxStayOptionsPerDestination: 2,
          maxPlacesPerDestination: 1,
          maxCandidatesPerDestination: 3,
        },
      },
    });

    expect(result.transportOptionCount).toBe(2);
    expect(result.stayOptionCount).toBe(2);
    expect(result.candidates).toHaveLength(3);
    expect(result.candidates.every((candidate) => candidate.places.length === 1)).toBe(true);
    expect(result.candidates[0]?.id).toBe('PRG::a::a');
  });

  it('deduplicates destination codes before applying the per-destination candidate limit', () => {
    const result = buildCandidates({
      context: candidateContext,
      destinations: [candidateDestination, { ...candidateDestination, city: 'Duplicate Prague' }],
      transportOptions: [candidateTransport('a'), candidateTransport('b')],
      stayOptions: [candidateStay('a'), candidateStay('b')],
      places: [],
      config: { limits: { maxCandidatesPerDestination: 3 } },
    });
    expect(result.destinationCount).toBe(1);
    expect(result.candidates).toHaveLength(3);
  });

  it('uses integer minor units and versioned INTERNAL_FIXTURE estimate sources', () => {
    const [candidate] = buildCandidates({
      context: candidateContext,
      destinations: [candidateDestination],
      transportOptions: [candidateTransport()],
      stayOptions: [candidateStay()],
      places: [candidatePlace()],
    }).candidates;

    expect(candidate).toBeDefined();
    expect(candidate?.localCostEstimates.food.amountMinor).toBe(
      INTERNAL_COST_RATES.foodPerPersonDayMinor * 2 * 4,
    );
    for (const money of [
      candidate?.budget.localTransport,
      candidate?.budget.food,
      candidate?.budget.attractions,
      candidate?.budget.buffer,
    ]) {
      expect(Number.isSafeInteger(money?.amountMinor)).toBe(true);
      expect(money?.sourceSnapshot?.provider).toBe('INTERNAL_FIXTURE');
      expect(money?.sourceSnapshot?.fixtureVersion).toBe(INTERNAL_COST_FIXTURE_VERSION);
    }
    expect(candidate?.budget.totalAmountMinor).not.toBeNull();
    expect(candidate?.budget.unknownCategories).toEqual([]);
    expect(candidate?.budget).toMatchObject({
      transport: { amountMinor: 64_000 },
      accommodation: { amountMinor: 90_000 },
      localTransport: { amountMinor: 16_000 },
      food: { amountMinor: 64_000 },
      attractions: { amountMinor: 32_000 },
      additionalFees: { amountMinor: 10_000 },
      buffer: { amountMinor: 27_600 },
      confirmedAmountMinor: 164_000,
      estimatedAmountMinor: 139_600,
      totalAmountMinor: 303_600,
      costPerPersonMinor: 151_800,
      remainingBudgetMinor: 146_400,
    });
  });

  it('never replaces an unknown required provider price with zero', () => {
    const transport = candidateTransport();
    const candidate = buildCandidates({
      context: candidateContext,
      destinations: [candidateDestination],
      transportOptions: [
        {
          ...transport,
          price: {
            amountMinor: null,
            currency: 'PLN',
            priceType: 'UNKNOWN',
            sourceSnapshot: transport.sourceSnapshot,
          },
        },
      ],
      stayOptions: [candidateStay()],
      places: [],
    }).candidates[0];

    expect(candidate?.budget.transport.amountMinor).toBeNull();
    expect(candidate?.budget.totalAmountMinor).toBeNull();
    expect(candidate?.budget.unknownCategories).toContain('TRANSPORT');
    expect(candidate?.budget.remainingBudgetMinor).toBeNull();
  });

  it('marks a currency mismatch as unknown total and never performs implicit FX', () => {
    const transport = candidateTransport();
    const eurSource = {
      ...transport.sourceSnapshot!,
      id: 'source-eur',
      currency: 'EUR',
    };
    const candidate = buildCandidates({
      context: candidateContext,
      destinations: [candidateDestination],
      transportOptions: [
        {
          ...transport,
          price: createMoney(15_000, 'EUR', 'FIXED_PRICE', eurSource),
        },
      ],
      stayOptions: [candidateStay()],
      places: [],
    }).candidates[0];

    expect(candidate?.budget.transport.currency).toBe('EUR');
    expect(candidate?.budget.totalAmountMinor).toBeNull();
    expect(candidate?.budget.unknownCategories).toContain('TRANSPORT');
  });

  it('preserves confirmed and estimated classification for separate additional fees', () => {
    const stay = candidateStay();
    const candidate = buildCandidates({
      context: candidateContext,
      destinations: [candidateDestination],
      transportOptions: [candidateTransport()],
      stayOptions: [
        {
          ...stay,
          additionalFees: createMoney(6_000, 'PLN', 'ESTIMATE', stay.additionalFees.sourceSnapshot),
        },
      ],
      places: [],
    }).candidates[0];

    expect(candidate?.budget.additionalFees).toMatchObject({
      amountMinor: 10_000,
      priceType: 'ESTIMATE',
    });
    expect(candidate?.budget).toMatchObject({
      confirmedAmountMinor: 158_000,
      estimatedAmountMinor: 145_600,
      totalAmountMinor: 303_600,
    });
  });

  it('keeps a known fee in partial totals when the other fee is UNKNOWN', () => {
    const stay = candidateStay();
    const candidate = buildCandidates({
      context: candidateContext,
      destinations: [candidateDestination],
      transportOptions: [candidateTransport()],
      stayOptions: [
        {
          ...stay,
          additionalFees: unknownMoney('PLN', stay.additionalFees.sourceSnapshot),
        },
      ],
      places: [],
    }).candidates[0];

    expect(candidate?.budget.additionalFees.priceType).toBe('UNKNOWN');
    expect(candidate?.budget).toMatchObject({
      confirmedAmountMinor: 158_000,
      estimatedAmountMinor: 112_000,
      unknownCategories: ['ADDITIONAL_FEES', 'BUFFER'],
      totalAmountMinor: null,
    });
  });

  it('ceil-divides minor units without floating-point financial arithmetic', () => {
    expect(divideMinorUnitsCeil(101, 2)).toBe(51);
    expect(Number.isSafeInteger(divideMinorUnitsCeil(Number.MAX_SAFE_INTEGER, 3))).toBe(true);
  });
});
