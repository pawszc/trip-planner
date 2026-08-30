import { describe, expect, it, vi } from 'vitest';
import type { Destination } from '../../srv/domain/candidate.js';
import type { TransportSearchRequest } from '../../srv/providers/contracts.js';
import { DuffelApiTransportProvider } from '../../srv/providers/duffel/duffel-api-transport-provider.js';
import { mapDuffelOffer } from '../../srv/providers/duffel/duffel-mapper.js';
import {
  createDuffelPlanningProfile,
  createDuffelTransportManifestEntry,
} from '../../srv/providers/duffel/duffel-profile.js';
import {
  buildDuffelOfferRequestPlans,
  createDuffelOriginCatalog,
  createDuffelSearchPolicyIdentity,
  DEFAULT_DUFFEL_ORIGIN_CATALOG,
  DUFFEL_DESTINATION_IATA_CATALOG_VERSION,
  DUFFEL_ORIGIN_CATALOG_VERSION,
} from '../../srv/providers/duffel/duffel-search-policy.js';
import {
  DUFFEL_MAX_ADULTS_PER_SEARCH,
  DUFFEL_MAX_AMOUNT_CHARACTERS,
  DUFFEL_MAX_CONNECTIONS_PER_SLICE,
  DUFFEL_MAX_DESTINATIONS_PER_SEARCH,
  DUFFEL_MAX_SEGMENTS_PER_SLICE,
} from '../../srv/providers/duffel/duffel-contracts.js';
import { duffelOfferRequestResponseSchema } from '../../srv/providers/duffel/duffel-schemas.js';
import {
  DUFFEL_API_BASE_URL,
  DUFFEL_MAX_RESPONSE_BYTES,
  ProviderHttpClient,
  ProviderHttpClientError,
  type ProviderHttpTransport,
} from '../../srv/providers/http/provider-http-client.js';
import { ProviderExecutionScope } from '../../srv/providers/provider-execution.js';
import type { ProviderCallOptions } from '../../srv/providers/provider-execution.js';
import { ProviderExecutionError } from '../../srv/providers/provider-errors.js';
import { createProviderFingerprint } from '../../srv/providers/provider-fingerprint.js';
import {
  duffelFixture,
  duffelFixtureWithAvailableServices,
  validDuffelOfferRequestResponse,
} from '../fixtures/duffel-offer-response.js';

const destination: Destination = { code: 'PRG', city: 'Prague', countryCode: 'CZ' };
const request: TransportSearchRequest = {
  originCity: 'Wrocław',
  destinations: [destination],
  startDate: '2026-10-10',
  endDate: '2026-10-13',
  adults: 2,
  currency: 'PLN',
};
const clock = () => new Date('2026-10-01T12:00:00.000Z');

function client(transport: ProviderHttpTransport, token = vi.fn(() => 'secret-test-token')) {
  return {
    httpClient: new ProviderHttpClient({
      baseUrl: DUFFEL_API_BASE_URL,
      token,
      transport,
      now: clock,
    }),
    token,
  };
}

function provider(transport: ProviderHttpTransport) {
  return new DuffelApiTransportProvider({
    environment: 'TEST',
    httpClient: client(transport).httpClient,
    manifestEntry: createDuffelTransportManifestEntry('TEST'),
    originCatalog: DEFAULT_DUFFEL_ORIGIN_CATALOG,
    clock,
  });
}

function executionOptions(scope: ProviderExecutionScope): ProviderCallOptions {
  return {
    signal: scope.signal,
    executeUpstream: (descriptor, invoke) =>
      scope.execute(
        {
          providerKey: 'duffel-flights',
          operation: 'TRANSPORT_SEARCH',
          destinationCode: descriptor.destinationCode ?? null,
          queryFingerprint: descriptor.queryFingerprint,
          resultFingerprint: descriptor.resultFingerprint,
          resultCount: descriptor.resultCount,
        },
        invoke,
      ),
  };
}

