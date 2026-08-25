import { describe, expect, it } from 'vitest';
import { calculateEffectiveTimeAtDestinationMinutes } from '../../srv/ranking/effective-time.ts';
import { candidateFixture, candidateTransport } from './candidate-fixtures.ts';

describe('effective time at destination', () => {
  it('floors the exact interval between outbound arrival and return departure', () => {
    expect(
      calculateEffectiveTimeAtDestinationMinutes(
        '2026-10-10T11:15:00.000Z',
        '2026-10-13T17:00:59.999Z',
      ),
    ).toBe(4_665);
  });

  it('is the production rule used by the candidate engine', () => {
    const transport = candidateTransport();
    expect(candidateFixture().effectiveTimeAtDestinationMinutes).toBe(
      calculateEffectiveTimeAtDestinationMinutes(
        transport.outbound.arrivalAt,
        transport.return.departureAt,
      ),
    );
  });

  it.each([
    ['invalid arrival', 'not-a-timestamp', '2026-10-13T17:00:00.000Z'],
    ['invalid departure', '2026-10-10T11:15:00.000Z', 'not-a-timestamp'],
    ['reversed interval', '2026-10-13T17:00:00.000Z', '2026-10-10T11:15:00.000Z'],
  ])('preserves fail-closed zero for %s', (_label, arrival, departure) => {
    expect(calculateEffectiveTimeAtDestinationMinutes(arrival, departure)).toBe(0);
  });
});
