import { describe, expect, it } from 'vitest';

import {
  BUDGET_CATEGORY_VALUES,
  REJECTION_CODE_VALUES,
  SELECTION_ROLE_VALUES,
  TRANSPORT_MODE_VALUES,
  type BudgetBreakdown,
  type Place,
  type PlanningContext,
  type RankedOption,
  type RejectionReason,
  type ScoreBreakdown,
  type StayOption,
  type TransportOption,
  type TripCandidate,
} from '../../srv/domain/candidate.ts';
import {
  SOURCE_SNAPSHOT_CONTRACT_VERSION,
  createMoney,
  unknownMoney,
  type SourceSnapshot,
} from '../../srv/domain/money.ts';
import {
  OFFER_PRICING_CONTRACT_VERSION,
  knownEmptyChargeCollection,
} from '../../srv/domain/offer-pricing.ts';
import { createProviderFingerprint } from '../../srv/providers/provider-fingerprint.ts';

const fixtureQueryFingerprint = createProviderFingerprint({ fixture: 'fixture-v1' });

const fixtureSnapshot: SourceSnapshot = {
  contractVersion: SOURCE_SNAPSHOT_CONTRACT_VERSION,
  id: 'snapshot-fixture-v1',
  sourceType: 'FIXTURE',
  provider: 'MOCK_PROVIDER',
  adapterVersion: 'mock-adapter-v1',
  providerVersion: 'fixture-v1',
  upstreamApiVersion: null,
  upstreamSchemaFingerprint: null,
  queryFingerprint: fixtureQueryFingerprint,
  resultFingerprint: createProviderFingerprint({ fixtureQueryFingerprint, item: 1 }),
  externalItemId: 'fixture-item-1',
  fetchedAt: '2026-01-01T00:00:00.000Z',
  expiresAt: null,
  sourceUrl: 'INTERNAL_FIXTURE',
  attribution: 'Candidate domain fixture',
  freshnessType: 'FIXTURE',
  currency: 'PLN',
  fixtureVersion: 'fixture-v1',
  termsPolicyVersion: 'test-fixture-terms-v1',
};

const internalRuleSnapshot: SourceSnapshot = {
  contractVersion: SOURCE_SNAPSHOT_CONTRACT_VERSION,
  id: 'snapshot-local-cost-rule-v1',
  sourceType: 'INTERNAL_RULE',
  provider: 'INTERNAL_ESTIMATOR',
  adapterVersion: 'internal-estimator-v1',
  providerVersion: 'local-cost-rule-v1',
  upstreamApiVersion: null,
  upstreamSchemaFingerprint: null,
  queryFingerprint: createProviderFingerprint({ rule: 'local-cost-rule-v1' }),
  resultFingerprint: createProviderFingerprint({ rule: 'local-cost-rule-v1', result: 1 }),
  externalItemId: 'local-cost-rule-v1',
  fetchedAt: '2026-01-01T00:00:00.000Z',
  expiresAt: null,
  sourceUrl: 'INTERNAL_FIXTURE',
  attribution: 'Candidate domain internal rule',
  freshnessType: 'INTERNAL_RULE',
  currency: 'PLN',
  fixtureVersion: 'local-cost-rule-v1',
  termsPolicyVersion: 'test-internal-rule-terms-v1',
};

const planningContext: PlanningContext = {
  tripRequestId: 'trip-request-1',
  originCity: 'Wrocław',
  startDate: '2026-09-17',
  endDate: '2026-09-20',
  adults: 2,
  totalBudgetMinor: 300_000,
  currency: 'PLN',
  pace: 'RELAXED',
  hardConstraints: {
    hardBudgetLimit: true,
    earliestDepartureTime: '06:00',
    latestReturnTime: '23:00',
    maxConnections: 1,
    maxTravelMinutes: 480,
    allowFlight: true,
    allowTrain: true,
    allowBus: false,
  },
  softPreferences: {
    food: 5,
    nature: 5,
    history: 3,
    museums: 2,
    nightlife: 1,
    centralAccommodation: 4,
    travelComfort: 3,
    priceSensitivity: 4,
  },
};

