import { describe, expect, it, vi } from 'vitest';
import type { TransportOption } from '../../srv/domain/candidate.js';
import { runCandidateEngine } from '../../srv/orchestration/candidate-engine.js';
import type {
  AccommodationProvider,
  PlacesProvider,
  TransportProvider,
} from '../../srv/providers/contracts.js';
import { REFERENCE_DESTINATIONS } from '../../srv/providers/fixtures/europe-reference-fixtures.js';
import { REFERENCE_PLANNING_CONTEXT } from '../../srv/providers/fixtures/reference-scenario.js';
import { MockAccommodationProvider } from '../../srv/providers/mock-accommodation-provider.js';
import { MockPlacesProvider } from '../../srv/providers/mock-places-provider.js';
import { MockTransportProvider } from '../../srv/providers/mock-transport-provider.js';
import { resolveProviderExecutionPolicy } from '../../srv/providers/provider-execution.js';
import { createProviderFingerprint } from '../../srv/providers/provider-fingerprint.js';
import {
  createProviderConfigurationManifest,
  MOCK_PROVIDER_MANIFEST,
  providerEntry,
  type ProviderConfigurationManifest,
} from '../../srv/providers/provider-manifest.js';
import { REJECTION_CODES } from '../../srv/ranking/rejection-reasons.js';
import { candidateContext, candidateDestination } from './candidate-fixtures.js';

