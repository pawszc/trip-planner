import { z } from 'zod';
import { DUFFEL_ADAPTER_VERSION, DUFFEL_UPSTREAM_SCHEMA_VERSION } from './duffel-contracts.ts';
import { DUFFEL_SMOKE_PLAN_VERSION } from './duffel-smoke-plan.ts';
import { PROVIDER_EXECUTION_POLICY_VERSION } from '../provider-execution.ts';
import { PROVIDER_MANIFEST_VERSION } from '../provider-manifest.ts';

export const DUFFEL_SMOKE_EVIDENCE_VERSION = 'duffel-smoke-evidence-v1';

export const DUFFEL_SMOKE_STATUS_VALUES = ['PASS', 'NO_USABLE_OFFER', 'BLOCKED', 'FAILED'] as const;

export const DUFFEL_SMOKE_FAILURE_CATEGORY_VALUES = [
  'OPT_IN_REQUIRED',
  'PLAN_NOT_APPROVED',
  'CREDENTIAL_UNAVAILABLE',
  'CREDENTIAL_NOT_TEST_MODE',
  'NO_USABLE_OFFER',
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
  'AUDIT_CONTRACT_VIOLATION',
  'UNEXPECTED_SAFE_FAILURE',
] as const;

const nonNegativeSafeInteger = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const fingerprint = z.string().regex(/^[0-9a-f]{64}$/u);

export const duffelSmokeEvidenceSchema = z
  .object({
    evidenceVersion: z.literal(DUFFEL_SMOKE_EVIDENCE_VERSION),
    status: z.enum(DUFFEL_SMOKE_STATUS_VALUES),
    failureCategory: z.enum(DUFFEL_SMOKE_FAILURE_CATEGORY_VALUES).nullable(),
    environment: z.literal('TEST'),
    sourceSha: z.string().regex(/^[0-9a-f]{40}$/u),
    planVersion: z.literal(DUFFEL_SMOKE_PLAN_VERSION),
    planFingerprint: fingerprint,
    queryFingerprint: fingerprint,
    adapterVersion: z.literal(DUFFEL_ADAPTER_VERSION),
    upstreamSchemaVersion: z.literal(DUFFEL_UPSTREAM_SCHEMA_VERSION),
    manifestVersion: z.literal(PROVIDER_MANIFEST_VERSION),
    manifestFingerprint: fingerprint,
    executionPolicyVersion: z.literal(PROVIDER_EXECUTION_POLICY_VERSION),
    startedAt: z.string().datetime({ offset: true }),
    completedAt: z.string().datetime({ offset: true }),
    requestCount: z.number().int().min(0).max(1),
    attemptCount: z.number().int().min(0).max(1),
    credentialAccessed: z.boolean(),
    latencyMs: nonNegativeSafeInteger,
    httpStatus: z.number().int().min(100).max(599).nullable(),
    resultCount: nonNegativeSafeInteger.nullable(),
    resultFingerprint: fingerprint.nullable(),
    actualExternalCostUsdMicros: z.literal(0),
  })
  .strict()
  .superRefine((evidence, context) => {
    if (evidence.status === 'PASS' && (evidence.resultCount ?? 0) < 1) {
      context.addIssue({
        code: 'custom',
        path: ['resultCount'],
        message: 'PASS requires at least one locally mapped offer.',
      });
    }
    if (
      evidence.requestCount !== evidence.attemptCount ||
      evidence.requestCount > 1 ||
      evidence.attemptCount > 1
    ) {
      context.addIssue({
        code: 'custom',
        path: ['requestCount'],
        message: 'Smoke evidence must prove at most one request and one attempt.',
      });
    }
    if (evidence.status === 'PASS' && evidence.failureCategory !== null) {
      context.addIssue({
        code: 'custom',
        path: ['failureCategory'],
        message: 'PASS cannot carry a failure category.',
      });
    }
    if (evidence.status !== 'PASS' && evidence.failureCategory === null) {
      context.addIssue({
        code: 'custom',
        path: ['failureCategory'],
        message: 'A non-pass smoke result requires a closed failure category.',
      });
    }
  });

export type DuffelSmokeEvidence = z.infer<typeof duffelSmokeEvidenceSchema>;
export type DuffelSmokeFailureCategory = z.infer<
  typeof duffelSmokeEvidenceSchema
>['failureCategory'];

export function createDuffelSmokeEvidence(input: DuffelSmokeEvidence): DuffelSmokeEvidence {
  return Object.freeze(duffelSmokeEvidenceSchema.parse(input));
}
