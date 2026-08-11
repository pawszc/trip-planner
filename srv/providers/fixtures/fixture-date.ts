const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MINUTES_PER_DAY = 24 * 60;

function parseIsoDate(date: string): Date {
  if (!ISO_DATE_PATTERN.test(date)) {
    throw new RangeError(`Expected an ISO calendar date, received: ${date}`);
  }

  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new RangeError(`Expected an existing ISO calendar date, received: ${date}`);
  }

  return parsed;
}

/** Adds UTC calendar days without consulting the host timezone or current clock. */
export function addFixtureDays(date: string, days: number): string {
  if (!Number.isInteger(days)) {
    throw new RangeError(`Fixture day offset must be an integer, received: ${days}`);
  }

  const parsed = parseIsoDate(date);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

/** Combines a request-relative date with an explicit UTC time. */
export function fixtureInstant(date: string, time: string): string {
  parseIsoDate(date);
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) {
    throw new RangeError(`Expected a 24-hour HH:mm time, received: ${time}`);
  }

  return `${date}T${time}:00.000Z`;
}

/** Calculates full request nights using UTC calendar dates only. */
export function fixtureNights(startDate: string, endDate: string): number {
  const start = parseIsoDate(startDate).getTime();
  const end = parseIsoDate(endDate).getTime();
  return (end - start) / (MINUTES_PER_DAY * 60_000);
}

/** Snapshot time is stable and request-relative rather than based on Date.now(). */
export function fixtureFetchedAt(startDate: string): string {
  return fixtureInstant(addFixtureDays(startDate, -30), '12:00');
}