const transportPrice = createMoney(60_000, 'PLN', 'FIXED_PRICE', fixtureSnapshot);
const transportFees = createMoney(2_000, 'PLN', 'FIXED_PRICE', fixtureSnapshot);
const transport: TransportOption = {
  id: 'transport-prg-1',
  destinationCode: 'PRG',
  mode: 'TRAIN',
  outbound: {
    departureAt: '2026-09-17T07:00:00.000+02:00',
    arrivalAt: '2026-09-17T11:00:00.000+02:00',
    durationMinutes: 240,
    connections: 0,
  },
  return: {
    departureAt: '2026-09-20T17:00:00.000+02:00',
    arrivalAt: '2026-09-20T21:00:00.000+02:00',
    durationMinutes: 240,
    connections: 0,
  },
  price: transportPrice,
  additionalFees: transportFees,
  pricing: {
    contractVersion: OFFER_PRICING_CONTRACT_VERSION,
    mandatoryTotal: createMoney(62_000, 'PLN', 'FIXED_PRICE', fixtureSnapshot),
    conditionalCharges: knownEmptyChargeCollection(),
    optionalAncillaries: knownEmptyChargeCollection(),
  },
  sourceSnapshot: fixtureSnapshot,
};

const stayPrice = createMoney(120_000, 'PLN', 'FIXED_PRICE', fixtureSnapshot);
const stayFees = createMoney(5_000, 'PLN', 'FIXED_PRICE', fixtureSnapshot);
const stay: StayOption = {
  id: 'stay-prg-1',
  destinationCode: 'PRG',
  name: 'Mock Central Prague',
  checkInDate: '2026-09-17',
  checkOutDate: '2026-09-20',
  nights: 3,
  price: stayPrice,
  additionalFees: stayFees,
  pricing: {
    contractVersion: OFFER_PRICING_CONTRACT_VERSION,
    mandatoryTotal: createMoney(125_000, 'PLN', 'FIXED_PRICE', fixtureSnapshot),
    conditionalCharges: knownEmptyChargeCollection(),
    optionalAncillaries: knownEmptyChargeCollection(),
  },
  centralityScore: 92,
  sourceSnapshot: fixtureSnapshot,
};

const place: Place = {
  id: 'place-prg-park',
  destinationCode: 'PRG',
  name: 'Mock Riverside Park',
  preferenceScores: {
    food: 3,
    nature: 5,
    history: 2,
    museums: 1,
    nightlife: 1,
    centralAccommodation: 3,
    travelComfort: 3,
    priceSensitivity: 4,
  },
  sourceSnapshot: fixtureSnapshot,
};

const completeBudget: BudgetBreakdown = {
  transport: transport.price,
  accommodation: stay.price,
  localTransport: createMoney(12_000, 'PLN', 'ESTIMATE', internalRuleSnapshot),
  food: createMoney(36_000, 'PLN', 'ESTIMATE', internalRuleSnapshot),
  attractions: createMoney(14_000, 'PLN', 'ESTIMATE', internalRuleSnapshot),
  additionalFees: createMoney(7_000, 'PLN', 'FIXED_PRICE', fixtureSnapshot),
  buffer: createMoney(12_450, 'PLN', 'ESTIMATE', internalRuleSnapshot),
  categoryAmounts: {
    TRANSPORT: { confirmedAmountMinor: 60_000, estimatedAmountMinor: 0 },
    ACCOMMODATION: { confirmedAmountMinor: 120_000, estimatedAmountMinor: 0 },
    LOCAL_TRANSPORT: { confirmedAmountMinor: 0, estimatedAmountMinor: 12_000 },
    FOOD: { confirmedAmountMinor: 0, estimatedAmountMinor: 36_000 },
    ATTRACTIONS: { confirmedAmountMinor: 0, estimatedAmountMinor: 14_000 },
    ADDITIONAL_FEES: { confirmedAmountMinor: 7_000, estimatedAmountMinor: 0 },
    BUFFER: { confirmedAmountMinor: 0, estimatedAmountMinor: 12_450 },
  },
  budgetLimitMinor: 300_000,
  confirmedAmountMinor: 187_000,
  estimatedAmountMinor: 74_450,
  unknownCategories: [],
  totalAmountMinor: 261_450,
  costPerPersonMinor: 130_725,
  remainingBudgetMinor: 38_550,
};

