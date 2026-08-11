import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Destination, TransportOption } from '../../srv/domain/candidate.js';
import type {
  AccommodationProvider,
  AccommodationSearchRequest,
  PlacesProvider,
  PlacesSearchRequest,
  ProviderTripRequest,
  TransportProvider,
  TransportSearchRequest,
} from '../../srv/providers/contracts.js';
import {
  buildReferencePlaces,
  buildReferenceStayOptions,
  buildReferenceTransportOptions,
  REFERENCE_DESTINATIONS,
} from '../../srv/providers/fixtures/europe-reference-fixtures.js';
import { MOCK_FIXTURE_VERSION } from '../../srv/providers/fixtures/fixture-source.js';
import { REFERENCE_PLANNING_CONTEXT } from '../../srv/providers/fixtures/reference-scenario.js';
import { MockAccommodationProvider } from '../../srv/providers/mock-accommodation-provider.js';
import { MockPlacesProvider } from '../../srv/providers/mock-places-provider.js';
import { MockTransportProvider } from '../../srv/providers/mock-transport-provider.js';
import type { ProviderRequestErrorCode } from '../../srv/providers/provider-request-validation.js';

const tripWindow = {
  startDate: REFERENCE_PLANNING_CONTEXT.startDate,
  endDate: REFERENCE_PLANNING_CONTEXT.endDate,
  adults: REFERENCE_PLANNING_CONTEXT.adults,
  currency: REFERENCE_PLANNING_CONTEXT.currency,
} as const;

const transportRequest: TransportSearchRequest = {
  ...tripWindow,
  originCity: REFERENCE_PLANNING_CONTEXT.originCity,
  destinations: REFERENCE_DESTINATIONS,
};

function destination(code: string): Destination {
  const result = REFERENCE_DESTINATIONS.find((item) => item.code === code);
  if (result === undefined) {
    throw new Error(`Missing reference destination ${code}`);
  }
  return result;
}

function accommodationRequest(code: string): AccommodationSearchRequest {
  return { ...tripWindow, destination: destination(code) };
}

function placesRequest(code: string): PlacesSearchRequest {
  return { ...tripWindow, destination: destination(code) };
}

function transportById(options: readonly TransportOption[], id: string): TransportOption {
  const result = options.find((option) => option.id === id);
  if (result === undefined) {
    throw new Error(`Missing reference transport ${id}`);
  }
  return result;
}

