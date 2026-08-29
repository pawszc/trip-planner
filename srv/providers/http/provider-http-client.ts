export const DUFFEL_API_BASE_URL = 'https://api.duffel.com';
export const DUFFEL_MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

export type ProviderHttpTransport = (input: string | URL, init: RequestInit) => Promise<Response>;

export type ProviderToken = () => string | Promise<string>;

export type ProviderHttpClientFailureKind = 'HTTP_STATUS' | 'INVALID_JSON' | 'NETWORK';

/** Safe transport error: it has no raw body, request, headers, token, cause or upstream text. */
export class ProviderHttpClientError extends Error {
  public readonly kind: ProviderHttpClientFailureKind;
  public readonly status: number | null;
  public readonly retryAfterMs: number | null;

  constructor(input: {
    kind: ProviderHttpClientFailureKind;
    status?: number | null;
    retryAfterMs?: number | null;
  }) {
    super('Provider HTTP request failed safely.');
    this.name = 'ProviderHttpClientError';
    this.kind = input.kind;
    this.status = input.status ?? null;
    this.retryAfterMs = input.retryAfterMs ?? null;
  }
}

export interface ProviderHttpClientOptions {
  readonly baseUrl: typeof DUFFEL_API_BASE_URL;
  readonly token: ProviderToken;
  readonly transport?: ProviderHttpTransport;
  readonly now?: () => Date;
}

function safeRetryAfterMs(value: string | null, now: Date): number | null {
  if (value === null) return null;
  if (/^\d{1,9}$/.test(value)) {
    const milliseconds = Number(value) * 1_000;
    return Number.isSafeInteger(milliseconds) ? milliseconds : null;
  }
  const resetAt = Date.parse(value);
  const current = now.getTime();
  if (!Number.isFinite(resetAt) || !Number.isFinite(current)) return null;
  return Math.max(0, Math.floor(resetAt - current));
}

function safeToken(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 500 &&
    ![...value].some((character) => (character.codePointAt(0) ?? 0) <= 32)
  );
}

function declaredResponseLength(response: Response): number | null {
  const value = response.headers.get('content-length');
  if (value === null || !/^\d{1,12}$/.test(value)) return null;
  const length = Number(value);
  return Number.isSafeInteger(length) ? length : null;
}

function cancelResponseBodySafely(response: Response): void {
  if (response.body === null) return;
  try {
    void response.body.cancel().catch(() => undefined);
  } catch {
    // A custom or already-locked stream can fail synchronously. The HTTP error remains authoritative.
  }
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declaredLength = declaredResponseLength(response);
  if (declaredLength !== null && declaredLength > DUFFEL_MAX_RESPONSE_BYTES) {
    cancelResponseBodySafely(response);
    throw new ProviderHttpClientError({ kind: 'INVALID_JSON' });
  }
  if (response.body === null) {
    throw new ProviderHttpClientError({ kind: 'INVALID_JSON' });
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      receivedBytes += chunk.value.byteLength;
      if (receivedBytes > DUFFEL_MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new ProviderHttpClientError({ kind: 'INVALID_JSON' });
      }
      chunks.push(chunk.value);
    }

    const bytes = new Uint8Array(receivedBytes);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } catch (error) {
    if (error instanceof ProviderHttpClientError) throw error;
    throw new ProviderHttpClientError({ kind: 'INVALID_JSON' });
  }
}

export class ProviderHttpClient {
  private readonly token: ProviderToken;
  private readonly transport: ProviderHttpTransport;
  private readonly now: () => Date;

  constructor(options: ProviderHttpClientOptions) {
    if (options.baseUrl !== DUFFEL_API_BASE_URL) {
      throw new TypeError('Provider HTTP base URL is not allowlisted.');
    }
    this.token = options.token;
    this.transport = options.transport ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  public async postJson(path: string, body: unknown, signal: AbortSignal): Promise<unknown> {
    if (
      !/^\/air\/offer_requests\?return_offers=true&supplier_timeout=\d+&view=offers$/.test(path)
    ) {
      throw new TypeError('Provider HTTP path is not allowlisted.');
    }
    let token: unknown;
    try {
      token = await this.token();
    } catch {
      throw new ProviderHttpClientError({ kind: 'NETWORK' });
    }
    if (!safeToken(token)) throw new ProviderHttpClientError({ kind: 'NETWORK' });

    let response: Response;
    try {
      response = await this.transport(`${DUFFEL_API_BASE_URL}${path}`, {
        method: 'POST',
        redirect: 'error',
        signal,
        headers: {
          Accept: 'application/json',
          'Accept-Encoding': 'gzip',
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Duffel-Version': 'v2',
        },
        body: JSON.stringify(body),
      });
    } catch {
      throw new ProviderHttpClientError({ kind: 'NETWORK' });
    }
    if (!response.ok) {
      const retryAfterMs =
        response.status === 429
          ? safeRetryAfterMs(response.headers.get('retry-after'), this.now())
          : null;
      cancelResponseBodySafely(response);
      throw new ProviderHttpClientError({
        kind: 'HTTP_STATUS',
        status: response.status,
        retryAfterMs,
      });
    }
    return readBoundedJson(response);
  }
}
