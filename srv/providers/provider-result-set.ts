import type { ProviderCallAuditEvent } from './provider-execution.ts';
import { createProviderFingerprint, isSha256Fingerprint } from './provider-fingerprint.ts';

export const PROVIDER_RESULT_SET_VERSION = 'provider-result-set-v1';

export type ProviderResultSetCall = Pick<
  ProviderCallAuditEvent,
  | 'policyVersion'
  | 'providerKey'
  | 'operation'
  | 'destinationCode'
  | 'status'
  | 'providerCallAttempted'
  | 'queryFingerprint'
  | 'resultFingerprint'
  | 'resultCount'
>;

/**
 * Stable run-level commitment to every successful normalized provider result. Runtime-only
 * sequence and latency are deliberately excluded, while every physical call identity is bound.
 */
export function createProviderResultSetFingerprint(
  calls: readonly ProviderResultSetCall[],
): string {
  if (calls.length === 0) throw new TypeError('Provider result set cannot be empty.');

  const seen = new Set<string>();
  const canonicalCalls = calls.map((call) => {
    if (
      call.status !== 'SUCCEEDED' ||
      !call.providerCallAttempted ||
      !isSha256Fingerprint(call.queryFingerprint) ||
      !isSha256Fingerprint(call.resultFingerprint) ||
      !Number.isSafeInteger(call.resultCount) ||
      call.resultCount === null ||
      call.resultCount < 0
    ) {
      throw new TypeError('Provider result set contains a non-successful or invalid call.');
    }
    const canonical = {
      policyVersion: call.policyVersion,
      providerKey: call.providerKey,
      operation: call.operation,
      destinationCode: call.destinationCode,
      queryFingerprint: call.queryFingerprint,
      resultFingerprint: call.resultFingerprint,
      resultCount: call.resultCount,
    };
    const identity = createProviderFingerprint(canonical);
    if (seen.has(identity)) throw new TypeError('Provider result set contains a duplicate call.');
    seen.add(identity);
    return { identity, call: canonical };
  });

  canonicalCalls.sort((left, right) => left.identity.localeCompare(right.identity, 'en'));
  return createProviderFingerprint({
    version: PROVIDER_RESULT_SET_VERSION,
    calls: canonicalCalls.map((entry) => entry.call),
  });
}
