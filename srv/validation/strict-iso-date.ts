const STRICT_ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parsuje istniejącą datę kalendarzową YYYY-MM-DD jako północ UTC.
 * Round-trip odrzuca wartości normalizowane przez Date, np. 2026-02-29 lub 2026-04-31.
 */
export function parseStrictIsoDate(value: string): number | null {
  if (!STRICT_ISO_DATE_PATTERN.test(value)) return null;

  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(timestamp)) return null;

  return new Date(timestamp).toISOString().slice(0, 10) === value ? timestamp : null;
}
