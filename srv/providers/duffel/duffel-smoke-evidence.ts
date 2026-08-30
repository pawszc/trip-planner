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
const blockedFailureCategories = new Set<string>([
  'OPT_IN_REQUIRED',
  'PLAN_NOT_APPROVED',
  'CREDENTIAL_UNAVAILABLE',
  'CREDENTIAL_NOT_TEST_MODE',
]);
const executionFailureCategories = new Set<string>([
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
]);

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
    const exactSingleAttempt = evidence.requestCount === 1 && evidence.attemptCount === 1;
    const noAttempt = evidence.requestCount === 0 && evidence.attemptCount === 0;
    const addIssue = (path: string, message: string): void => {
      context.addIssue({
        code: 'custom',
        path: [path],
        message,
      });
    };

    if (Date.parse(evidence.completedAt) < Date.parse(evidence.startedAt)) {
      addIssue('completedAt', 'Smoke completion cannot precede its start.');
    }

    if (evidence.requestCount !== evidence.attemptCount) {
      addIssue('requestCount', 'Smoke request and attempt counts must match.');
    }

    if (evidence.status === 'PASS') {
      if (!exactSingleAttempt) {
        addIssue('requestCount', 'PASS requires exactly one request and one attempt.');
      }
      if (!evidence.credentialAccessed) {
        addIssue('credentialAccessed', 'PASS requires credential access.');
      }
      if ((evidence.resultCount ?? 0) < 1) {
        addIssue('resultCount', 'PASS requires at least one locally mapped offer.');
      }
      if (evidence.resultFingerprint === null) {
        addIssue('resultFingerprint', 'PASS requires a mapped result fingerprint.');
      }
      if (evidence.failureCategory !== null) {
        addIssue('failureCategory', 'PASS cannot carry a failure category.');
      }
      return;
    }

    if (evidence.status === 'NO_USABLE_OFFER') {
      if (!exactSingleAttempt) {
        addIssue('requestCount', 'NO_USABLE_OFFER requires exactly one request and one attempt.');
      }
      if (!evidence.credentialAccessed) {
        addIssue('credentialAccessed', 'NO_USABLE_OFFER requires credential access.');
      }
      if (evidence.failureCategory !== 'NO_USABLE_OFFER') {
        addIssue('failureCategory', 'NO_USABLE_OFFER requires its matching failure category.');
      }
      if (evidence.resultCount !== 0 || evidence.resultFingerprint === null) {
        addIssue('resultCount', 'NO_USABLE_OFFER requires a fingerprinted empty mapped result.');
      }
      return;
    }

    if (evidence.status === 'BLOCKED') {
      if (!noAttempt) {
        addIssue('requestCount', 'BLOCKED requires zero requests and attempts.');
      }
      if (
        evidence.failureCategory === null ||
        !blockedFailureCategories.has(evidence.failureCategory)
      ) {
        addIssue('failureCategory', 'BLOCKED requires a pre-request failure category.');
      }
      const accessExpected =
        evidence.failureCategory === 'CREDENTIAL_UNAVAILABLE' ||
        evidence.failureCategory === 'CREDENTIAL_NOT_TEST_MODE';
      if (evidence.credentialAccessed !== accessExpected) {
        addIssue(
          'credentialAccessed',
          'BLOCKED credential access must match its failure category.',
        );
      }
      if (
        evidence.httpStatus !== null ||
        evidence.resultCount !== null ||
        evidence.resultFingerprint !== null ||
        evidence.latencyMs !== 0
      ) {
        addIssue('resultCount', 'BLOCKED cannot carry provider execution evidence.');
      }
      return;
    }

    if (
      evidence.failureCategory === null ||
      !executionFailureCategories.has(evidence.failureCategory)
    ) {
      addIssue('failureCategory', 'FAILED requires an execution failure category.');
    }
    if (!evidence.credentialAccessed) {
      addIssue('credentialAccessed', 'FAILED requires credential access.');
    }
    if (evidence.resultCount !== null || evidence.resultFingerprint !== null) {
      addIssue('resultCount', 'FAILED cannot carry a successful mapped result.');
    }
    if (noAttempt && (evidence.httpStatus !== null || evidence.latencyMs !== 0)) {
      addIssue('httpStatus', 'A pre-request FAILED result cannot carry call metadata.');
    }
  });

export type DuffelSmokeEvidence = z.infer<typeof duffelSmokeEvidenceSchema>;
export type DuffelSmokeFailureCategory = z.infer<
  typeof duffelSmokeEvidenceSchema
>['failureCategory'];

export function createDuffelSmokeEvidence(input: DuffelSmokeEvidence): DuffelSmokeEvidence {
  return Object.freeze(duffelSmokeEvidenceSchema.parse(input));
}
