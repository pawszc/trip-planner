import { describe, expect, it } from 'vitest';
import { parseStrictIsoDate } from '../../srv/validation/strict-iso-date.js';

describe('strict ISO calendar date parsing', () => {
  it.each(['2024-02-29', '2000-02-29', '2026-10-10'])(
    'accepts an existing calendar date (%s)',
    (value) => {
      const timestamp = parseStrictIsoDate(value);
      expect(timestamp).not.toBeNull();
      expect(new Date(timestamp ?? Number.NaN).toISOString().slice(0, 10)).toBe(value);
    },
  );

  it.each([
    '2026-02-29',
    '1900-02-29',
    '2026-04-31',
    '2026-13-01',
    '2026-00-01',
    '2026-01-00',
    '2026-1-01',
    'not-a-date',
  ])('rejects a malformed or non-existing calendar date (%s)', (value) => {
    expect(parseStrictIsoDate(value)).toBeNull();
  });
});
