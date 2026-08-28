import { describe, expect, it, vi } from 'vitest';
import type { Destination } from '../../srv/domain/candidate.js';
import type { TransportSearchRequest } from '../../srv/providers/contracts.js';
import { DuffelApiTransportProvider } from '../../srv/providers/duffel/duffel-api-transport-provider.js';
import { mapDuffelOffer } from '../../srv/providers/duffel/duffel-mapper.js';
import { createDuffelTransportManifestEntry } from '../../srv/providers/duffel/duffel-profile.js';
import {
  buildDuffelOfferRequestPlans,
  DUFFEL_ORIGIN_CATALOG_VERSION,
} from '../../srv/providers/duffel/duffel-search-policy.js';
import { duffelOfferRequestResponseSchema } from '../../srv/providers/duffel/duffel-schemas.js';
import {
  DUFFEL_API_BASE_URL,
  ProviderHttpClient,
  type ProviderHttpTransport,
} from '../../srv/providers/http/provider-http-client.js';
import { ProviderExecutionScope } from '../../srv/providers/provider-execution.js';
import type { ProviderCallOptions } from '../../srv/providers/provider-execution.js';
import { ProviderExecutionError } from '../../srv/providers/provider-errors.js';
import { createProviderFingerprint } from '../../srv/providers/provider-fingerprint.js';
import {
  duffelFixture,
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
    const plans = buildDuffelOfferRequestPlans({
      ...request,
      destinations: [{ code: 'VIE', city: 'Vienna', countryCode: 'AT' }, destination],
    });
    expect(DUFFEL_ORIGIN_CATALOG_VERSION).toBe('duffel-origin-iata-catalog-v1');
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
});

describe('Duffel schemas and mapper', () => {
  it('validates used fields and strips every non-allowlisted provider field', () => {
    const parsed = duffelOfferRequestResponseSchema.parse(validDuffelOfferRequestResponse);
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
  ] as const)('rejects malformed fixture: %s', (_label, mutate) => {
    const fixture = duffelFixture();
    mutate(fixture);
    expect(duffelOfferRequestResponseSchema.safeParse(fixture).success).toBe(false);
  });

  it('maps exact money, two slices, carrier attribution, services and SourceSnapshot v2', () => {
    const parsed = duffelOfferRequestResponseSchema.parse(validDuffelOfferRequestResponse);
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
    const fixture = duffelFixture();
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
    ],
    [
      '5xx',
      async () => new Response('provider text secret-test-token', { status: 503 }),
      'UPSTREAM_5XX',
      503,
    ],
    [
      'invalid JSON',
      async () => new Response('{not-json', { status: 200 }),
      'INVALID_SCHEMA',
      null,
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
    ],
    [
      'network',
      async () => {
        throw new Error('raw network secret-test-token');
      },
      'NETWORK',
      null,
    ],
  ] as const)(
    'normalizes %s without raw provider data',
    async (_label, transport, underlying, status) => {
      const scope = new ProviderExecutionScope();
      const error = await provider(transport)
        .search(request, executionOptions(scope))
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ProviderExecutionError);
      expect(error).toMatchObject({
        category: 'PARTIAL_DESTINATION',
        evidence: { underlyingCategory: underlying, httpStatus: status, destinationCode: 'PRG' },
      });
      expect(JSON.stringify((error as ProviderExecutionError).toSafeJSON())).not.toContain(
        'secret-test-token',
      );
    },
  );

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
