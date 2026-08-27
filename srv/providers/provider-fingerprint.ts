import { createHash } from 'node:crypto';

export type ProviderJsonValue =
  | string
  | number
  | boolean
  | null
  | readonly ProviderJsonValue[]
  | { readonly [key: string]: ProviderJsonValue };

function isProviderJsonArray(value: ProviderJsonValue): value is readonly ProviderJsonValue[] {
  return Array.isArray(value);
}

function serializeProviderJson(value: ProviderJsonValue, seen: WeakSet<object>): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('Provider fingerprint input must contain only finite numbers.');
    }
    return JSON.stringify(value);
  }
  if (seen.has(value)) {
    throw new TypeError('Provider fingerprint input must not contain circular references.');
  }
  seen.add(value);

  let serialized: string;
  if (isProviderJsonArray(value)) {
    serialized = `[${value.map((item) => serializeProviderJson(item, seen)).join(',')}]`;
  } else {
    const record = value as { readonly [key: string]: ProviderJsonValue };
    serialized = `{${Object.keys(record)
      .sort((left, right) => left.localeCompare(right, 'en'))
      .map((key) => {
        const fieldValue = record[key];
        if (fieldValue === undefined) {
          throw new TypeError(`Provider fingerprint field ${key} is not JSON-serializable.`);
        }
        return `${JSON.stringify(key)}:${serializeProviderJson(fieldValue, seen)}`;
      })
      .join(',')}}`;
  }

  seen.delete(value);
  return serialized;
}

/** Canonical JSON sorts object keys recursively and preserves declared array order. */
export function canonicalizeProviderJson(value: ProviderJsonValue): string {
  return serializeProviderJson(value, new WeakSet<object>());
}

/** SHA-256 over a closed, locally normalized provider view; never over a raw payload. */
export function createProviderFingerprint(value: ProviderJsonValue): string {
  return createHash('sha256').update(canonicalizeProviderJson(value), 'utf8').digest('hex');
}

export function isSha256Fingerprint(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}
