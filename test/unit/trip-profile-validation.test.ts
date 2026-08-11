import { describe, expect, it } from 'vitest';
import {
  createDefaultHardConstraints,
  createDefaultSoftPreferences,
  SOFT_PREFERENCE_KEYS,
} from '../../srv/domain/trip-request.js';
import type { HardConstraints } from '../../srv/domain/trip-request.js';
import { validateHardConstraints } from '../../srv/validation/hard-constraints-validation.js';
import { validateSoftPreferences } from '../../srv/validation/soft-preferences-validation.js';

describe('Trip profile defaults', () => {
  it('creates exact, independent hard constraint defaults', () => {
    const first = createDefaultHardConstraints();
    const second = createDefaultHardConstraints();

    expect(first).toEqual({
      hardBudgetLimit: true,
      earliestDepartureTime: null,
      latestReturnTime: null,
      maxConnections: 1,
      maxTravelMinutes: null,
      allowFlight: true,
      allowTrain: true,
      allowBus: true,
    });
    expect(first).not.toBe(second);
  });

  it('creates exact, independent neutral soft preference defaults', () => {
    const first = createDefaultSoftPreferences();
    const second = createDefaultSoftPreferences();

    expect(first).toEqual({
      food: 3,
      nature: 3,
      history: 3,
      museums: 3,
      nightlife: 3,
      centralAccommodation: 3,
      travelComfort: 3,
      priceSensitivity: 3,
    });
    expect(first).not.toBe(second);
  });
});

describe('Hard constraints validation', () => {
  it('accepts defaults and custom valid values', () => {
    expect(() => validateHardConstraints(createDefaultHardConstraints())).not.toThrow();
    expect(() =>
      validateHardConstraints({
        hardBudgetLimit: false,
        earliestDepartureTime: '00:00',
        latestReturnTime: '23:59',
        maxConnections: 0,
        maxTravelMinutes: 180,
        allowFlight: false,
        allowTrain: true,
        allowBus: false,
      }),
    ).not.toThrow();
  });

  it('rejects a profile without any allowed transport mode', () => {
    expect(() =>
      validateHardConstraints({
        ...createDefaultHardConstraints(),
        allowFlight: false,
        allowTrain: false,
        allowBus: false,
      }),
    ).toThrowError(/Co najmniej jeden środek transportu/);
  });

  it.each(['hardBudgetLimit', 'allowFlight', 'allowTrain', 'allowBus'] as const)(
    'rejects a non-boolean %s constraint',
    (field) => {
      const input = {
        ...createDefaultHardConstraints(),
        [field]: 'false',
      } as unknown as HardConstraints;

      expect(() => validateHardConstraints(input)).toThrowError(/musi być wartością logiczną/);
    },
  );

  it.each([-1, 1.5])('rejects invalid maxConnections (%s)', (maxConnections) => {
    expect(() =>
      validateHardConstraints({ ...createDefaultHardConstraints(), maxConnections }),
    ).toThrowError(/nieujemną liczbą całkowitą/);
  });

  it.each([0, -1, 1.5])('rejects invalid maxTravelMinutes (%s)', (maxTravelMinutes) => {
    expect(() =>
      validateHardConstraints({ ...createDefaultHardConstraints(), maxTravelMinutes }),
    ).toThrowError(/dodatnią liczbą całkowitą minut/);
  });

  it.each([
    ['earliestDepartureTime', '24:00'],
    ['earliestDepartureTime', '9:00'],
    ['latestReturnTime', '12:60'],
    ['latestReturnTime', '12:30:00'],
  ] as const)('rejects invalid HH:mm value for %s (%s)', (field, value) => {
    expect(() =>
      validateHardConstraints({ ...createDefaultHardConstraints(), [field]: value }),
    ).toThrowError(/musi mieć format HH:mm/);
  });
});

describe('Soft preferences validation', () => {
  it('accepts all default weights', () => {
    expect(() => validateSoftPreferences(createDefaultSoftPreferences())).not.toThrow();
  });

  it.each(SOFT_PREFERENCE_KEYS)('rejects %s below the minimum weight', (preference) => {
    expect(() =>
      validateSoftPreferences({ ...createDefaultSoftPreferences(), [preference]: 0 }),
    ).toThrowError(new RegExp(`Waga preferencji ${preference}`));
  });

  it.each(SOFT_PREFERENCE_KEYS)('rejects %s above the maximum weight', (preference) => {
    expect(() =>
      validateSoftPreferences({ ...createDefaultSoftPreferences(), [preference]: 6 }),
    ).toThrowError(new RegExp(`Waga preferencji ${preference}`));
  });

  it('rejects a non-integer preference weight', () => {
    expect(() =>
      validateSoftPreferences({ ...createDefaultSoftPreferences(), travelComfort: 2.5 }),
    ).toThrowError(/liczbą całkowitą od 1 do 5/);
  });
});