describe('Duffel Search Policy v1', () => {
  it('builds one adults-only economy return request per stable destination', () => {
    const plans = buildDuffelOfferRequestPlans(
      {
        ...request,
        destinations: [{ code: 'VIE', city: 'Vienna', countryCode: 'AT' }, destination],
      },
      DEFAULT_DUFFEL_ORIGIN_CATALOG,
    );
    expect(DUFFEL_ORIGIN_CATALOG_VERSION).toBe('duffel-origin-iata-catalog-v1');
    expect(DUFFEL_DESTINATION_IATA_CATALOG_VERSION).toBe('duffel-destination-iata-catalog-v1');
    expect(DUFFEL_MAX_ADULTS_PER_SEARCH).toBe(9);
    expect(DUFFEL_MAX_DESTINATIONS_PER_SEARCH).toBe(8);
    expect(DUFFEL_MAX_CONNECTIONS_PER_SLICE).toBe(1);
    expect(DUFFEL_MAX_SEGMENTS_PER_SLICE).toBe(2);
    expect(plans.map((plan) => plan.destination.code)).toEqual(['PRG', 'VIE']);
    expect(plans[0]).toMatchObject({
      path: '/air/offer_requests?return_offers=true&supplier_timeout=8000&view=offers',
      body: {
        data: {
          cabin_class: 'economy',
          include_split_ticket: false,
          max_connections: 1,
          passengers: [{ type: 'adult' }, { type: 'adult' }],
          slices: [
            { origin: 'WRO', destination: 'PRG', departure_date: '2026-10-10' },
            { origin: 'PRG', destination: 'WRO', departure_date: '2026-10-13' },
          ],
        },
      },
    });
  });

  it.each(['Kraków', '', 'Wroclaw'])(
    'rejects unsupported origin %s before token/network',
    async (originCity) => {
      const transport = vi.fn<ProviderHttpTransport>();
      const token = vi.fn(() => 'secret-test-token');
      const adapter = new DuffelApiTransportProvider({
        environment: 'TEST',
        httpClient: client(transport, token).httpClient,
        manifestEntry: createDuffelTransportManifestEntry('TEST'),
        originCatalog: DEFAULT_DUFFEL_ORIGIN_CATALOG,
        clock,
      });
      const scope = new ProviderExecutionScope();
      await expect(
        adapter.search({ ...request, originCity }, executionOptions(scope)),
      ).rejects.toThrow();
      expect(token).not.toHaveBeenCalled();
      expect(transport).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      'a destination outside the versioned IATA catalog',
      [{ code: 'ZZZ', city: 'Unknown', countryCode: 'ZZ' }],
    ],
    [
      'destination fan-out above the policy maximum',
      Array.from({ length: DUFFEL_MAX_DESTINATIONS_PER_SEARCH + 1 }, () => destination),
    ],
  ] as const)('rejects %s before token/network', async (_label, destinations) => {
    const transport = vi.fn<ProviderHttpTransport>();
    const token = vi.fn(() => 'secret-test-token');
    const adapter = new DuffelApiTransportProvider({
      environment: 'TEST',
      httpClient: client(transport, token).httpClient,
      manifestEntry: createDuffelTransportManifestEntry('TEST'),
      originCatalog: DEFAULT_DUFFEL_ORIGIN_CATALOG,
      clock,
    });
    const scope = new ProviderExecutionScope();

    await expect(
      adapter.search({ ...request, destinations }, executionOptions(scope)),
    ).rejects.toThrow('Duffel search request is outside Search Policy v1.');
    expect(token).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
    expect(scope.getAuditEvents()).toEqual([]);
  });

  it.each([
    [
      'a nonexistent start date',
      { ...request, startDate: '2026-02-30' } as TransportSearchRequest,
      'INVALID_START_DATE',
    ],
    [
      'a reversed date range',
      { ...request, endDate: '2026-10-09' } as TransportSearchRequest,
      'INVALID_DATE_RANGE',
    ],
    [
      'an unsupported currency',
      { ...request, currency: 'USD' } as unknown as TransportSearchRequest,
      'INVALID_CURRENCY',
    ],
    [
      'an empty destination list',
      { ...request, destinations: [] } as TransportSearchRequest,
      'DESTINATIONS_REQUIRED',
    ],
  ] as const)(
    'rejects common invalid input (%s) before token/network',
    async (_label, invalid, code) => {
      const transport = vi.fn<ProviderHttpTransport>();
      const token = vi.fn(() => 'secret-test-token');
      const scope = new ProviderExecutionScope();
      const error = await new DuffelApiTransportProvider({
        environment: 'TEST',
        httpClient: client(transport, token).httpClient,
        manifestEntry: createDuffelTransportManifestEntry('TEST'),
        originCatalog: DEFAULT_DUFFEL_ORIGIN_CATALOG,
        clock,
      })
        .search(invalid, executionOptions(scope))
        .catch((caught: unknown) => caught);

      expect(error).toMatchObject({ code });
      expect(token).not.toHaveBeenCalled();
      expect(transport).not.toHaveBeenCalled();
      expect(scope.getAuditEvents()).toEqual([]);
    },
  );

  it('rejects passenger allocation above the local policy bound before token/network', async () => {
    const transport = vi.fn<ProviderHttpTransport>();
    const token = vi.fn(() => 'secret-test-token');
    const scope = new ProviderExecutionScope();
    const adapter = new DuffelApiTransportProvider({
      environment: 'TEST',
      httpClient: client(transport, token).httpClient,
      manifestEntry: createDuffelTransportManifestEntry('TEST'),
      originCatalog: DEFAULT_DUFFEL_ORIGIN_CATALOG,
      clock,
    });

    await expect(
      adapter.search(
        { ...request, adults: DUFFEL_MAX_ADULTS_PER_SEARCH + 1 },
        executionOptions(scope),
      ),
    ).rejects.toThrow('Duffel search request is outside Search Policy v1.');
    expect(token).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
    expect(scope.getAuditEvents()).toEqual([]);
  });

  it('injects a versioned origin catalog and binds it to manifest and request identity', async () => {
    const originCatalog = createDuffelOriginCatalog({
      version: 'duffel-origin-iata-catalog-test-v1',
      cityToIata: { Poznań: 'POZ' },
    });
    const response = duffelFixture();
    response.data.offers = [];
    const transport = vi.fn<ProviderHttpTransport>(
      async () => new Response(JSON.stringify(response), { status: 200 }),
    );
    const profile = createDuffelPlanningProfile({
      environment: 'TEST',
      httpClient: client(transport).httpClient,
      originCatalog,
      clock,
    });
    const scope = new ProviderExecutionScope();

    await expect(
      profile.providers.transport.search(
        { ...request, originCity: 'Poznań' },
        executionOptions(scope),
      ),
    ).resolves.toEqual([]);

    const transportManifest = profile.manifest.entries.find((entry) => entry.role === 'TRANSPORT');
    expect(transportManifest?.searchPolicyVersion).toBe(
      createDuffelSearchPolicyIdentity(originCatalog),
    );
    expect(transportManifest?.searchPolicyVersion).not.toBe(
      createDuffelSearchPolicyIdentity(DEFAULT_DUFFEL_ORIGIN_CATALOG),
    );
    const [, init] = transport.mock.calls[0]!;
    expect(JSON.parse(String(init.body))).toMatchObject({
      data: {
        slices: [
          { origin: 'POZ', destination: 'PRG' },
          { origin: 'PRG', destination: 'POZ' },
        ],
      },
    });
    expect(scope.getAuditEvents()).toHaveLength(1);
    expect(scope.getAuditEvents()[0]?.queryFingerprint).toBe(
      buildDuffelOfferRequestPlans({ ...request, originCity: 'Poznań' }, originCatalog)[0]
        ?.queryFingerprint,
    );
  });
});