function providerSearches(
  override: Partial<ProviderTripRequest>,
): readonly (() => Promise<readonly unknown[]>)[] {
  return [
    () => new MockTransportProvider().search({ ...transportRequest, ...override }),
    () => new MockAccommodationProvider().search({ ...accommodationRequest('PRG'), ...override }),
    () => new MockPlacesProvider().search({ ...placesRequest('PRG'), ...override }),
  ];
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('mock provider contracts', () => {
  it('implements explicit async provider interfaces', async () => {
    const transport: TransportProvider = new MockTransportProvider();
    const accommodation: AccommodationProvider = new MockAccommodationProvider();
    const places: PlacesProvider = new MockPlacesProvider();

    const transportResult = transport.search(transportRequest);
    const accommodationResult = accommodation.search(accommodationRequest('PRG'));
    const placesResult = places.search(placesRequest('PRG'));

    expect(transportResult).toBeInstanceOf(Promise);
    expect(accommodationResult).toBeInstanceOf(Promise);
    expect(placesResult).toBeInstanceOf(Promise);
    await expect(transportResult).resolves.toHaveLength(16);
    await expect(accommodationResult).resolves.toHaveLength(3);
    await expect(placesResult).resolves.toHaveLength(2);
  });

  it('never accesses fetch or the network', async () => {
    const fetch = vi.fn(() => {
      throw new Error('A fixture provider attempted network access.');
    });
    vi.stubGlobal('fetch', fetch);

    await Promise.all([
      new MockTransportProvider().search(transportRequest),
      new MockAccommodationProvider().search(accommodationRequest('VIE')),
      new MockPlacesProvider().search(placesRequest('BER')),
    ]);

    expect(fetch).not.toHaveBeenCalled();
  });

  it('returns a rejected Promise instead of throwing synchronously for an invalid request date', async () => {
    const result = new MockTransportProvider().search({
      ...transportRequest,
      startDate: 'not-an-iso-date',
    });

    expect(result).toBeInstanceOf(Promise);
    await expect(result).rejects.toMatchObject({ code: 'INVALID_START_DATE' });
  });

  it.each([
    [{ startDate: 'not-an-iso-date' }, 'INVALID_START_DATE'],
    [{ endDate: '2026-02-30' }, 'INVALID_END_DATE'],
    [{ endDate: tripWindow.startDate }, 'INVALID_DATE_RANGE'],
    [{ adults: 0 }, 'INVALID_ADULTS'],
    [{ adults: 1.5 }, 'INVALID_ADULTS'],
    [{ adults: Number.MAX_SAFE_INTEGER + 1 }, 'INVALID_ADULTS'],
    [{ currency: 'pln' }, 'INVALID_CURRENCY'],
    [{ currency: 'PL' }, 'INVALID_CURRENCY'],
  ] as const)(
    'rejects invalid common trip input %j in every async provider (%s)',
    async (override, code) => {
      for (const search of providerSearches(override)) {
        const result = search();
        expect(result).toBeInstanceOf(Promise);
        await expect(result).rejects.toMatchObject({ code });
      }
    },
  );

  it.each([
    [
      () => new MockTransportProvider().search({ ...transportRequest, originCity: '   ' }),
      'INVALID_ORIGIN_CITY',
    ],
    [
      () => new MockTransportProvider().search({ ...transportRequest, destinations: [] }),
      'DESTINATIONS_REQUIRED',
    ],
    [
      () =>
        new MockTransportProvider().search({
          ...transportRequest,
          destinations: [{ ...destination('PRG'), code: ' ' }],
        }),
      'INVALID_DESTINATION',
    ],
    [
      () =>
        new MockAccommodationProvider().search({
          ...accommodationRequest('PRG'),
          destination: { ...destination('PRG'), city: '' },
        }),
      'INVALID_DESTINATION',
    ],
    [
      () =>
        new MockPlacesProvider().search({
          ...placesRequest('PRG'),
          destination: { ...destination('PRG'), countryCode: ' ' },
        }),
      'INVALID_DESTINATION',
    ],
  ] as const)(
    'rejects an empty provider-specific search field with %s',
    async (search, code: ProviderRequestErrorCode) => {
      const result = search();
      expect(result).toBeInstanceOf(Promise);
      await expect(result).rejects.toMatchObject({ code });
    },
  );

  it('applies the same common validation when fixture builders are called directly', () => {
    expect(() => buildReferenceTransportOptions({ ...transportRequest, adults: 0 })).toThrowError(
      expect.objectContaining({ code: 'INVALID_ADULTS' }),
    );
    expect(() =>
      buildReferenceStayOptions({ ...accommodationRequest('PRG'), adults: 0 }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_ADULTS' }));
    expect(() => buildReferencePlaces({ ...placesRequest('PRG'), adults: 0 })).toThrowError(
      expect.objectContaining({ code: 'INVALID_ADULTS' }),
    );
  });

  it('keeps the transport search finite, filtered and independent of duplicate request codes', async () => {
    const provider = new MockTransportProvider();
    const options = await provider.search({
      ...transportRequest,
      destinations: [destination('VIE'), destination('PRG'), destination('VIE')],
    });

    expect(options).toHaveLength(8);
    expect(options.map((option) => option.destinationCode).sort()).toEqual([
      'PRG',
      'PRG',
      'PRG',
      'PRG',
      'VIE',
      'VIE',
      'VIE',
      'VIE',
    ]);
  });

  it('returns no Wrocław fixture routes for an unsupported origin', async () => {
    await expect(
      new MockTransportProvider().search({ ...transportRequest, originCity: 'Warszawa' }),
    ).resolves.toEqual([]);
  });
});

describe('request-relative and repeatable fixtures', () => {
  it('does not use the current system date in any mock provider', async () => {
    const providers = {
      transport: new MockTransportProvider(),
      accommodation: new MockAccommodationProvider(),
      places: new MockPlacesProvider(),
    };
    vi.useFakeTimers();
    vi.setSystemTime(new Date('1999-01-01T00:00:00.000Z'));
    const first = await Promise.all([
      providers.transport.search(transportRequest),
      providers.accommodation.search(accommodationRequest('PRG')),
      providers.places.search(placesRequest('PRG')),
    ]);
    vi.setSystemTime(new Date('2049-12-31T23:59:59.000Z'));
    const second = await Promise.all([
      providers.transport.search(transportRequest),
      providers.accommodation.search(accommodationRequest('PRG')),
      providers.places.search(placesRequest('PRG')),
    ]);

    expect(second).toStrictEqual(first);
  });

  it('derives transport instants and snapshot timestamps from request dates', async () => {
    const provider = new MockTransportProvider();
    const shiftedRequest: TransportSearchRequest = {
      ...transportRequest,
      startDate: '2027-01-30',
      endDate: '2027-02-02',
    };
    const option = transportById(
      await provider.search(shiftedRequest),
      'transport-prg-train-balanced',
    );

    expect(option.outbound.departureAt).toBe('2027-01-30T08:00:00.000Z');
    expect(option.return.arrivalAt).toBe('2027-02-02T20:30:00.000Z');
    expect(option.sourceSnapshot?.fetchedAt).toBe('2026-12-31T12:00:00.000Z');
  });

  it('derives accommodation dates, nights and total price from the request', async () => {
    const provider = new MockAccommodationProvider();
    const threeNights = await provider.search(accommodationRequest('PRG'));
    const fiveNights = await provider.search({
      ...accommodationRequest('PRG'),
      endDate: '2026-10-15',
    });

    expect(threeNights[0]).toMatchObject({
      checkInDate: '2026-10-10',
      checkOutDate: '2026-10-13',
      nights: 3,
      price: { amountMinor: 96_000 },
    });
    expect(fiveNights[0]).toMatchObject({
      checkInDate: '2026-10-10',
      checkOutDate: '2026-10-15',
      nights: 5,
      price: { amountMinor: 160_000 },
    });
  });

  it('derives passenger-dependent transport prices using integer minor units', async () => {
    const provider = new MockTransportProvider();
    const oneAdult = transportById(
      await provider.search({ ...transportRequest, adults: 1 }),
      'transport-prg-train-balanced',
    );
    const twoAdults = transportById(
      await provider.search(transportRequest),
      'transport-prg-train-balanced',
    );

    expect(oneAdult.price.amountMinor).toBe(32_000);
    expect(twoAdults.price.amountMinor).toBe(64_000);
    expect(twoAdults.additionalFees.amountMinor).toBe(4_000);
  });
});

describe('versioned source snapshots', () => {
  it('grounds every non-deliberately-missing transport fact and price', async () => {
    const options = await new MockTransportProvider().search(transportRequest);
    const missing = transportById(options, 'transport-drs-train-missing-source');
    const sourced = options.filter((option) => option !== missing);

    expect(missing.sourceSnapshot).toBeNull();
    expect(missing.price.sourceSnapshot).toBeNull();
    expect(missing.additionalFees.sourceSnapshot).toBeNull();
    for (const option of sourced) {
      expect(option.sourceSnapshot).toMatchObject({
        provider: 'MockTransportProvider',
        sourceUrl: 'INTERNAL_FIXTURE',
        freshnessType: 'FIXTURE',
        fixtureVersion: MOCK_FIXTURE_VERSION,
        fetchedAt: '2026-09-10T12:00:00.000Z',
      });
      expect(option.price.sourceSnapshot).toBe(option.sourceSnapshot);
      expect(option.additionalFees.sourceSnapshot).toBe(option.sourceSnapshot);
    }
  });

  it('grounds all accommodation and place facts with the fixture version', async () => {
    const stays = await new MockAccommodationProvider().search(accommodationRequest('VIE'));
    const places = await new MockPlacesProvider().search(placesRequest('VIE'));

    for (const stay of stays) {
      expect(stay.sourceSnapshot).toMatchObject({
        provider: 'MockAccommodationProvider',
        sourceUrl: 'INTERNAL_FIXTURE',
        currency: 'PLN',
        fixtureVersion: MOCK_FIXTURE_VERSION,
      });
      expect(stay.price.sourceSnapshot).toBe(stay.sourceSnapshot);
      expect(stay.additionalFees.sourceSnapshot).toBe(stay.sourceSnapshot);
    }
    for (const place of places) {
      expect(place.sourceSnapshot).toMatchObject({
        provider: 'MockPlacesProvider',
        sourceUrl: 'INTERNAL_FIXTURE',
        currency: 'PLN',
        fixtureVersion: MOCK_FIXTURE_VERSION,
      });
    }
  });

  it('includes currency in snapshot identity so equal fixture items cannot collide', async () => {
    const provider = new MockTransportProvider();
    const pln = transportById(
      await provider.search(transportRequest),
      'transport-prg-train-balanced',
    );
    const eur = transportById(
      await provider.search({ ...transportRequest, currency: 'EUR' }),
      'transport-prg-train-balanced',
    );

    expect(pln.sourceSnapshot?.id).toContain(':PLN:');
    expect(eur.sourceSnapshot?.id).toContain(':EUR:');
    expect(pln.sourceSnapshot?.id).not.toBe(eur.sourceSnapshot?.id);
  });

  it('identifies every provider quote by currency, start, end and traveller count', async () => {
    async function snapshotIds(quote: ProviderTripRequest): Promise<readonly string[]> {
      const transports = await new MockTransportProvider().search({
        ...transportRequest,
        ...quote,
      });
      const stays = await new MockAccommodationProvider().search({
        ...accommodationRequest('PRG'),
        ...quote,
      });
      const places = await new MockPlacesProvider().search({
        ...placesRequest('PRG'),
        ...quote,
      });
      const ids = [
        transportById(transports, 'transport-prg-train-balanced').sourceSnapshot?.id,
        stays[0]?.sourceSnapshot?.id,
        places[0]?.sourceSnapshot?.id,
      ];
      if (ids.some((id) => id === undefined)) {
        throw new Error('Every selected quote fixture must have a source snapshot.');
      }
      return ids as readonly string[];
    }

    const baseline = await snapshotIds(tripWindow);
    const variants: readonly ProviderTripRequest[] = [
      { ...tripWindow, currency: 'EUR' },
      { ...tripWindow, startDate: '2026-10-11' },
      { ...tripWindow, endDate: '2026-10-14' },
      { ...tripWindow, adults: 3 },
    ];

    expect(baseline.every((id) => id.endsWith(':PLN:2026-10-10:2026-10-13:2'))).toBe(true);
    for (const variant of variants) {
      const changed = await snapshotIds(variant);
      changed.forEach((id, providerIndex) => {
        expect(id).not.toBe(baseline[providerIndex]);
      });
    }
  });
});

describe('reference scenario coverage', () => {
  it('offers eight European destinations and at least eight bounded combinations', () => {
    const destinationCodes = new Set(REFERENCE_DESTINATIONS.map((item) => item.code));
    expect(REFERENCE_DESTINATIONS).toHaveLength(8);
    expect(destinationCodes.size).toBe(8);
    expect(Object.isFrozen(REFERENCE_DESTINATIONS)).toBe(true);
    expect(REFERENCE_DESTINATIONS.every((item) => Object.isFrozen(item))).toBe(true);

    const transports = buildReferenceTransportOptions(transportRequest);
    const potentialCombinations = REFERENCE_DESTINATIONS.reduce((total, item) => {
      const destinationTransports = transports.filter(
        (transport) => transport.destinationCode === item.code,
      ).length;
      const stays = buildReferenceStayOptions({ ...tripWindow, destination: item }).length;
      return total + destinationTransports * stays;
    }, 0);

    expect(potentialCombinations).toBe(28);
  });

  it('contains every deliberately adverse transport condition', async () => {
    const options = await new MockTransportProvider().search(transportRequest);

    expect(transportById(options, 'transport-prg-bus-too-early').outbound.departureAt).toContain(
      'T05:15:',
    );
    expect(transportById(options, 'transport-vie-bus-late-return').return.arrivalAt).toContain(
      'T23:45:',
    );
    expect(
      transportById(options, 'transport-vie-train-many-connections').outbound.connections,
    ).toBe(3);
    expect(transportById(options, 'transport-bud-flight-disallowed').mode).toBe('FLIGHT');
    expect(transportById(options, 'transport-szg-bus-too-long').outbound.durationMinutes).toBe(720);
    expect(transportById(options, 'transport-drs-train-missing-source').sourceSnapshot).toBeNull();
    expect(transportById(options, 'transport-bts-bus-unknown-price').price).toMatchObject({
      amountMinor: null,
      priceType: 'UNKNOWN',
    });
    expect(transportById(options, 'transport-krk-train-eur-mismatch').price.currency).toBe('EUR');
    expect(transportById(options, 'transport-vie-train-insufficient-time').return.departureAt).toBe(
      '2026-10-13T15:00:00.000Z',
    );
    expect(transportById(options, 'transport-prg-invalid-dates').outbound).toMatchObject({
      departureAt: '2026-10-10T15:00:00.000Z',
      arrivalAt: '2026-10-10T14:00:00.000Z',
    });
    expect(options.some((option) => option.id === '')).toBe(true);
  });

  it('contains a semantic duplicate independent of provider identifiers', async () => {
    const options = await new MockTransportProvider().search(transportRequest);
    const original = transportById(options, 'transport-prg-train-balanced');
    const duplicate = transportById(options, 'transport-prg-train-semantic-duplicate');

    expect({
      destinationCode: duplicate.destinationCode,
      mode: duplicate.mode,
      outbound: duplicate.outbound,
      return: duplicate.return,
      price: duplicate.price.amountMinor,
      fees: duplicate.additionalFees.amountMinor,
    }).toStrictEqual({
      destinationCode: original.destinationCode,
      mode: original.mode,
      outbound: original.outbound,
      return: original.return,
      price: original.price.amountMinor,
      fees: original.additionalFees.amountMinor,
    });
    expect(duplicate.id).not.toBe(original.id);
    expect(duplicate.sourceSnapshot?.externalItemId).not.toBe(
      original.sourceSnapshot?.externalItemId,
    );
  });

  it('contains an over-budget stay and several valid-priced alternatives', async () => {
    const stays = await new MockAccommodationProvider().search(accommodationRequest('PRG'));
    const expensive = stays.find((stay) => stay.id === 'stay-prg-palace-over-budget');

    expect(expensive?.price.amountMinor).toBe(510_000);
    expect(stays.filter((stay) => (stay.price.amountMinor ?? Infinity) < 150_000)).toHaveLength(2);
  });

  it('exposes deterministic food and nature preference facts for relaxed-trip scoring', async () => {
    const places = await new MockPlacesProvider().search(placesRequest('PRG'));

    expect(Math.max(...places.map((place) => place.preferenceScores.food))).toBeGreaterThanOrEqual(
      90,
    );
    expect(
      Math.max(...places.map((place) => place.preferenceScores.nature)),
    ).toBeGreaterThanOrEqual(90);
  });

  it('does not leak preference-score mutations between searches', async () => {
    const provider = new MockPlacesProvider();
    const first = await provider.search(placesRequest('PRG'));
    const originalFoodScore = first[0]?.preferenceScores.food;
    if (first[0] === undefined || originalFoodScore === undefined) {
      throw new Error('The PRG place fixture must not be empty.');
    }

    (first[0].preferenceScores as { food: number }).food = 0;
    const second = await provider.search(placesRequest('PRG'));

    expect(second[0]?.preferenceScores.food).toBe(originalFoodScore);
    expect(second[0]?.preferenceScores).not.toBe(first[0].preferenceScores);
  });
});
