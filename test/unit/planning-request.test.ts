import { describe, expect, it } from 'vitest';
import {
  CURRENCY_CONTRACT_VERSION,
  SUPPORTED_CURRENCY_CODES,
  SUPPORTED_CURRENCY_DEFINITIONS,
} from '../../srv/domain/currency.ts';
import type { PersistedTripRequest } from '../../srv/mapping/trip-request-mapper.js';
import {
  createPlanningContext,
  createPlanningFingerprint,
  majorUnitsToMinorUnits,
} from '../../srv/orchestration/planning-request.js';

const persistedTripRequest = {
  ID: 'trip-1',
  status: 'CONSTRAINTS_CONFIRMED',
  originCity: 'Wrocław',
  startDate: '2026-10-10',
  endDate: '2026-10-13',
  adults: 2,
  totalBudget: 4500,
  currency: 'PLN',
  pace: 'RELAXED',
  hardConstraints_hardBudgetLimit: true,
  hardConstraints_earliestDepartureTime: '07:00',
  hardConstraints_latestReturnTime: '22:00',
  hardConstraints_maxConnections: 1,
  hardConstraints_maxTravelMinutes: 480,
  hardConstraints_allowFlight: false,
  hardConstraints_allowTrain: true,
  hardConstraints_allowBus: true,
  softPreferences_food: 5,
  softPreferences_nature: 5,
  softPreferences_history: 3,
  softPreferences_museums: 2,
  softPreferences_nightlife: 1,
  softPreferences_centralAccommodation: 4,
  softPreferences_travelComfort: 4,
  softPreferences_priceSensitivity: 4,
} satisfies PersistedTripRequest;

describe('planning request mapping', () => {
  it.each([
    ['4500', 450_000],
    ['4500.1', 450_010],
    ['4500.01', 450_001],
  ])('converts %s to exact integer minor units', (major, expected) => {
    expect(majorUnitsToMinorUnits(major, 'PLN')).toBe(expected);
  });

  it.each(['1.001', '-1', 'NaN'])('rejects an unsafe decimal budget (%s)', (value) => {
    expect(() => majorUnitsToMinorUnits(value, 'PLN')).toThrowError(/Budżet/);
  });

  it('uses one closed, versioned two-decimal currency contract', () => {
    expect(CURRENCY_CONTRACT_VERSION).toBe('currency-fraction-digits-v1');
    expect(SUPPORTED_CURRENCY_CODES).toEqual(['EUR', 'PLN']);
    expect(Object.values(SUPPORTED_CURRENCY_DEFINITIONS)).toEqual([
      { code: 'EUR', fractionDigits: 2 },
      { code: 'PLN', fractionDigits: 2 },
    ]);
    expect(majorUnitsToMinorUnits('12.34', 'EUR')).toBe(1_234);
  });

  it.each(['JPY', 'KWD', 'USD', 'ZZZ'])(
    'rejects currency %s outside the current budget contract',
    (currency) => {
      expect(() => majorUnitsToMinorUnits('12.34', currency)).toThrowError(
        expect.objectContaining({ code: 'INVALID_CURRENCY' }),
      );
    },
  );

  it('rejects an unsupported persisted currency before creating a planning context', () => {
    expect(() => createPlanningContext({ ...persistedTripRequest, currency: 'JPY' })).toThrowError(
      expect.objectContaining({ code: 'INVALID_CURRENCY' }),
    );
  });

  it('maps the confirmed flat CAP record to the complete planning context', () => {
    expect(createPlanningContext(persistedTripRequest)).toMatchObject({
      tripRequestId: 'trip-1',
      originCity: 'Wrocław',
      totalBudgetMinor: 450_000,
      hardConstraints: { allowFlight: false, maxTravelMinutes: 480 },
      softPreferences: { food: 5, nature: 5 },
    });
  });

  it('creates a stable fingerprint that changes with a relevant version', () => {
    const context = createPlanningContext(persistedTripRequest);
    const versions = {
      providerFixtureVersion: 'fixture-v1',
      engineVersion: 'engine-v1',
      scoringVersion: 'score-v1',
    };
    const first = createPlanningFingerprint(context, versions);
    const repeat = createPlanningFingerprint(context, versions);
    const changed = createPlanningFingerprint(context, { ...versions, scoringVersion: 'score-v2' });

    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(repeat).toBe(first);
    expect(changed).not.toBe(first);
  });
});
