import { describe, expect, it, vi } from 'vitest';
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
import { REJECTION_CODES } from '../../srv/ranking/rejection-reasons.js';
import { candidateContext, candidateDestination } from './candidate-fixtures.js';

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
      }),
    ).rejects.toMatchObject({ code: 'INVALID_DESTINATION' });
    await expect(
      runCandidateEngine({
        context: candidateContext,
        destinations: [candidateDestination],
        providers,
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
      config: { selectionCount: 1 },
    });
    expect(result.shortage).toMatchObject({ required: 3, missing: 3 });
  });
});
