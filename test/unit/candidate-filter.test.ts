import { describe, expect, it } from 'vitest';
import type {
  Place,
  RejectionCode,
  RejectionReason,
  TripCandidate,
} from '../../srv/domain/candidate.js';
import { createMoney, unknownMoney, type SourceSnapshot } from '../../srv/domain/money.js';
import {
  candidateSemanticSignature,
  filterCandidates,
  validateCandidate,
} from '../../srv/ranking/candidate-filter.js';
import { candidateContext, candidateFixture, candidateSource } from './candidate-fixtures.js';

function reasonsFor(candidate: TripCandidate): readonly RejectionReason[] {
  return validateCandidate(candidate, candidateContext).reasons;
}

describe('candidate hard filtering', () => {
  it.each([
    ['expired', '2026-10-01T12:00:00.000Z'],
    ['missing expiry', null],
  ] as const)('rejects LIVE transport with %s before ranking', (_label, expiresAt) => {
    const candidate = candidateFixture();
    const fixtureSource = candidate.transport.sourceSnapshot;
    if (fixtureSource === null) throw new Error('Missing transport source fixture.');
    const liveSource: SourceSnapshot = {
      ...fixtureSource,
      sourceType: 'LIVE',
      provider: 'Duffel',
      freshnessType: 'LIVE',
      fixtureVersion: null,
      sourceUrl: 'https://duffel.com',
      expiresAt,
    };
    const withSource = <T extends { sourceSnapshot: SourceSnapshot | null }>(money: T): T => ({
      ...money,
      sourceSnapshot: liveSource,
    });
    const transport = {
      ...candidate.transport,
      sourceSnapshot: liveSource,
      price: withSource(candidate.transport.price),
      additionalFees: withSource(candidate.transport.additionalFees),
      pricing: {
        ...candidate.transport.pricing,
        mandatoryTotal: withSource(candidate.transport.pricing.mandatoryTotal),
      },
    };
    const result = validateCandidate(
      { ...candidate, transport },
      candidateContext,
      {},
      () => new Date('2026-10-01T12:00:00.000Z'),
    );

    expect(result.reasons.map((reason) => reason.code)).toContain('INCOMPLETE_DATA');
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          details: expect.objectContaining({
            fields: expect.arrayContaining([expect.stringMatching(/^sourceFreshness:transport:/u)]),
          }),
        }),
      ]),
    );
  });

  it('does not apply selectable-offer expiry rules to a live place snapshot', () => {
    const candidate = candidateFixture();
    const place = candidate.places[0];
    if (place?.sourceSnapshot === null || place?.sourceSnapshot === undefined) {
      throw new Error('Missing place source fixture.');
    }
    const livePlaceSource: SourceSnapshot = {
      ...place.sourceSnapshot,
      sourceType: 'LIVE',
      provider: 'OfflineLivePlacesProvider',
      freshnessType: 'LIVE',
      fixtureVersion: null,
      sourceUrl: 'https://example.test',
      expiresAt: null,
    };
    const result = validateCandidate(
      {
        ...candidate,
        places: [{ ...place, sourceSnapshot: livePlaceSource }, ...candidate.places.slice(1)],
      },
      candidateContext,
      {},
      () => new Date('2026-10-01T12:00:00.000Z'),
    );

    expect(result.reasons).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          details: expect.objectContaining({
            fields: expect.arrayContaining([expect.stringMatching(/^sourceFreshness:place:/u)]),
          }),
        }),
      ]),
    );
  });

  const cases: readonly {
    code: RejectionCode;
    evaluate: () => readonly RejectionReason[];
  }[] = [
    {
      code: 'BUDGET_EXCEEDED',
      evaluate: () => {
        const candidate = candidateFixture();
        return reasonsFor({
          ...candidate,
          budget: { ...candidate.budget, totalAmountMinor: candidateContext.totalBudgetMinor + 1 },
        });
      },
    },
    {
      code: 'DEPARTURE_TOO_EARLY',
      evaluate: () => {
        const candidate = candidateFixture();
        return reasonsFor({
          ...candidate,
          transport: {
            ...candidate.transport,
            outbound: {
              ...candidate.transport.outbound,
              departureAt: '2026-10-10T05:00:00.000Z',
            },
          },
        });
      },
    },
    {
      code: 'RETURN_TOO_LATE',
      evaluate: () => {
        const candidate = candidateFixture();
        return reasonsFor({
          ...candidate,
          transport: {
            ...candidate.transport,
            return: {
              ...candidate.transport.return,
              arrivalAt: '2026-10-13T23:00:00.000Z',
            },
          },
        });
      },
    },
    {
      code: 'TOO_MANY_CONNECTIONS',
      evaluate: () => {
        const candidate = candidateFixture();
        return reasonsFor({
          ...candidate,
          transport: {
            ...candidate.transport,
            outbound: { ...candidate.transport.outbound, connections: 2 },
          },
        });
      },
    },
    {
      code: 'TRANSPORT_MODE_NOT_ALLOWED',
      evaluate: () => {
        const candidate = candidateFixture();
        return reasonsFor({
          ...candidate,
          transport: { ...candidate.transport, mode: 'FLIGHT' },
        });
      },
    },
    {
      code: 'TRAVEL_TIME_EXCEEDED',
      evaluate: () => {
        const candidate = candidateFixture();
        return reasonsFor({
          ...candidate,
          transport: {
            ...candidate.transport,
            outbound: { ...candidate.transport.outbound, durationMinutes: 481 },
          },
        });
      },
    },
    {
      code: 'REQUIRED_PRICE_UNKNOWN',
      evaluate: () => {
        const candidate = candidateFixture();
        return reasonsFor({
          ...candidate,
          transport: {
            ...candidate.transport,
            price: unknownMoney('PLN', candidate.transport.sourceSnapshot),
          },
          budget: {
            ...candidate.budget,
            transport: unknownMoney('PLN', candidate.transport.sourceSnapshot),
            unknownCategories: ['TRANSPORT'],
            totalAmountMinor: null,
            costPerPersonMinor: null,
            remainingBudgetMinor: null,
          },
        });
      },
    },
    {
      code: 'SOURCE_MISSING',
      evaluate: () => {
        const candidate = candidateFixture();
        return reasonsFor({
          ...candidate,
          transport: { ...candidate.transport, sourceSnapshot: null },
        });
      },
    },
    {
      code: 'CURRENCY_MISMATCH',
      evaluate: () => {
        const candidate = candidateFixture();
        const eurSource = candidateSource('eur', 'EUR');
        return reasonsFor({
          ...candidate,
          transport: {
            ...candidate.transport,
            price: createMoney(10_000, 'EUR', 'FIXED_PRICE', eurSource),
          },
        });
      },
    },
    {
      code: 'DUPLICATE_CANDIDATE',
      evaluate: () => {
        const original = candidateFixture();
        const duplicate = {
          ...original,
          id: 'duplicate-candidate',
          transport: { ...original.transport, id: 'different-provider-id' },
        };
        return filterCandidates([original, duplicate], candidateContext).rejectedCandidates.flatMap(
          (result) => result.reasons,
        );
      },
    },
    {
      code: 'INSUFFICIENT_TIME_AT_DESTINATION',
      evaluate: () => reasonsFor({ ...candidateFixture(), effectiveTimeAtDestinationMinutes: 60 }),
    },
    {
      code: 'INVALID_DATES',
      evaluate: () => {
        const candidate = candidateFixture();
        return reasonsFor({
          ...candidate,
          transport: {
            ...candidate.transport,
            outbound: {
              ...candidate.transport.outbound,
              arrivalAt: '2026-10-10T07:00:00.000Z',
            },
          },
        });
      },
    },
    {
      code: 'INCOMPLETE_DATA',
      evaluate: () => {
        const candidate = candidateFixture();
        return reasonsFor({
          ...candidate,
          transport: { ...candidate.transport, id: '' },
        });
      },
    },
  ];

  it.each(cases)('emits the closed-list reason $code', ({ code, evaluate }) => {
    const reasons = evaluate();
    expect(reasons.map((reason) => reason.code)).toContain(code);
    for (const reason of reasons) {
      expect('candidateId' in reason).not.toBe('optionId' in reason);
      expect(reason.message.length).toBeGreaterThan(0);
    }
  });

  it('collects multiple hard-rule violations instead of stopping at the first', () => {
    const candidate = candidateFixture();
    const broken = {
      ...candidate,
      effectiveTimeAtDestinationMinutes: 30,
      transport: {
        ...candidate.transport,
        mode: 'FLIGHT' as const,
        outbound: {
          ...candidate.transport.outbound,
          departureAt: '2026-10-10T05:00:00.000Z',
          connections: 4,
          durationMinutes: 600,
        },
        return: {
          ...candidate.transport.return,
          arrivalAt: '2026-10-13T23:00:00.000Z',
        },
      },
    };
    const codes = reasonsFor(broken).map((reason) => reason.code);
    expect(codes).toEqual(
      expect.arrayContaining([
        'DEPARTURE_TOO_EARLY',
        'RETURN_TOO_LATE',
        'TOO_MANY_CONNECTIONS',
        'TRANSPORT_MODE_NOT_ALLOWED',
        'TRAVEL_TIME_EXCEEDED',
        'INSUFFICIENT_TIME_AT_DESTINATION',
      ]),
    );
  });

  it('does not apply the scoring fallback as a hard travel limit when maxTravelMinutes is null', () => {
    const candidate = candidateFixture();
    const longTravel = {
      ...candidate,
      effectiveTimeAtDestinationMinutes: 4_020,
      transport: {
        ...candidate.transport,
        outbound: {
          ...candidate.transport.outbound,
          arrivalAt: '2026-10-10T21:00:00.000Z',
          durationMinutes: 780,
        },
      },
    };
    const context = {
      ...candidateContext,
      hardConstraints: { ...candidateContext.hardConstraints, maxTravelMinutes: null },
    };
    const codes = validateCandidate(longTravel, context, {
      defaultMaximumTravelMinutes: 1,
    }).reasons.map((reason) => reason.code);

    expect(codes).not.toContain('TRAVEL_TIME_EXCEEDED');
  });

  it('rejects an UNKNOWN required buffer instead of letting an incomplete total rank', () => {
    const candidate = candidateFixture();
    const buffer = unknownMoney('PLN', candidate.budget.buffer.sourceSnapshot);
    const reasons = reasonsFor({
      ...candidate,
      budget: {
        ...candidate.budget,
        buffer,
        unknownCategories: ['BUFFER'],
        totalAmountMinor: null,
        costPerPersonMinor: null,
        remainingBudgetMinor: null,
      },
    });
    expect(reasons.map((reason) => reason.code)).toContain('REQUIRED_PRICE_UNKNOWN');
  });

  it('marks a null total with no unknown or currency mismatch as incomplete data', () => {
    const candidate = candidateFixture();
    const reasons = reasonsFor({
      ...candidate,
      budget: {
        ...candidate.budget,
        totalAmountMinor: null,
        costPerPersonMinor: null,
        remainingBudgetMinor: null,
      },
    });
    expect(reasons.map((reason) => reason.code)).toContain('INCOMPLETE_DATA');
  });

  it('keeps the valid semantic representative even when an invalid duplicate is cheaper', () => {
    const valid = candidateFixture();
    const invalid = {
      ...valid,
      id: 'cheaper-invalid',
      transport: {
        ...valid.transport,
        id: 'provider-duplicate',
        sourceSnapshot: null,
      },
      budget: { ...valid.budget, totalAmountMinor: 1 },
    };
    const result = filterCandidates([invalid, valid], candidateContext);

    expect(result.validCandidates.map((candidate) => candidate.id)).toEqual([valid.id]);
    expect(result.rejectedCandidates[0]?.reasons.map((reason) => reason.code)).toEqual(
      expect.arrayContaining(['SOURCE_MISSING', 'DUPLICATE_CANDIDATE']),
    );
  });

  it('deduplicates equivalent instants expressed with Z and an explicit offset', () => {
    const original = candidateFixture();
    const equivalent = {
      ...original,
      id: 'offset-equivalent',
      transport: {
        ...original.transport,
        id: 'offset-provider-id',
        outbound: {
          ...original.transport.outbound,
          departureAt: '2026-10-10T10:00:00.000+02:00',
          arrivalAt: '2026-10-10T14:00:00.000+02:00',
        },
        return: {
          ...original.transport.return,
          departureAt: '2026-10-13T18:00:00.000+02:00',
          arrivalAt: '2026-10-13T22:00:00.000+02:00',
        },
      },
    };

    expect(candidateSemanticSignature(equivalent)).toBe(candidateSemanticSignature(original));
    const result = filterCandidates([original, equivalent], candidateContext);
    expect(result.validCandidates).toHaveLength(1);
    expect(result.rejectedCandidates[0]?.reasons.map((reason) => reason.code)).toContain(
      'DUPLICATE_CANDIDATE',
    );
  });

  it.each(['blank fields', 'missing fields'] as const)(
    'treats a non-null snapshot with %s as a missing source',
    (variant) => {
      const candidate = candidateFixture();
      const sourceSnapshot = candidate.transport.sourceSnapshot;
      if (sourceSnapshot === null) throw new Error('Missing source fixture.');
      const incompleteSource: SourceSnapshot =
        variant === 'blank fields'
          ? { ...sourceSnapshot, id: '', provider: ' ' }
          : ({ id: 'only-field' } as unknown as SourceSnapshot);
      const reasons = reasonsFor({
        ...candidate,
        transport: {
          ...candidate.transport,
          sourceSnapshot: incompleteSource,
        },
      });

      expect(reasons.map((reason) => reason.code)).toContain('SOURCE_MISSING');
    },
  );

  it('marks missing preference score keys as incomplete data', () => {
    const candidate = candidateFixture();
    const place = candidate.places[0];
    if (!place) throw new Error('Missing place fixture.');
    const preferenceScores = { food: 90 } as unknown as Place['preferenceScores'];
    const reasons = reasonsFor({
      ...candidate,
      places: [{ ...place, preferenceScores }],
    });

    expect(reasons.map((reason) => reason.code)).toContain('INCOMPLETE_DATA');
  });

  it('rejects normalized impossible and context-mismatched stay dates', () => {
    const candidate = candidateFixture();
    for (const stay of [
      { ...candidate.stay, checkInDate: '2026-02-30' },
      { ...candidate.stay, checkInDate: '2026-10-11', nights: 2 },
    ]) {
      expect(reasonsFor({ ...candidate, stay }).map((reason) => reason.code)).toContain(
        'INVALID_DATES',
      );
    }
  });

  it('requires an explicit timezone in every transport instant', () => {
    const candidate = candidateFixture();
    const reasons = reasonsFor({
      ...candidate,
      transport: {
        ...candidate.transport,
        outbound: {
          ...candidate.transport.outbound,
          departureAt: '2026-10-10T08:00:00',
        },
      },
    });
    expect(reasons.map((reason) => reason.code)).toContain('INVALID_DATES');
  });

  it('uses the explicit local calendar date for a departure near the UTC boundary', () => {
    const candidate = candidateFixture();
    const result = validateCandidate(
      {
        ...candidate,
        transport: {
          ...candidate.transport,
          outbound: {
            ...candidate.transport.outbound,
            departureAt: '2026-10-10T00:30:00.000+02:00',
            arrivalAt: '2026-10-10T04:30:00.000+02:00',
          },
        },
      },
      {
        ...candidateContext,
        hardConstraints: { ...candidateContext.hardConstraints, earliestDepartureTime: null },
      },
    );

    expect(result.reasons.map((reason) => reason.code)).not.toContain('INVALID_DATES');
  });

  it('rejects a return arriving on the next local calendar day even when its UTC day still fits', () => {
    const candidate = candidateFixture();
    const result = validateCandidate(
      {
        ...candidate,
        transport: {
          ...candidate.transport,
          return: {
            ...candidate.transport.return,
            departureAt: '2026-10-13T20:30:00.000+02:00',
            arrivalAt: '2026-10-14T00:30:00.000+02:00',
          },
        },
      },
      {
        ...candidateContext,
        hardConstraints: { ...candidateContext.hardConstraints, latestReturnTime: null },
      },
    );

    expect(result.reasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'INVALID_DATES',
          details: { issues: expect.arrayContaining(['outside-trip-window']) },
        }),
      ]),
    );
  });
});
