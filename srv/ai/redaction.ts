const REDACTED = '[REDACTED]';
const SENSITIVE_FIELD_NAMES = new Set([
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'API_KEY',
  'ACCESS_TOKEN',
  'TOKEN',
  'SECRET',
  'PASSWORD',
  'AUTHORIZATION',
  'X_API_KEY',
]);

function normalizeFieldName(name: string): string {
  return name
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replaceAll('-', '_')
    .toUpperCase();
}

function redactString(value: string): string {
  return value
    .replace(/\bsk-ant-[A-Za-z0-9_-]{16,}\b/g, REDACTED)
    .replace(/\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{16,}\b/g, REDACTED)
    .replace(/(authorization\s*[:=]\s*)(?:bearer\s+)?[^\s,;]+/gi, `$1${REDACTED}`)
    .replace(/(x-api-key\s*[:=]\s*)[^\s,;]+/gi, `$1${REDACTED}`);
}

function redact(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') {
    return redactString(value);
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (seen.has(value)) {
    return '[CIRCULAR]';
  }
  seen.add(value);

  let result: unknown;
  if (Array.isArray(value)) {
    result = value.map((item) => redact(item, seen));
  } else {
    const redactedObject: Record<string, unknown> = {};
    for (const [key, fieldValue] of Object.entries(value)) {
      redactedObject[key] = SENSITIVE_FIELD_NAMES.has(normalizeFieldName(key))
        ? REDACTED
        : redact(fieldValue, seen);
    }
    result = redactedObject;
  }

  seen.delete(value);
  return result;
}

/** Returns a deep copy suitable for safe diagnostic logging. */
export function redactSensitiveData(value: unknown): unknown {
  return redact(value, new WeakSet<object>());
}
