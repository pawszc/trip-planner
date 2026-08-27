import { describe, expect, it } from 'vitest';
import {
  PROVIDER_FAILURE_CATEGORY_VALUES,
  PROVIDER_OPERATION_VALUES,
  ProviderExecutionError,
  providerFailureFromHttpMetadata,
  type ProviderExecutionErrorInput,
} from '../../srv/providers/provider-errors.js';

const BASE_INPUT = {
  providerKey: 'TRANSPORT_PRIMARY',
  operation: 'TRANSPORT_SEARCH',
  callSequence: 3,
  providerCallAttempted: true,
  latencyMs: 17,
} as const;

describe('provider execution errors', () => {
  it('keeps the failure and operation catalogs closed', () => {
    expect(PROVIDER_FAILURE_CATEGORY_VALUES).toStrictEqual([
      'CANCELLED',
      'TIMEOUT',
      'RATE_LIMITED',
      'UPSTREAM_4XX',
      'UPSTREAM_5XX',
      'NETWORK',
      'INVALID_SCHEMA',
      'PARTIAL_DESTINATION',
      'CALL_BUDGET_EXCEEDED',
      'INVALID_EXECUTION_POLICY',
    ]);
    expect(PROVIDER_OPERATION_VALUES).toStrictEqual([
      'TRANSPORT_SEARCH',
      'ACCOMMODATION_SEARCH',
      'PLACES_SEARCH',
    ]);
  });

  it.each([
    [undefined, 'NETWORK', null, true],
    [399, 'NETWORK', 399, true],
    [400, 'UPSTREAM_4XX', 400, false],
    [428, 'UPSTREAM_4XX', 428, false],
    [429, 'RATE_LIMITED', 429, true],
    [499, 'UPSTREAM_4XX', 499, false],
    [500, 'UPSTREAM_5XX', 500, true],
    [599, 'UPSTREAM_5XX', 599, true],
    [600, 'NETWORK', null, true],
  ] as const)(
    'maps HTTP status %s to %s without inspecting a raw error',
    (status, category, normalizedStatus, retryable) => {
      const error = providerFailureFromHttpMetadata({
        ...BASE_INPUT,
        ...(status === undefined ? {} : { status }),
        rateLimit: {
          retryAfterMs: 1_500,
          limit: 100,
          remaining: 0,
          resetAt: '2026-08-27T12:00:00.000Z',
        },
      });

      expect(error).toMatchObject({ category, retryable });
      expect(error.evidence.httpStatus).toBe(normalizedStatus);
      expect(error.evidence.rateLimit).toEqual(
        category === 'RATE_LIMITED'
          ? {
              retryAfterMs: 1_500,
              limit: 100,
              remaining: 0,
              resetAt: '2026-08-27T12:00:00.000Z',
            }
          : null,
      );
    },
  );

  it('normalizes unsafe numeric evidence without copying invalid values', () => {
    const error = new ProviderExecutionError({
      category: 'RATE_LIMITED',
      providerKey: '  TRANSPORT_PRIMARY  ',
      operation: 'TRANSPORT_SEARCH',
      callSequence: -1,
      providerCallAttempted: false,
      latencyMs: Number.POSITIVE_INFINITY,
      httpStatus: 999,
      destinationCode: '  WAW  ',
      rateLimit: {
        retryAfterMs: -10,
        limit: 2.5,
        remaining: Number.NaN,
        resetAt: '  2026-08-27T12:00:00.000Z  ',
      },
    });

    expect(error.evidence).toStrictEqual({
      providerKey: 'TRANSPORT_PRIMARY',
      operation: 'TRANSPORT_SEARCH',
      callSequence: 0,
      providerCallAttempted: false,
      attempts: 0,
      latencyMs: 0,
      httpStatus: null,
      destinationCode: 'WAW',
      underlyingCategory: null,
      rateLimit: {
        retryAfterMs: null,
        limit: null,
        remaining: null,
        resetAt: '2026-08-27T12:00:00.000Z',
      },
    });
  });

  it('rejects an impossible calendar date in rate-limit reset metadata', () => {
    const error = providerFailureFromHttpMetadata({
      ...BASE_INPUT,
      status: 429,
      rateLimit: { resetAt: '2026-02-30T12:00:00.000Z' },
    });

    expect(error.evidence.rateLimit).toMatchObject({ resetAt: null });
    expect(JSON.stringify(error.toSafeJSON())).not.toContain('2026-02-30');
  });

  it('serializes only the safe allowlist and never copies raw cause, response or headers', () => {
    const rawSentinels = [
      'RAW_PROVIDER_BODY_SENTINEL',
      'RAW_PROVIDER_MESSAGE_SENTINEL',
      'Authorization: Bearer SECRET_SENTINEL',
      'https://private.example.test/search?traveller=PRIVATE_SENTINEL',
    ];
    const inputWithForbiddenRuntimeFields = {
      ...BASE_INPUT,
      category: 'UPSTREAM_5XX',
      httpStatus: 503,
      cause: new Error(rawSentinels[0]),
      rawMessage: rawSentinels[1],
      headers: { authorization: rawSentinels[2] },
      response: { body: rawSentinels[3] },
    } as unknown as ProviderExecutionErrorInput;
    const error = new ProviderExecutionError(inputWithForbiddenRuntimeFields);
    const safe = error.toSafeJSON();
    const serialized = JSON.stringify(safe);

    expect(safe).toStrictEqual({
      name: 'ProviderExecutionError',
      category: 'UPSTREAM_5XX',
      message: 'Provider is temporarily unavailable.',
      retryable: true,
      evidence: {
        providerKey: 'TRANSPORT_PRIMARY',
        operation: 'TRANSPORT_SEARCH',
        callSequence: 3,
        providerCallAttempted: true,
        attempts: 1,
        latencyMs: 17,
        httpStatus: 503,
        destinationCode: null,
        underlyingCategory: null,
        rateLimit: null,
      },
    });
    expect(Object.keys(safe)).toStrictEqual([
      'name',
      'category',
      'message',
      'retryable',
      'evidence',
    ]);
    expect(serialized).not.toContain('cause');
    expect(serialized).not.toContain('headers');
    expect(serialized).not.toContain('response');
    expect(serialized).not.toContain('stack');
    for (const sentinel of rawSentinels) expect(serialized).not.toContain(sentinel);
  });

  it('does not let raw runtime text influence HTTP classification or the public message', () => {
    const withRawRuntimeFields = {
      ...BASE_INPUT,
      status: 429,
      cause: new Error('pretend status=500 SECRET_SENTINEL'),
      message: 'pretend authentication failure SECRET_SENTINEL',
      body: 'RAW_BODY_SENTINEL',
    } as unknown as Parameters<typeof providerFailureFromHttpMetadata>[0];
    const error = providerFailureFromHttpMetadata(withRawRuntimeFields);
    const serialized = JSON.stringify(error.toSafeJSON());

    expect(error).toMatchObject({
      category: 'RATE_LIMITED',
      message: 'Provider rate-limited the call.',
      retryable: true,
    });
    expect(serialized).not.toContain('SECRET_SENTINEL');
    expect(serialized).not.toContain('RAW_BODY_SENTINEL');
  });
});
