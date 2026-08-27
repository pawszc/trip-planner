import { describe, expect, it } from 'vitest';

import {
  FRESHNESS_TYPE_VALUES,
  MONEY_CLASSIFICATION_VALUES,
  MoneyError,
  PRICE_TYPE_VALUES,
  SOURCE_SNAPSHOT_CONTRACT_VERSION,
  SOURCE_TYPE_VALUES,
  addMinorUnits,
  assertMoneyCurrency,
  classifyMoney,
  createMoney,
  isKnownMoney,
  sumMoney,
  unknownMoney,
  type KnownPriceType,
  type SourceSnapshot,
} from '../../srv/domain/money.ts';
import { createProviderFingerprint } from '../../srv/providers/provider-fingerprint.ts';

const queryFingerprint = createProviderFingerprint({ fixture: 'transport-v1' });
const snapshot: SourceSnapshot = {
  contractVersion: SOURCE_SNAPSHOT_CONTRACT_VERSION,
  id: 'snapshot-transport-1',
  sourceType: 'FIXTURE',
  provider: 'MOCK_TRANSPORT',
  adapterVersion: 'mock-transport-v1',
  providerVersion: 'transport-v1',
  upstreamApiVersion: null,
  upstreamSchemaFingerprint: null,
  queryFingerprint,
  resultFingerprint: createProviderFingerprint({ queryFingerprint, item: 'transport-1' }),
  externalItemId: 'transport-1',
  fetchedAt: '2026-01-01T00:00:00.000Z',
  expiresAt: null,
  sourceUrl: 'INTERNAL_FIXTURE',
  attribution: 'Money test fixture',
  freshnessType: 'FIXTURE',
  currency: 'PLN',
  fixtureVersion: 'transport-v1',
  termsPolicyVersion: 'test-fixture-terms-v1',
};