const candidate: TripCandidate = {
  id: 'candidate-prg-1',
  destination: { code: 'PRG', city: 'Prague', countryCode: 'CZ' },
  transport,
  stay,
  places: [place],
  localCostEstimates: {
    localTransport: completeBudget.localTransport,
    food: completeBudget.food,
    attractions: completeBudget.attractions,
  },
  budget: completeBudget,
  effectiveTimeAtDestinationMinutes: 4_680,
};

describe('modele domenowe kandydatów', () => {
  it('publikuje zamknięte wartości środków transportu, kategorii budżetu i ról', () => {
    expect(TRANSPORT_MODE_VALUES).toEqual(['FLIGHT', 'TRAIN', 'BUS']);
    expect(BUDGET_CATEGORY_VALUES).toEqual([
      'TRANSPORT',
      'ACCOMMODATION',
      'LOCAL_TRANSPORT',
      'FOOD',
      'ATTRACTIONS',
      'ADDITIONAL_FEES',
      'BUFFER',
    ]);
    expect(SELECTION_ROLE_VALUES).toEqual(['BEST_OVERALL', 'MOST_CONVENIENT', 'BEST_VALUE']);
  });

  it('przenosi brief do PlanningContext wyłącznie z budżetem w integer minor units', () => {
    expect(planningContext).toMatchObject({
      originCity: 'Wrocław',
      adults: 2,
      totalBudgetMinor: 300_000,
      currency: 'PLN',
      pace: 'RELAXED',
    });
    expect(Number.isSafeInteger(planningContext.totalBudgetMinor)).toBe(true);
  });

  it('buduje jawny kontrakt transportu, noclegu, miejsc i kandydata', () => {
    expect(candidate.destination).toEqual({ code: 'PRG', city: 'Prague', countryCode: 'CZ' });
    expect(candidate.transport.outbound).toMatchObject({ durationMinutes: 240, connections: 0 });
    expect(candidate.stay).toMatchObject({ nights: 3, centralityScore: 92 });
    expect(candidate.places[0]?.preferenceScores).toMatchObject({ food: 3, nature: 5 });
    expect(candidate.effectiveTimeAtDestinationMinutes).toBe(4_680);
  });

  it('każda cena i każdy fakt mogą wskazać ten sam utrwalony snapshot fixture', () => {
    expect(candidate.transport.sourceSnapshot).toBe(fixtureSnapshot);
    expect(candidate.transport.price.sourceSnapshot).toBe(fixtureSnapshot);
    expect(candidate.stay.sourceSnapshot).toBe(fixtureSnapshot);
    expect(candidate.places[0]?.sourceSnapshot).toBe(fixtureSnapshot);
    expect(candidate.localCostEstimates.food.sourceSnapshot).toBe(internalRuleSnapshot);
    expect(internalRuleSnapshot.fixtureVersion).toBe('local-cost-rule-v1');
  });

  it('rozróżnia potwierdzone, estymowane i brakujące kategorie budżetu', () => {
    expect(completeBudget).toMatchObject({
      confirmedAmountMinor: 187_000,
      estimatedAmountMinor: 74_450,
      unknownCategories: [],
      totalAmountMinor: 261_450,
      costPerPersonMinor: 130_725,
      remainingBudgetMinor: 38_550,
    });

    const incompleteBudget: BudgetBreakdown = {
      ...completeBudget,
      food: unknownMoney('PLN', internalRuleSnapshot),
      categoryAmounts: {
        ...completeBudget.categoryAmounts,
        FOOD: { confirmedAmountMinor: 0, estimatedAmountMinor: 0 },
      },
      unknownCategories: ['FOOD'],
      totalAmountMinor: null,
      costPerPersonMinor: null,
      remainingBudgetMinor: null,
    };

    expect(incompleteBudget.food.amountMinor).toBeNull();
    expect(incompleteBudget.unknownCategories).toEqual(['FOOD']);
    expect(incompleteBudget.totalAmountMinor).toBeNull();
    expect(incompleteBudget.costPerPersonMinor).toBeNull();
    expect(incompleteBudget.remainingBudgetMinor).toBeNull();
  });

  it('publikuje dokładnie wszystkie jawne kody odrzucenia', () => {
    expect(REJECTION_CODE_VALUES).toEqual([
      'BUDGET_EXCEEDED',
      'DEPARTURE_TOO_EARLY',
      'RETURN_TOO_LATE',
      'TOO_MANY_CONNECTIONS',
      'TRANSPORT_MODE_NOT_ALLOWED',
      'TRAVEL_TIME_EXCEEDED',
      'REQUIRED_PRICE_UNKNOWN',
      'SOURCE_MISSING',
      'CURRENCY_MISMATCH',
      'DUPLICATE_CANDIDATE',
      'INSUFFICIENT_TIME_AT_DESTINATION',
      'INVALID_DATES',
      'INCOMPLETE_DATA',
    ]);
  });

  it.each(REJECTION_CODE_VALUES)('modeluje powód %s z danymi maszynowymi', (code) => {
    const reason: RejectionReason = {
      code,
      candidateId: candidate.id,
      details: { ruleVersion: 'constraints-v1', hardConstraint: true },
      message: `Kandydat odrzucony: ${code}.`,
      expected: { maximum: 1 },
      actual: { value: 2 },
    };

    expect(reason).toMatchObject({
      code,
      candidateId: 'candidate-prg-1',
      details: { ruleVersion: 'constraints-v1', hardConstraint: true },
      expected: { maximum: 1 },
      actual: { value: 2 },
    });
  });

  it('pozwala wskazać optionId, gdy błąd dotyczy surowej oferty', () => {
    const reason: RejectionReason = {
      code: 'SOURCE_MISSING',
      optionId: 'transport-without-source',
      details: { field: 'sourceSnapshot' },
      message: 'Oferta transportu nie ma źródła.',
      expected: 'SourceSnapshot',
      actual: null,
    };

    expect(reason.optionId).toBe('transport-without-source');
    expect(reason.actual).toBeNull();
  });

  it('przechowuje deterministyczny, wersjonowany score i rolę wybranej opcji', () => {
    const score: ScoreBreakdown = {
      scoreVersion: 'candidate-score-v1',
      budgetFit: 90,
      travelTime: 82,
      effectiveTimeAtDestination: 95,
      accommodationLocation: 92,
      dataCompleteness: 100,
      priceConfidence: 88,
      deterministicPreferenceFit: 91,
      total: 90.1,
      reasonCodes: ['STRONG_BUDGET_FIT', 'CENTRAL_STAY'],
      reasonTexts: ['Duża rezerwa budżetowa.', 'Nocleg blisko centrum.'],
    };
    const ranked: RankedOption = {
      rank: 1,
      role: 'BEST_OVERALL',
      candidate,
      score,
    };

    expect(ranked).toMatchObject({
      rank: 1,
      role: 'BEST_OVERALL',
      score: { scoreVersion: 'candidate-score-v1', total: 90.1 },
    });
  });
});