function liveTransportManifest(policy = MOCK_PROVIDER_MANIFEST.executionPolicy) {
  return createProviderConfigurationManifest(
    MOCK_PROVIDER_MANIFEST.entries.map((entry) =>
      entry.role === 'TRANSPORT'
        ? {
            ...entry,
            mode: 'LIVE' as const,
            providerKey: 'offline-live-transport',
            providerName: 'OfflineLiveTransportProvider',
            providerVersion: 'offline-live-transport-v1',
            adapterId: 'offline-live-transport-adapter',
            adapterVersion: 'offline-live-transport-adapter-v1',
            fixtureVersion: null,
            upstreamApiVersion: 'offline-api-v1',
          }
        : entry,
    ),
    policy,
  );
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('candidate engine orchestration', () => {
  it('runs the complete offline reference pipeline and exposes every hard-rule code', async () => {
    const runReference = () =>
      runCandidateEngine({
        context: REFERENCE_PLANNING_CONTEXT,
        destinations: REFERENCE_DESTINATIONS,
        providers: {
          transport: new MockTransportProvider(),
          accommodation: new MockAccommodationProvider(),
          places: new MockPlacesProvider(),
        },
        providerManifest: MOCK_PROVIDER_MANIFEST,
      });
    const result = await runReference();
    const codes = new Set(result.rejectionReasons.map((reason) => reason.code));

    expect(result.counts).toStrictEqual({
      destinations: 8,
      transportOptions: 16,
      stayOptions: 11,
      builtCandidates: 28,
      validCandidates: 6,
      rejectedCandidates: 22,
    });
    expect(result.validCandidates.length).toBeGreaterThanOrEqual(3);
    expect(result.rejectedCandidates).toHaveLength(22);
    expect(result.options).toHaveLength(3);
    expect(
      result.options.map((option) => ({
        role: option.role,
        id: option.candidate.id,
        destination: option.candidate.destination.code,
        total: option.score.total,
      })),
    ).toStrictEqual([
      {
        role: 'BEST_OVERALL',
        id: 'PRG::transport-prg-train-balanced::stay-prg-riverside',
        destination: 'PRG',
        total: 67.56,
      },
      {
        role: 'MOST_CONVENIENT',
        id: 'VIE::transport-vie-train-balanced::stay-vie-ring',
        destination: 'VIE',
        total: 63.64,
      },
      {
        role: 'BEST_VALUE',
        id: 'BUD::transport-bud-train-value::stay-bud-danube',
        destination: 'BUD',
        total: 62.04,
      },
    ]);
    expect(result.shortage).toBeNull();
    expect([...REJECTION_CODES].every((code) => codes.has(code))).toBe(true);
    expect(
      result.options.every((option) => option.score.total >= 0 && option.score.total <= 100),
    ).toBe(true);

    const repeat = await runReference();
    const importantResult = (engineResult: typeof result) => ({
      counts: engineResult.counts,
      candidates: engineResult.candidates.map((candidate) => candidate.id),
      validCandidates: engineResult.validCandidates.map((candidate) => candidate.id),
      rejectedCandidates: engineResult.rejectedCandidates.map((rejected) => ({
        id: rejected.candidate.id,
        reasons: rejected.reasons,
      })),
      rankedCandidates: engineResult.rankedCandidates.map((ranked) => ({
        id: ranked.candidate.id,
        score: ranked.score,
      })),
      options: engineResult.options,
      shortage: engineResult.shortage,
    });
    expect(importantResult(repeat)).toStrictEqual(importantResult(result));
  });

  it('deduplicates destinations and applies the configurable fan-out bound', async () => {
    const transportSearch = vi.fn<TransportProvider['search']>().mockResolvedValue([]);
    const accommodationSearch = vi.fn<AccommodationProvider['search']>().mockResolvedValue([]);
    const placesSearch = vi.fn<PlacesProvider['search']>().mockResolvedValue([]);
    const second = { code: 'VIE', city: 'Vienna', countryCode: 'AT' };
    const result = await runCandidateEngine({
      context: candidateContext,
      destinations: [second, candidateDestination, { ...candidateDestination }],
      providers: {
        transport: { search: transportSearch },
        accommodation: { search: accommodationSearch },
        places: { search: placesSearch },
      },
      providerManifest: MOCK_PROVIDER_MANIFEST,
      config: { limits: { maxDestinations: 1 } },
    });

    expect(transportSearch).toHaveBeenCalledTimes(1);
    expect(transportSearch.mock.calls[0]?.[0].destinations).toEqual([candidateDestination]);
    expect(accommodationSearch).toHaveBeenCalledTimes(1);
    expect(placesSearch).toHaveBeenCalledTimes(1);
    expect(result.counts.destinations).toBe(1);
    expect(result.shortage).toMatchObject({ required: 3, available: 0 });
  });

  it.each([
    { label: 'zero budget', context: { ...candidateContext, totalBudgetMinor: 0 } },
    { label: 'fractional adults', context: { ...candidateContext, adults: 1.5 } },
    { label: 'lowercase currency', context: { ...candidateContext, currency: 'pln' } },
    { label: 'impossible date', context: { ...candidateContext, startDate: '2026-02-30' } },
    {
      label: 'invalid preference',
      context: {
        ...candidateContext,
        softPreferences: { ...candidateContext.softPreferences, food: 6 },
      },
    },
    {
      label: 'invalid hard constraints',
      context: {
        ...candidateContext,
        hardConstraints: {
          ...candidateContext.hardConstraints,
          allowBus: false,
          allowTrain: false,
          allowFlight: false,
        },
      },
    },
  ])('rejects $label before invoking a provider', async ({ context }) => {
    const search = vi.fn<TransportProvider['search']>().mockResolvedValue([]);
    await expect(
      runCandidateEngine({
        context,
        destinations: [candidateDestination],
        providers: {
          transport: { search },
          accommodation: { search: async () => [] },
          places: { search: async () => [] },
        },
        providerManifest: MOCK_PROVIDER_MANIFEST,
      }),
    ).rejects.toMatchObject({ name: 'DomainError' });
    expect(search).not.toHaveBeenCalled();
  });

  it('rejects invalid destinations and unsafe limit overrides deterministically', async () => {
    const providers = {
      transport: { search: async () => [] },
      accommodation: { search: async () => [] },
      places: { search: async () => [] },
    } satisfies {
      transport: TransportProvider;
      accommodation: AccommodationProvider;
      places: PlacesProvider;
    };
    await expect(
      runCandidateEngine({
        context: candidateContext,
        destinations: [{ ...candidateDestination, code: '' }],
        providers,
        providerManifest: MOCK_PROVIDER_MANIFEST,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_DESTINATION' });
    await expect(
      runCandidateEngine({
        context: candidateContext,
        destinations: [candidateDestination],
        providers,
        providerManifest: MOCK_PROVIDER_MANIFEST,
        config: { limits: { maxCandidatesPerDestination: -1 } },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_CANDIDATE_ENGINE_CONFIG' });
  });

  it('keeps selectionCount fixed at three even when a caller tries to lower it', async () => {
    const result = await runCandidateEngine({
      context: candidateContext,
      destinations: [],
      providers: {
        transport: { search: async () => [] },
        accommodation: { search: async () => [] },
        places: { search: async () => [] },
      },
      providerManifest: MOCK_PROVIDER_MANIFEST,
      config: { selectionCount: 1 },
    });
    expect(result.shortage).toMatchObject({ required: 3, missing: 3 });
  });

  it('maps a provider failure to a controlled domain error without leaking its message', async () => {
    await expect(
      runCandidateEngine({
        context: candidateContext,
        destinations: [candidateDestination],
        providers: {
          transport: { search: async () => Promise.reject(new Error('secret provider trace')) },
          accommodation: { search: async () => [] },
          places: { search: async () => [] },
        },
        providerManifest: MOCK_PROVIDER_MANIFEST,
      }),
    ).rejects.toMatchObject({
      code: 'PROVIDER_SEARCH_FAILED',
      message: 'Nie udało się pobrać danych do planowania.',
    });
  });

  it.each([
    {
      label: 'extra top-level field',
      manifest: { ...MOCK_PROVIDER_MANIFEST, credential: 'must-not-be-accepted' },
    },
    {
      label: 'unsupported manifest version',
      manifest: { ...MOCK_PROVIDER_MANIFEST, manifestVersion: 'unsupported-manifest' },
    },
    {
      label: 'duplicate provider role',
      manifest: {
        ...MOCK_PROVIDER_MANIFEST,
        entries: [...MOCK_PROVIDER_MANIFEST.entries, MOCK_PROVIDER_MANIFEST.entries[0]],
      },
    },
  ])('rejects a closed-manifest violation ($label) before provider calls', async ({ manifest }) => {
    const transportSearch = vi.fn<TransportProvider['search']>().mockResolvedValue([]);
    const accommodationSearch = vi.fn<AccommodationProvider['search']>().mockResolvedValue([]);
    const placesSearch = vi.fn<PlacesProvider['search']>().mockResolvedValue([]);

    await expect(
      runCandidateEngine({
        context: candidateContext,
        destinations: [candidateDestination],
        providers: {
          transport: { search: transportSearch },
          accommodation: { search: accommodationSearch },
          places: { search: placesSearch },
        },
        providerManifest: manifest as unknown as ProviderConfigurationManifest,
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_SEARCH_FAILED' });

    expect(transportSearch).not.toHaveBeenCalled();
    expect(accommodationSearch).not.toHaveBeenCalled();
    expect(placesSearch).not.toHaveBeenCalled();
  });

  it('rejects a changed normalized DTO that reuses the previous source result fingerprint', async () => {
    const fixtureProvider = new MockAccommodationProvider();
    const accommodationSearch = vi.fn<AccommodationProvider['search']>(async (request, options) =>
      (await fixtureProvider.search(request, options)).map((offer, index) =>
        index === 0 ? { ...offer, name: `${offer.name} changed` } : offer,
      ),
    );

    await expect(
      runCandidateEngine({
        context: REFERENCE_PLANNING_CONTEXT,
        destinations: [REFERENCE_DESTINATIONS[0]!],
        providers: {
          transport: new MockTransportProvider(),
          accommodation: { search: accommodationSearch },
          places: new MockPlacesProvider(),
        },
        providerManifest: MOCK_PROVIDER_MANIFEST,
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_SEARCH_FAILED' });

    expect(accommodationSearch).toHaveBeenCalledTimes(1);
  });

  it('fails closed when a live manifest is paired with fixture provider results', async () => {
    const mixedManifest = liveTransportManifest();

    await expect(
      runCandidateEngine({
        context: REFERENCE_PLANNING_CONTEXT,
        destinations: [REFERENCE_DESTINATIONS[0]!],
        providers: {
          transport: new MockTransportProvider(),
          accommodation: new MockAccommodationProvider(),
          places: new MockPlacesProvider(),
        },
        providerManifest: mixedManifest,
      }),
    ).rejects.toMatchObject({
      code: 'PROVIDER_SEARCH_FAILED',
      message: 'Nie udało się pobrać danych do planowania.',
    });
  });

  it('requires live runtime provider identity even when the provider would return no rows', async () => {
    const manifest = liveTransportManifest();
    const transportSearch = vi.fn<TransportProvider['search']>().mockResolvedValue([]);

    await expect(
      runCandidateEngine({
        context: candidateContext,
        destinations: [candidateDestination],
        providers: {
          transport: { search: transportSearch },
          accommodation: new MockAccommodationProvider(),
          places: new MockPlacesProvider(),
        },
        providerManifest: manifest,
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_SEARCH_FAILED' });

    expect(transportSearch).not.toHaveBeenCalled();
  });

  it('rejects mismatched live runtime provider identity before an empty-result call', async () => {
    const manifest = liveTransportManifest();
    const configured = providerEntry(manifest, 'TRANSPORT');
    const transportSearch = vi.fn<TransportProvider['search']>().mockResolvedValue([]);

    await expect(
      runCandidateEngine({
        context: candidateContext,
        destinations: [candidateDestination],
        providers: {
          transport: {
            manifestEntry: { ...configured, adapterVersion: 'different-adapter-v1' },
            search: transportSearch,
          },
          accommodation: new MockAccommodationProvider(),
          places: new MockPlacesProvider(),
        },
        providerManifest: manifest,
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_SEARCH_FAILED' });

    expect(transportSearch).not.toHaveBeenCalled();
  });

  it('rejects a structurally invalid resolved live DTO through the controlled boundary', async () => {
    const manifest = liveTransportManifest();
    const configured = providerEntry(manifest, 'TRANSPORT');
    const transportSearch = vi
      .fn<TransportProvider['search']>()
      .mockResolvedValue([{ id: '' } as unknown as TransportOption]);

    await expect(
      runCandidateEngine({
        context: candidateContext,
        destinations: [candidateDestination],
        providers: {
          transport: { manifestEntry: configured, search: transportSearch },
          accommodation: new MockAccommodationProvider(),
          places: new MockPlacesProvider(),
        },
        providerManifest: manifest,
      }),
    ).rejects.toMatchObject({
      code: 'PROVIDER_SEARCH_FAILED',
      message: 'Nie udało się pobrać danych do planowania.',
    });

    expect(transportSearch).toHaveBeenCalledTimes(1);
  });

  it('enforces concurrency across actual upstream requests made inside one live adapter search', async () => {
    const manifest = liveTransportManifest(
      resolveProviderExecutionPolicy({ maxCallsPerRun: 2, maxConcurrency: 1 }),
    );
    const configured = providerEntry(manifest, 'TRANSPORT');
    const gates = [deferred<readonly []>(), deferred<readonly []>()];
    const started: number[] = [];
    let active = 0;
    let maximumActive = 0;
    const transport: TransportProvider = {
      manifestEntry: configured,
      search: async (_request, options) => {
        if (options === undefined) throw new Error('Missing upstream executor.');
        const calls = [0, 1].map((index) =>
          options.executeUpstream(
            {
              queryFingerprint: createProviderFingerprint({ upstreamRequest: index }),
              resultFingerprint: () => createProviderFingerprint({ upstreamResult: index }),
              resultCount: (result) => result.length,
            },
            async () => {
              started.push(index);
              active += 1;
              maximumActive = Math.max(maximumActive, active);
              try {
                return await gates[index]!.promise;
              } finally {
                active -= 1;
              }
            },
          ),
        );
        return (await Promise.all(calls)).flat();
      },
    };

    const run = runCandidateEngine({
      context: candidateContext,
      destinations: [],
      providers: {
        transport,
        accommodation: new MockAccommodationProvider(),
        places: new MockPlacesProvider(),
      },
      providerManifest: manifest,
    });

    await vi.waitFor(() => expect(started).toEqual([0]));
    gates[0]!.resolve([]);
    await vi.waitFor(() => expect(started).toEqual([0, 1]));
    gates[1]!.resolve([]);

    const result = await run;
    expect(maximumActive).toBe(1);
    expect(result.providerExecution.calls).toHaveLength(2);
    expect(result.providerExecution.calls.map((event) => event.sequence)).toEqual([1, 2]);
  });

  it('blocks the first real upstream request beyond the run budget before transport invocation', async () => {
    const manifest = liveTransportManifest(
      resolveProviderExecutionPolicy({ maxCallsPerRun: 2, maxConcurrency: 1 }),
    );
    const configured = providerEntry(manifest, 'TRANSPORT');
    const invoked: number[] = [];
    const transport: TransportProvider = {
      manifestEntry: configured,
      search: async (_request, options) => {
        if (options === undefined) throw new Error('Missing upstream executor.');
        for (const index of [0, 1, 2]) {
          await options.executeUpstream(
            {
              queryFingerprint: createProviderFingerprint({ upstreamRequest: index }),
              resultFingerprint: () => createProviderFingerprint({ upstreamResult: index }),
              resultCount: (result) => result.length,
            },
            async () => {
              invoked.push(index);
              return [] as const;
            },
          );
        }
        return [];
      },
    };

    await expect(
      runCandidateEngine({
        context: candidateContext,
        destinations: [],
        providers: {
          transport,
          accommodation: new MockAccommodationProvider(),
          places: new MockPlacesProvider(),
        },
        providerManifest: manifest,
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_SEARCH_FAILED' });
    expect(invoked).toEqual([0, 1]);
  });
});