describe('Money', () => {
  it('publikuje kompletny, stabilny zestaw typów cen i świeżości źródeł', () => {
    expect(PRICE_TYPE_VALUES).toEqual(['LIVE_PRICE', 'FIXED_PRICE', 'ESTIMATE', 'UNKNOWN']);
    expect(FRESHNESS_TYPE_VALUES).toEqual(['LIVE', 'CACHED', 'FIXTURE', 'INTERNAL_RULE']);
    expect(SOURCE_TYPE_VALUES).toEqual(['LIVE', 'FIXTURE', 'INTERNAL_RULE']);
    expect(MONEY_CLASSIFICATION_VALUES).toEqual(['CONFIRMED', 'ESTIMATED', 'UNKNOWN']);
  });

  it.each([
    ['LIVE_PRICE', 'CONFIRMED'],
    ['FIXED_PRICE', 'CONFIRMED'],
    ['ESTIMATE', 'ESTIMATED'],
  ] as const)('tworzy bezpieczną cenę %s i klasyfikuje ją jako %s', (priceType, classification) => {
    const money = createMoney(12_345, 'PLN', priceType, snapshot);

    expect(money).toEqual({
      amountMinor: 12_345,
      currency: 'PLN',
      priceType,
      sourceSnapshot: snapshot,
    });
    expect(classifyMoney(money)).toBe(classification);
    expect(isKnownMoney(money)).toBe(true);
  });

  it('reprezentuje UNKNOWN przez null bez domyślnej lub wymyślonej kwoty', () => {
    const money = unknownMoney('PLN', snapshot);

    expect(money).toEqual({
      amountMinor: null,
      currency: 'PLN',
      priceType: 'UNKNOWN',
      sourceSnapshot: snapshot,
    });
    expect(classifyMoney(money)).toBe('UNKNOWN');
    expect(isKnownMoney(money)).toBe(false);
  });

  it('dopuszcza brak snapshotu wyłącznie jako jawny stan wejściowy dla filtra', () => {
    expect(createMoney(1_000, 'EUR', 'LIVE_PRICE', null).sourceSnapshot).toBeNull();
    expect(unknownMoney('EUR', null).sourceSnapshot).toBeNull();
  });

  it.each([-1, 0.1, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'odrzuca niekontrolowaną kwotę minor units: %s',
    (amountMinor) => {
      expect(() => createMoney(amountMinor, 'PLN', 'FIXED_PRICE', snapshot)).toThrowError(
        expect.objectContaining({ code: 'INVALID_MINOR_AMOUNT' }),
      );
    },
  );

  it.each(['pln', 'PL', 'PLNN', '', 'P1N', 'USD', 'JPY', 'KWD', 'ZZZ'])(
    'odrzuca nieobsługiwany kod waluty %s',
    (currency) => {
      expect(() => createMoney(100, currency, 'FIXED_PRICE', snapshot)).toThrowError(
        expect.objectContaining({ code: 'INVALID_CURRENCY' }),
      );
      expect(() => unknownMoney(currency, snapshot)).toThrowError(
        expect.objectContaining({ code: 'INVALID_CURRENCY' }),
      );
    },
  );

  it('bezpiecznie sumuje potwierdzone i estymowane kwoty osobno', () => {
    const prices = [
      createMoney(10_000, 'PLN', 'LIVE_PRICE', snapshot),
      createMoney(2_500, 'PLN', 'FIXED_PRICE', snapshot),
      createMoney(3_400, 'PLN', 'ESTIMATE', snapshot),
    ];

    expect(sumMoney(prices, 'PLN')).toEqual({
      currency: 'PLN',
      confirmedAmountMinor: 12_500,
      estimatedAmountMinor: 3_400,
      knownAmountMinor: 15_900,
      unknownCount: 0,
      totalAmountMinor: 15_900,
    });
  });

  it('nie traktuje UNKNOWN jak zera w sumie całkowitej', () => {
    const prices = [
      createMoney(10_000, 'PLN', 'FIXED_PRICE', snapshot),
      createMoney(2_500, 'PLN', 'ESTIMATE', snapshot),
      unknownMoney('PLN', snapshot),
      unknownMoney('PLN', null),
    ];

    expect(sumMoney(prices, 'PLN')).toEqual({
      currency: 'PLN',
      confirmedAmountMinor: 10_000,
      estimatedAmountMinor: 2_500,
      knownAmountMinor: 12_500,
      unknownCount: 2,
      totalAmountMinor: null,
    });
  });

  it('zwraca kontrolowane zera dla pustego zestawu w jawnej walucie', () => {
    expect(sumMoney([], 'EUR')).toEqual({
      currency: 'EUR',
      confirmedAmountMinor: 0,
      estimatedAmountMinor: 0,
      knownAmountMinor: 0,
      unknownCount: 0,
      totalAmountMinor: 0,
    });
  });

  it('odrzuca różne waluty zamiast wykonywać niejawne FX', () => {
    const euro = createMoney(10_000, 'EUR', 'LIVE_PRICE', {
      ...snapshot,
      currency: 'EUR',
    });

    let thrown: unknown;
    try {
      assertMoneyCurrency(euro, 'PLN');
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(MoneyError);
    expect(thrown).toMatchObject({
      code: 'CURRENCY_MISMATCH',
      expectedCurrency: 'PLN',
      actualCurrency: 'EUR',
    });
    expect(() => sumMoney([euro], 'PLN')).toThrowError(
      expect.objectContaining({ code: 'CURRENCY_MISMATCH' }),
    );
  });

  it('wykrywa przepełnienie przed utratą precyzji', () => {
    expect(() => addMinorUnits(Number.MAX_SAFE_INTEGER, 1)).toThrowError(
      expect.objectContaining({ code: 'MINOR_UNIT_OVERFLOW' }),
    );

    const priceTypes: readonly KnownPriceType[] = ['LIVE_PRICE', 'FIXED_PRICE'];
    const overflowing = priceTypes.map((priceType, index) =>
      createMoney(index === 0 ? Number.MAX_SAFE_INTEGER : 1, 'PLN', priceType, snapshot),
    );
    expect(() => sumMoney(overflowing, 'PLN')).toThrowError(
      expect.objectContaining({ code: 'MINOR_UNIT_OVERFLOW' }),
    );
  });
});