describe('Duffel schemas and mapper', () => {
  it('validates used fields and strips every non-allowlisted provider field', () => {
    const parsed = duffelOfferRequestResponseSchema.parse(duffelFixtureWithAvailableServices());
    expect(parsed).not.toHaveProperty('meta_debug_value');
    expect(parsed.data).not.toHaveProperty('ignored_provider_field');
    expect(parsed.data.offers[0]).not.toHaveProperty('ignored_offer_field');
    expect(parsed.data.offers[0]?.available_services?.[0]).not.toHaveProperty(
      'ignored_service_field',
    );
  });

  it('accepts a non-IATA operating carrier with a null IATA code', () => {
    const fixture = duffelFixture();
    const carrier = fixture.data.offers[0]!.slices[0]!.segments[0]!
      .operating_carrier as unknown as { iata_code: string | null };
    carrier.iata_code = null;

    const parsed = duffelOfferRequestResponseSchema.parse(fixture);
    expect(parsed.data.offers[0]!.slices[0]!.segments[0]!.operating_carrier.iata_code).toBeNull();
    expect(() =>
      mapDuffelOffer(parsed.data.offers[0]!, {
        destinationCode: 'PRG',
        originCode: 'WRO',
        currency: 'PLN',
        environment: 'TEST',
        queryFingerprint: createProviderFingerprint({ query: 'null-carrier-iata' }),
        fetchedAt: clock().toISOString(),
      }),
    ).not.toThrow();
  });

  it.each([
    [
      'missing expiry',
      (fixture: ReturnType<typeof duffelFixture>) =>
        delete (fixture.data.offers[0] as { expires_at?: string }).expires_at,
    ],
    [
      'one slice',
      (fixture: ReturnType<typeof duffelFixture>) => fixture.data.offers[0]!.slices.pop(),
    ],
    [
      'malformed amount',
      (fixture: ReturnType<typeof duffelFixture>) => {
        fixture.data.offers[0]!.total_amount = '12.345';
      },
    ],
    [
      'unbounded amount',
      (fixture: ReturnType<typeof duffelFixture>) => {
        fixture.data.offers[0]!.total_amount = '1'.repeat(DUFFEL_MAX_AMOUNT_CHARACTERS + 1);
      },
    ],
  ] as const)('rejects malformed fixture: %s', (_label, mutate) => {
    const fixture = duffelFixture();
    mutate(fixture);
    expect(duffelOfferRequestResponseSchema.safeParse(fixture).success).toBe(false);
  });

  it('rejects an offer exceeding Search Policy max_connections before mapping', () => {
    const fixture = duffelFixture();
    const segments = fixture.data.offers[0]!.slices[0]!.segments;
    segments.push(structuredClone(segments[0]!), structuredClone(segments[0]!));

    expect(segments).toHaveLength(DUFFEL_MAX_SEGMENTS_PER_SLICE + 1);
    expect(duffelOfferRequestResponseSchema.safeParse(fixture).success).toBe(false);
  });

  it('maps exact money, two slices, carrier attribution, services and SourceSnapshot v2', () => {
    const parsed = duffelOfferRequestResponseSchema.parse(duffelFixtureWithAvailableServices());
    const option = mapDuffelOffer(parsed.data.offers[0]!, {
      destinationCode: 'PRG',
      originCode: 'WRO',
      currency: 'PLN',
      environment: 'TEST',
      queryFingerprint: createProviderFingerprint({ query: 'test' }),
      fetchedAt: clock().toISOString(),
    });
    expect(option).toMatchObject({
      id: 'duffel:off_000000validoffer',
      destinationCode: 'PRG',
      mode: 'FLIGHT',
      outbound: {
        departureAt: '2026-10-10T08:00:00.000+02:00',
        arrivalAt: '2026-10-10T09:00:00.000+02:00',
        durationMinutes: 60,
        connections: 0,
      },
      return: {
        departureAt: '2026-10-13T18:00:00.000+02:00',
        arrivalAt: '2026-10-13T19:00:00.000+02:00',
        durationMinutes: 60,
        connections: 0,
      },
      price: { amountMinor: 10_000, currency: 'PLN' },
      additionalFees: { amountMinor: 2_000, currency: 'PLN' },
      pricing: {
        mandatoryTotal: { amountMinor: 12_000, currency: 'PLN' },
        conditionalCharges: { completeness: 'UNKNOWN', items: [] },
        optionalAncillaries: {
          completeness: 'COMPLETE',
          items: [
            expect.objectContaining({
              code: 'CHECKED_BAGGAGE',
              amount: expect.objectContaining({ amountMinor: 2_500 }),
            }),
          ],
        },
      },
      sourceSnapshot: {
        contractVersion: 'source-snapshot-v2',
        sourceType: 'LIVE',
        provider: 'Duffel',
        providerVersion: 'duffel-test-offers-v2',
        externalItemId: 'off_000000validoffer',
        expiresAt: '2026-10-01T13:00:00.000Z',
        fixtureVersion: null,
        attribution: 'Duffel; operated by LOT Polish Airlines',
      },
    });
  });

  it('maps EUR with exact decimal-string minor units and no FX', () => {
    const fixture = duffelFixtureWithAvailableServices();
    const offer = fixture.data.offers[0]!;
    offer.base_currency = 'EUR';
    offer.tax_currency = 'EUR';
    offer.total_currency = 'EUR';
    offer.available_services[0]!.total_currency = 'EUR';
    const parsed = duffelOfferRequestResponseSchema.parse(fixture);
    const option = mapDuffelOffer(parsed.data.offers[0]!, {
      destinationCode: 'PRG',
      originCode: 'WRO',
      currency: 'EUR',
      environment: 'TEST',
      queryFingerprint: createProviderFingerprint({ query: 'eur-test' }),
      fetchedAt: clock().toISOString(),
    });
    expect(option.price).toMatchObject({ amountMinor: 10_000, currency: 'EUR' });
    expect(option.additionalFees).toMatchObject({ amountMinor: 2_000, currency: 'EUR' });
    expect(option.pricing.mandatoryTotal).toMatchObject({
      amountMinor: 12_000,
      currency: 'EUR',
    });
  });

  it('keeps Offer Request ancillary completeness unknown when services are absent', () => {
    const parsed = duffelOfferRequestResponseSchema.parse(validDuffelOfferRequestResponse);
    const option = mapDuffelOffer(parsed.data.offers[0]!, {
      destinationCode: 'PRG',
      originCode: 'WRO',
      currency: 'PLN',
      environment: 'TEST',
      queryFingerprint: createProviderFingerprint({ query: 'offer-request-ancillaries' }),
      fetchedAt: clock().toISOString(),
    });

    expect(option.pricing.optionalAncillaries).toEqual({
      completeness: 'UNKNOWN',
      items: [],
    });
  });

  it.each([
    [
      'currency mismatch',
      (fixture: ReturnType<typeof duffelFixture>) => {
        fixture.data.offers[0]!.tax_currency = 'EUR';
      },
    ],
    [
      'arithmetic mismatch',
      (fixture: ReturnType<typeof duffelFixture>) => {
        fixture.data.offers[0]!.total_amount = '121.00';
      },
    ],
    [
      'missing tax',
      (fixture: ReturnType<typeof duffelFixture>) => {
        const offer = fixture.data.offers[0]! as unknown as {
          tax_amount: string | null;
          tax_currency: string | null;
        };
        offer.tax_amount = null;
        offer.tax_currency = null;
      },
    ],
    [
      'airport discontinuity',
      (fixture: ReturnType<typeof duffelFixture>) => {
        fixture.data.offers[0]!.slices[0]!.segments[0]!.destination.iata_code = 'BER';
      },
    ],
    [
      'segment duration mismatch',
      (fixture: ReturnType<typeof duffelFixture>) => {
        const segment = fixture.data.offers[0]!.slices[0]!.segments[0]! as unknown as {
          duration: string;
        };
        segment.duration = 'PT2H';
      },
    ],
  ] as const)('fails closed for %s', (_label, mutate) => {
    const fixture = duffelFixture();
    mutate(fixture);
    const parsed = duffelOfferRequestResponseSchema.parse(fixture);
    expect(() =>
      mapDuffelOffer(parsed.data.offers[0]!, {
        destinationCode: 'PRG',
        originCode: 'WRO',
        currency: 'PLN',
        environment: 'TEST',
        queryFingerprint: createProviderFingerprint({ query: 'test' }),
        fetchedAt: clock().toISOString(),
      }),
    ).toThrow();
  });

  it('rejects a multi-segment slice whose connection departs before the prior arrival', () => {
    const fixture = duffelFixture();
    const slice = fixture.data.offers[0]!.slices[0]! as unknown as {
      duration: string;
      segments: Array<{
        id: string;
        departing_at: string;
        arriving_at: string;
        duration: string;
        origin: { iata_code: string; time_zone: string };
        destination: { iata_code: string; time_zone: string };
        operating_carrier: { id: string; name: string; iata_code: string | null };
        operating_carrier_flight_number: string;
      }>;
    };
    const first = slice.segments[0]!;
    first.arriving_at = '2026-10-10T12:00:00';
    first.duration = 'PT4H';
    first.destination = { iata_code: 'BER', time_zone: 'Europe/Berlin' };
    slice.segments.push({
      ...structuredClone(first),
      id: 'seg_000000connection',
      departing_at: '2026-10-10T09:00:00',
      arriving_at: '2026-10-10T10:00:00',
      duration: 'PT1H',
      origin: { iata_code: 'BER', time_zone: 'Europe/Berlin' },
      destination: { iata_code: 'PRG', time_zone: 'Europe/Prague' },
      operating_carrier_flight_number: 'LO103',
    });
    slice.duration = 'PT2H';

    const parsed = duffelOfferRequestResponseSchema.parse(fixture);
    expect(() =>
      mapDuffelOffer(parsed.data.offers[0]!, {
        destinationCode: 'PRG',
        originCode: 'WRO',
        currency: 'PLN',
        environment: 'TEST',
        queryFingerprint: createProviderFingerprint({ query: 'reversed-connection' }),
        fetchedAt: clock().toISOString(),
      }),
    ).toThrow('Duffel slice contains overlapping or reversed segments.');
  });
});

describe('Duffel HTTP/provider boundary', () => {
  it('rejects an environment-mismatched manifest before an empty-result request', () => {
    const transport = vi.fn<ProviderHttpTransport>(async () => {
      const empty = duffelFixture();
      empty.data.offers = [];
      return new Response(JSON.stringify(empty), { status: 200 });
    });
    const { httpClient, token } = client(transport);

    expect(
      () =>
        new DuffelApiTransportProvider({
          environment: 'TEST',
          httpClient,
          manifestEntry: createDuffelTransportManifestEntry('LIVE'),
          originCatalog: DEFAULT_DUFFEL_ORIGIN_CATALOG,
          clock,
        }),
    ).toThrow('Duffel adapter manifest identity does not match its environment.');
    expect(token).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });

  it('rejects a manifest built for another origin catalog before token/network', () => {
    const originCatalog = createDuffelOriginCatalog({
      version: 'duffel-origin-iata-catalog-test-v1',
      cityToIata: { Poznań: 'POZ' },
    });
    const transport = vi.fn<ProviderHttpTransport>();
    const { httpClient, token } = client(transport);

    expect(
      () =>
        new DuffelApiTransportProvider({
          environment: 'TEST',
          httpClient,
          manifestEntry: createDuffelTransportManifestEntry('TEST'),
          originCatalog,
          clock,
        }),
    ).toThrow('Duffel adapter manifest identity does not match its environment.');
    expect(token).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });

  it('sends the exact v2 JSON/gzip headers without exposing the token in output', async () => {
    const transport = vi.fn<ProviderHttpTransport>(
      async () => new Response(JSON.stringify(validDuffelOfferRequestResponse), { status: 200 }),
    );
    const { httpClient, token } = client(transport);
    const scope = new ProviderExecutionScope();
    const results = await new DuffelApiTransportProvider({
      environment: 'TEST',
      httpClient,
      manifestEntry: createDuffelTransportManifestEntry('TEST'),
      originCatalog: DEFAULT_DUFFEL_ORIGIN_CATALOG,
      clock,
    }).search(request, executionOptions(scope));
    expect(results).toHaveLength(1);
    expect(token).toHaveBeenCalledTimes(1);
    const [url, init] = transport.mock.calls[0]!;
    expect(url).toBe(
      'https://api.duffel.com/air/offer_requests?return_offers=true&supplier_timeout=8000&view=offers',
    );
    expect(init).toMatchObject({
      method: 'POST',
      redirect: 'error',
      headers: expect.objectContaining({
        Accept: 'application/json',
        'Accept-Encoding': 'gzip',
        'Content-Type': 'application/json',
        'Duffel-Version': 'v2',
      }),
    });
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer secret-test-token');
    expect(JSON.stringify(scope.getAuditEvents())).not.toContain('secret-test-token');
  });

  it('cancels a failed response body without exposing cancellation errors', async () => {
    const cancel = vi.fn(async () => {
      throw new Error('raw cancellation secret-test-token');
    });
    const body = new ReadableStream<Uint8Array>({ cancel });
    const scope = new ProviderExecutionScope();
    const error = await provider(async () => new Response(body, { status: 503 }))
      .search(request, executionOptions(scope))
      .catch((caught: unknown) => caught);

    await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
    expect(error).toBeInstanceOf(ProviderExecutionError);
    expect(error).toMatchObject({
      category: 'PARTIAL_DESTINATION',
      evidence: {
        underlyingCategory: 'UPSTREAM_5XX',
        httpStatus: 503,
        destinationCode: 'PRG',
      },
    });
    expect(JSON.stringify((error as ProviderExecutionError).toSafeJSON())).not.toContain(
      'raw cancellation',
    );
    expect(JSON.stringify((error as ProviderExecutionError).toSafeJSON())).not.toContain(
      'secret-test-token',
    );
  });

  it('cancels an oversized successful response body before returning a safe error', async () => {
    const cancel = vi.fn(async () => {
      throw new Error('raw oversized cancellation secret-test-token');
    });
    const body = new ReadableStream<Uint8Array>({ cancel });
    const scope = new ProviderExecutionScope();
    const error = await provider(
      async () =>
        new Response(body, {
          status: 200,
          headers: { 'content-length': String(DUFFEL_MAX_RESPONSE_BYTES + 1) },
        }),
    )
      .search(request, executionOptions(scope))
      .catch((caught: unknown) => caught);

    await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
    expect(error).toBeInstanceOf(ProviderExecutionError);
    expect(error).toMatchObject({
      category: 'PARTIAL_DESTINATION',
      evidence: {
        underlyingCategory: 'INVALID_SCHEMA',
        schemaFailureStage: 'RESPONSE_JSON',
        destinationCode: 'PRG',
      },
    });
    expect(JSON.stringify((error as ProviderExecutionError).toSafeJSON())).not.toContain(
      'raw oversized cancellation',
    );
    expect(JSON.stringify((error as ProviderExecutionError).toSafeJSON())).not.toContain(
      'secret-test-token',
    );
  });

  it('normalizes a token resolver failure before it crosses the HTTP boundary', async () => {
    const transport = vi.fn<ProviderHttpTransport>();
    const token = vi.fn(async () => {
      throw new Error('raw credential resolver secret-test-token');
    });
    const httpClient = new ProviderHttpClient({
      baseUrl: DUFFEL_API_BASE_URL,
      token,
      transport,
      now: clock,
    });
    const error = await httpClient
      .postJson(
        '/air/offer_requests?return_offers=true&supplier_timeout=8000&view=offers',
        {},
        new AbortController().signal,
      )
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProviderHttpClientError);
    expect(error).toMatchObject({ kind: 'NETWORK' });
    expect(String(error)).not.toContain('raw credential resolver');
    expect(String(error)).not.toContain('secret-test-token');
    expect(token).toHaveBeenCalledTimes(1);
    expect(transport).not.toHaveBeenCalled();
  });

  it('drops an offer expired exactly at the injected mapper checkpoint', async () => {
    const expired = duffelFixture();
    expired.data.offers[0]!.expires_at = '2026-10-01T12:00:00.000Z';
    const scope = new ProviderExecutionScope();
    await expect(
      provider(async () => new Response(JSON.stringify(expired), { status: 200 })).search(
        request,
        executionOptions(scope),
      ),
    ).resolves.toEqual([]);
  });

  it('keeps schema-valid siblings when one upstream offer is malformed', async () => {
    const fixture = duffelFixture();
    (fixture.data.offers as unknown[]).push({ malformed: 'offer' });
    const scope = new ProviderExecutionScope();

    const results = await provider(
      async () => new Response(JSON.stringify(fixture), { status: 200 }),
    ).search(request, executionOptions(scope));

    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe('duffel:off_000000validoffer');
    expect(scope.getAuditEvents()).toHaveLength(1);
    expect(scope.getAuditEvents()[0]?.status).toBe('SUCCEEDED');
  });

  it('keeps a valid sibling when carrier text contains a downstream-unsafe control character', async () => {
    const fixture = duffelFixture();
    const unsafeCarrier = structuredClone(fixture.data.offers[0]!);
    unsafeCarrier.id = 'off_000000unsafecontrol';
    unsafeCarrier.slices[0]!.segments[0]!.operating_carrier.name = 'Unsafe\u0085Carrier';
    fixture.data.offers.push(unsafeCarrier);
    const scope = new ProviderExecutionScope();

    const results = await provider(
      async () => new Response(JSON.stringify(fixture), { status: 200 }),
    ).search(request, executionOptions(scope));

    expect(results.map((offer) => offer.id)).toEqual(['duffel:off_000000validoffer']);
    expect(scope.getAuditEvents()[0]).toMatchObject({ status: 'SUCCEEDED', resultCount: 1 });
  });

  it('rejects duplicate ancillary IDs inside one offer while keeping a valid sibling', async () => {
    const fixture = duffelFixtureWithAvailableServices();
    const malformed = fixture.data.offers[0]!;
    malformed.available_services.push(structuredClone(malformed.available_services[0]!));
    const validSibling = structuredClone(fixture.data.offers[0]!);
    validSibling.id = 'off_000000validsibling';
    validSibling.available_services = [validSibling.available_services[0]!];
    fixture.data.offers.push(validSibling);
    const scope = new ProviderExecutionScope();

    const results = await provider(
      async () => new Response(JSON.stringify(fixture), { status: 200 }),
    ).search(request, executionOptions(scope));

    expect(results.map((offer) => offer.id)).toEqual(['duffel:off_000000validsibling']);
    expect(scope.getAuditEvents()).toEqual([
      expect.objectContaining({ status: 'SUCCEEDED', resultCount: 1 }),
    ]);
  });

  it('canonicalizes ancillary order before mapping and fingerprinting', async () => {
    const fixture = duffelFixtureWithAvailableServices();
    const services = fixture.data.offers[0]!.available_services as unknown as Array<{
      id: string;
      type: 'baggage' | 'seat';
      total_amount: string;
      total_currency: string;
      ignored_service_field: string;
    }>;
    services.push({
      id: 'ase_000000seatservice',
      type: 'seat',
      total_amount: '10.00',
      total_currency: 'PLN',
      ignored_service_field: 'must be stripped',
    });
    const run = async (reverseServices: boolean) => {
      const response = structuredClone(fixture);
      if (reverseServices) response.data.offers[0]!.available_services.reverse();
      const scope = new ProviderExecutionScope();
      const results = await provider(
        async () => new Response(JSON.stringify(response), { status: 200 }),
      ).search(request, executionOptions(scope));
      return { results, resultFingerprint: scope.getAuditEvents()[0]?.resultFingerprint };
    };

    const forward = await run(false);
    const reverse = await run(true);
    expect(reverse).toEqual(forward);
    expect(forward.results[0]?.pricing.optionalAncillaries.items.map((item) => item.id)).toEqual([
      'ase_000000baggage',
      'ase_000000seatservice',
    ]);
  });

  it.each([
    [
      '429',
      async () =>
        new Response('provider text secret-test-token', {
          status: 429,
          headers: { 'retry-after': '2' },
        }),
      'RATE_LIMITED',
      429,
      null,
    ],
    [
      '5xx',
      async () => new Response('provider text secret-test-token', { status: 503 }),
      'UPSTREAM_5XX',
      503,
      null,
    ],
    [
      'oversized JSON',
      async () =>
        new Response('{}', {
          status: 200,
          headers: { 'content-length': String(DUFFEL_MAX_RESPONSE_BYTES + 1) },
        }),
      'INVALID_SCHEMA',
      null,
      'RESPONSE_JSON',
    ],
    [
      'invalid JSON',
      async () => new Response('{not-json', { status: 200 }),
      'INVALID_SCHEMA',
      null,
      'RESPONSE_JSON',
    ],
    [
      'invalid schema',
      async () =>
        new Response(
          JSON.stringify({ data: { id: 'orq_000000invalid', live_mode: false, offers: [{}] } }),
          { status: 200 },
        ),
      'INVALID_SCHEMA',
      null,
      'RESULT_ITEM_SCHEMA',
    ],
    [
      'network',
      async () => {
        throw new Error('raw network secret-test-token');
      },
      'NETWORK',
      null,
      null,
    ],
  ] as const)(
    'normalizes %s without raw provider data',
    async (_label, transport, underlying, status, schemaFailureStage) => {
      const scope = new ProviderExecutionScope();
      const error = await provider(transport)
        .search(request, executionOptions(scope))
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ProviderExecutionError);
      expect(error).toMatchObject({
        category: 'PARTIAL_DESTINATION',
        evidence: {
          underlyingCategory: underlying,
          httpStatus: status,
          schemaFailureStage,
          destinationCode: 'PRG',
        },
      });
      expect(JSON.stringify((error as ProviderExecutionError).toSafeJSON())).not.toContain(
        'secret-test-token',
      );
    },
  );

  it('accepts documented nullable time zones at the schema boundary and drops the offer', async () => {
    const fixture = duffelFixture();
    const origin = fixture.data.offers[0]!.slices[0]!.segments[0]!.origin as {
      time_zone: string | null;
    };
    origin.time_zone = null;

    expect(duffelOfferRequestResponseSchema.safeParse(fixture).success).toBe(true);
    const scope = new ProviderExecutionScope();
    const results = await provider(
      async () => new Response(JSON.stringify(fixture), { status: 200 }),
    ).search(request, executionOptions(scope));

    expect(results).toEqual([]);
    expect(scope.getAuditEvents()).toEqual([
      expect.objectContaining({ status: 'SUCCEEDED', resultCount: 0, failureCategory: null }),
    ]);
  });

  it('routes every destination request through executeUpstream and keeps empty identity', async () => {
    const empty = duffelFixture();
    empty.data.offers = [];
    const transport = vi.fn<ProviderHttpTransport>(
      async () => new Response(JSON.stringify(empty), { status: 200 }),
    );
    const adapter = provider(transport);
    const scope = new ProviderExecutionScope({ policy: { maxCallsPerRun: 2 } });
    const results = await adapter.search(
      {
        ...request,
        destinations: [destination, { code: 'VIE', city: 'Vienna', countryCode: 'AT' }],
      },
      executionOptions(scope),
    );
    expect(results).toEqual([]);
    expect(transport).toHaveBeenCalledTimes(2);
    expect(scope.getAuditEvents()).toHaveLength(2);
    expect(adapter.manifestEntry).toEqual(createDuffelTransportManifestEntry('TEST'));
  });

  it('deduplicates repeated destinations before executeUpstream fan-out', async () => {
    const transport = vi.fn<ProviderHttpTransport>(
      async () =>
        new Response(JSON.stringify(validDuffelOfferRequestResponse), {
          status: 200,
        }),
    );
    const scope = new ProviderExecutionScope();

    const results = await provider(transport).search(
      {
        ...request,
        destinations: [destination, { code: 'PRG', city: 'Prague duplicate', countryCode: 'CZ' }],
      },
      executionOptions(scope),
    );

    expect(results).toHaveLength(1);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(scope.getAuditEvents()).toHaveLength(1);
  });

  it('accepts more than 200 offers before local truncation', async () => {
    const fixture = duffelFixture();
    const template = fixture.data.offers[0]!;
    fixture.data.offers = Array.from({ length: 201 }, (_value, index) => {
      const offer = structuredClone(template);
      offer.id = `off_000000sorted${index}`;
      offer.base_amount = `${100 + index}.00`;
      offer.total_amount = `${120 + index}.00`;
      return offer;
    });

    const results = await provider(
      async () => new Response(JSON.stringify(fixture), { status: 200 }),
    ).search(request, executionOptions(new ProviderExecutionScope()));

    expect(results).toHaveLength(6);
  });

  it('deduplicates, sorts and truncates before upstream-order-independent output', async () => {
    const fixture = duffelFixture();
    const template = fixture.data.offers[0]!;
    fixture.data.offers = Array.from({ length: 8 }, (_value, index) => {
      const offer = structuredClone(template);
      offer.id = `off_000000sorted${index}`;
      offer.base_amount = `${100 + index}.00`;
      offer.total_amount = `${120 + index}.00`;
      return offer;
    });
    const duplicate = structuredClone(fixture.data.offers[0]!);
    duplicate.id = 'off_000000duplicate';
    fixture.data.offers.push(duplicate);
    const run = async (offers: typeof fixture.data.offers) => {
      const response = structuredClone(fixture);
      response.data.offers = offers;
      const scope = new ProviderExecutionScope();
      return provider(async () => new Response(JSON.stringify(response), { status: 200 })).search(
        request,
        executionOptions(scope),
      );
    };

    const forward = await run(fixture.data.offers);
    const reverse = await run([...fixture.data.offers].reverse());
    expect(forward).toHaveLength(6);
    expect(reverse.map((offer) => offer.id)).toEqual(forward.map((offer) => offer.id));
    expect(forward.map((offer) => offer.pricing.mandatoryTotal.amountMinor)).toEqual([
      12_000, 12_100, 12_200, 12_300, 12_400, 12_500,
    ]);
  });

  it('rejects conflicting offers that reuse one Duffel offer ID', async () => {
    const fixture = duffelFixture();
    const conflicting = structuredClone(fixture.data.offers[0]!);
    conflicting.expires_at = '2026-10-01T14:00:00.000Z';
    fixture.data.offers.push(conflicting);
    const scope = new ProviderExecutionScope();

    const error = await provider(async () => new Response(JSON.stringify(fixture), { status: 200 }))
      .search(request, executionOptions(scope))
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProviderExecutionError);
    expect(error).toMatchObject({
      category: 'PARTIAL_DESTINATION',
      evidence: {
        underlyingCategory: 'INVALID_SCHEMA',
        schemaFailureStage: 'RESULT_SEMANTIC_IDENTITY',
        destinationCode: 'PRG',
      },
    });
    expect(scope.getAuditEvents()).toEqual([
      expect.objectContaining({
        status: 'FAILED',
        failureCategory: 'PARTIAL_DESTINATION',
        underlyingFailureCategory: 'INVALID_SCHEMA',
      }),
    ]);
  });

  it('rejects same-ID carrier-name conflicts independently of upstream order', async () => {
    const fixture = duffelFixture();
    const conflicting = structuredClone(fixture.data.offers[0]!);
    conflicting.slices[0]!.segments[0]!.operating_carrier.name = 'Alternate Safe Airline';
    fixture.data.offers.push(conflicting);
    const run = async (offers: typeof fixture.data.offers) => {
      const response = structuredClone(fixture);
      response.data.offers = offers;
      const scope = new ProviderExecutionScope();
      return provider(async () => new Response(JSON.stringify(response), { status: 200 }))
        .search(request, executionOptions(scope))
        .catch((caught: unknown) => caught);
    };

    const forward = await run(fixture.data.offers);
    const reverse = await run([...fixture.data.offers].reverse());
    for (const error of [forward, reverse]) {
      expect(error).toBeInstanceOf(ProviderExecutionError);
      expect(error).toMatchObject({
        category: 'PARTIAL_DESTINATION',
        evidence: {
          underlyingCategory: 'INVALID_SCHEMA',
          schemaFailureStage: 'RESULT_SEMANTIC_IDENTITY',
          destinationCode: 'PRG',
        },
      });
    }
  });

  it('keeps different operating flights with identical aggregate times and prices', async () => {
    const fixture = duffelFixture();
    const distinctFlight = structuredClone(fixture.data.offers[0]!);
    distinctFlight.id = 'off_000000distinctflight';
    distinctFlight.slices.forEach((slice, sliceIndex) => {
      slice.segments.forEach((segment) => {
        segment.operating_carrier = {
          id: 'arl_000000othercarrier',
          name: 'Other Safe Airline',
          iata_code: 'OS',
        };
        segment.operating_carrier_flight_number = `OS10${sliceIndex + 1}`;
      });
    });
    fixture.data.offers.push(distinctFlight);
    const scope = new ProviderExecutionScope();

    const results = await provider(
      async () => new Response(JSON.stringify(fixture), { status: 200 }),
    ).search(request, executionOptions(scope));

    expect(results).toHaveLength(2);
    expect(results.map((offer) => offer.id).sort()).toEqual([
      'duffel:off_000000distinctflight',
      'duffel:off_000000validoffer',
    ]);
  });

  it('keeps different expiry and ancillary completeness during semantic deduplication', async () => {
    const fixture = duffelFixtureWithAvailableServices();
    const complete = fixture.data.offers[0]!;
    complete.available_services = [];

    const laterExpiry = structuredClone(complete);
    laterExpiry.id = 'off_000000laterexpiry';
    laterExpiry.expires_at = '2026-10-01T14:00:00.000Z';

    const unknownAncillaries = structuredClone(complete);
    unknownAncillaries.id = 'off_000000unknownservices';
    Reflect.deleteProperty(unknownAncillaries, 'available_services');
    fixture.data.offers.push(laterExpiry, unknownAncillaries);
    const scope = new ProviderExecutionScope();

    const results = await provider(
      async () => new Response(JSON.stringify(fixture), { status: 200 }),
    ).search(request, executionOptions(scope));

    expect(results).toHaveLength(3);
    expect(results.map((offer) => offer.sourceSnapshot?.expiresAt).sort()).toEqual([
      '2026-10-01T13:00:00.000Z',
      '2026-10-01T13:00:00.000Z',
      '2026-10-01T14:00:00.000Z',
    ]);
    expect(results.map((offer) => offer.pricing.optionalAncillaries.completeness).sort()).toEqual([
      'COMPLETE',
      'COMPLETE',
      'UNKNOWN',
    ]);
  });

  it('maps timeout and cancellation through the run-scoped executor', async () => {
    const pendingTransport: ProviderHttpTransport = async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('raw abort')), {
          once: true,
        });
      });
    const timeoutScope = new ProviderExecutionScope({ policy: { timeoutMs: 10 } });
    const timeout = await provider(pendingTransport)
      .search(request, executionOptions(timeoutScope))
      .catch((error: unknown) => error);
    expect(timeout).toMatchObject({
      category: 'PARTIAL_DESTINATION',
      evidence: { underlyingCategory: 'TIMEOUT' },
    });

    const controller = new AbortController();
    const cancelledScope = new ProviderExecutionScope({ signal: controller.signal });
    const cancelledPromise = provider(pendingTransport)
      .search(request, executionOptions(cancelledScope))
      .catch((error: unknown) => error);
    controller.abort();
    await expect(cancelledPromise).resolves.toMatchObject({ category: 'CANCELLED' });
  });
});
