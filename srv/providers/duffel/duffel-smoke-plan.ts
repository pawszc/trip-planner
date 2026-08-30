import { z } from 'zod';
import { CURRENCY_CONTRACT_VERSION } from '../../domain/currency.ts';
import { SOURCE_SNAPSHOT_CONTRACT_VERSION } from '../../domain/money.ts';
import { OFFER_PRICING_CONTRACT_VERSION } from '../../domain/offer-pricing.ts';
import type { TransportSearchRequest } from '../contracts.ts';
import {
  PROVIDER_EXECUTION_POLICY_VERSION,
  resolveProviderExecutionPolicy,
  type ProviderExecutionPolicy,
} from '../provider-execution.ts';
import { createProviderFingerprint, type ProviderJsonValue } from '../provider-fingerprint.ts';
import {
  createProviderConfigurationManifest,
  providerEntry,
  providerManifestLineage,
  PROVIDER_MANIFEST_VERSION,
  type ProviderConfigurationManifest,
  type ProviderManifestEntry,
} from '../provider-manifest.ts';
import { parseStrictIsoDate } from '../../validation/strict-iso-date.ts';
import {
  DUFFEL_ADAPTER_ID,
  DUFFEL_ADAPTER_VERSION,
  DUFFEL_API_VERSION,
  DUFFEL_SEARCH_POLICY_VERSION,
  DUFFEL_SUPPLIER_TIMEOUT_MS,
  DUFFEL_TERMS_POLICY_VERSION,
  DUFFEL_UPSTREAM_SCHEMA_VERSION,
} from './duffel-contracts.ts';
import { createDuffelPlanningProviderManifest } from './duffel-profile.ts';
import {
  buildDuffelOfferRequestPlans,
  createDuffelSearchPolicyIdentity,
  DEFAULT_DUFFEL_ORIGIN_CATALOG,
  DUFFEL_DESTINATION_IATA_CATALOG_VERSION,
  DUFFEL_ORIGIN_CATALOG_VERSION,
} from './duffel-search-policy.ts';
import { DUFFEL_UPSTREAM_SCHEMA_FINGERPRINT } from './duffel-schemas.ts';

export const DUFFEL_SMOKE_PLAN_VERSION = 'duffel-smoke-plan-v1';
export const DUFFEL_SMOKE_SCENARIO_ID = 'duffel-smoke-wro-prg-return-v1';
export const DUFFEL_SMOKE_PRICING_BASIS_VERSION = 'duffel-test-mode-pricing-2026-08-30';
export const DUFFEL_SMOKE_CREDENTIAL_CHANNEL = 'DUFFEL_ACCESS_TOKEN';
export const DUFFEL_SMOKE_OPT_IN_VARIABLE = 'DUFFEL_SMOKE_ENABLED';
export const DUFFEL_SMOKE_APPROVAL_VARIABLE = 'DUFFEL_SMOKE_APPROVED_PLAN_FINGERPRINT';
export const DUFFEL_TEST_TOKEN_PREFIX = 'duffel_test_';

export const DUFFEL_SMOKE_EXECUTION_POLICY: ProviderExecutionPolicy =
  resolveProviderExecutionPolicy({
    timeoutMs: 10_000,
    maxCallsPerRun: 1,
    maxConcurrency: 1,
  });

const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/u)
  .refine((value) => parseStrictIsoDate(value) !== null);
const sha1Schema = z.string().regex(/^[0-9a-f]{40}$/u);
const fingerprintSchema = z.string().regex(/^[0-9a-f]{64}$/u);

const smokePlanInputSchema = z
  .object({
    sourceSha: sha1Schema,
    repositoryTreeState: z.enum(['CLEAN', 'DIRTY']),
    today: isoDateSchema,
    startDate: isoDateSchema,
    endDate: isoDateSchema,
  })
  .strict();

export const duffelSmokePlanSchema = z
  .object({
    planVersion: z.literal(DUFFEL_SMOKE_PLAN_VERSION),
    sourceSha: sha1Schema,
    repositoryTreeState: z.literal('CLEAN'),
    environment: z.literal('TEST'),
    scenario: z
      .object({
        scenarioId: z.literal(DUFFEL_SMOKE_SCENARIO_ID),
        originCity: z.literal('Wrocław'),
        originIata: z.literal('WRO'),
        destinationCity: z.literal('Prague'),
        destinationIata: z.literal('PRG'),
        destinationCountryCode: z.literal('CZ'),
        startDate: isoDateSchema,
        endDate: isoDateSchema,
        adults: z.literal(1),
        cabinClass: z.literal('economy'),
        currency: z.literal('PLN'),
      })
      .strict(),
    execution: z
      .object({
        operation: z.literal('CREATE_OFFER_REQUEST'),
        logicalSearches: z.literal(1),
        physicalOfferRequests: z.literal(1),
        timeoutMs: z.literal(10_000),
        supplierTimeoutMs: z.literal(DUFFEL_SUPPLIER_TIMEOUT_MS),
        maxCallsPerRun: z.literal(1),
        maxConcurrency: z.literal(1),
        maxAttemptsPerCall: z.literal(1),
        retryCount: z.literal(0),
        rateLimitStrategy: z.literal('FAIL_FAST'),
        fallbackStrategy: z.literal('NONE'),
        pagination: z.literal(false),
        polling: z.literal(false),
        offerRefresh: z.literal(false),
        order: z.literal(false),
        payment: z.literal(false),
        queryFingerprint: fingerprintSchema,
      })
      .strict(),
    versions: z
      .object({
        adapterId: z.literal(DUFFEL_ADAPTER_ID),
        adapterVersion: z.literal(DUFFEL_ADAPTER_VERSION),
        apiVersion: z.literal(DUFFEL_API_VERSION),
        upstreamSchemaVersion: z.literal(DUFFEL_UPSTREAM_SCHEMA_VERSION),
        upstreamSchemaFingerprint: z.literal(DUFFEL_UPSTREAM_SCHEMA_FINGERPRINT),
        termsPolicyVersion: z.literal(DUFFEL_TERMS_POLICY_VERSION),
        searchPolicyVersion: z.literal(DUFFEL_SEARCH_POLICY_VERSION),
        searchPolicyIdentity: z.string().regex(/^duffel-search-policy-v1:[0-9a-f]{64}$/u),
        originCatalogVersion: z.literal(DUFFEL_ORIGIN_CATALOG_VERSION),
        destinationCatalogVersion: z.literal(DUFFEL_DESTINATION_IATA_CATALOG_VERSION),
        sourceContractVersion: z.literal(SOURCE_SNAPSHOT_CONTRACT_VERSION),
        offerPricingContractVersion: z.literal(OFFER_PRICING_CONTRACT_VERSION),
        currencyContractVersion: z.literal(CURRENCY_CONTRACT_VERSION),
        manifestVersion: z.literal(PROVIDER_MANIFEST_VERSION),
        manifestFingerprint: fingerprintSchema,
        executionPolicyVersion: z.literal(PROVIDER_EXECUTION_POLICY_VERSION),
      })
      .strict(),
    authorization: z
      .object({
        separateApprovalRequired: z.literal(true),
        optInVariable: z.literal(DUFFEL_SMOKE_OPT_IN_VARIABLE),
        approvalVariable: z.literal(DUFFEL_SMOKE_APPROVAL_VARIABLE),
        credentialChannel: z.literal(DUFFEL_SMOKE_CREDENTIAL_CHANNEL),
        requiredTokenPrefix: z.literal(DUFFEL_TEST_TOKEN_PREFIX),
        credentialReadsDuringPreflight: z.literal(0),
      })
      .strict(),
    cost: z
      .object({
        pricingBasisVersion: z.literal(DUFFEL_SMOKE_PRICING_BASIS_VERSION),
        plannedMaximumCostUsdMicros: z.literal(0),
        actualExternalCostUsdMicrosDuringPreflight: z.literal(0),
      })
      .strict(),
  })
  .strict();

export type DuffelSmokePlan = z.infer<typeof duffelSmokePlanSchema>;

export interface PreparedDuffelSmokePlan {
  readonly plan: DuffelSmokePlan;
  readonly planFingerprint: string;
}

export const DUFFEL_SMOKE_PLAN_ERROR_CODES = [
  'INVALID_PLAN_INPUT',
  'DIRTY_REPOSITORY',
  'INVALID_FUTURE_DATES',
  'RUNTIME_IDENTITY_MISMATCH',
] as const;
export type DuffelSmokePlanErrorCode = (typeof DUFFEL_SMOKE_PLAN_ERROR_CODES)[number];

export class DuffelSmokePlanError extends Error {
  public readonly code: DuffelSmokePlanErrorCode;

  constructor(code: DuffelSmokePlanErrorCode) {
    super('Duffel smoke plan failed safe validation.');
    this.name = 'DuffelSmokePlanError';
    this.code = code;
  }
}

export interface BuildDuffelSmokePlanInput {
  readonly sourceSha: string;
  readonly repositoryTreeState: 'CLEAN' | 'DIRTY';
  readonly today: string;
  readonly startDate: string;
  readonly endDate: string;
}

export interface DuffelSmokeRuntimeIdentity {
  readonly manifest: ProviderConfigurationManifest;
  readonly transportEntry: ProviderManifestEntry;
  readonly request: TransportSearchRequest;
  readonly queryFingerprint: string;
  readonly manifestFingerprint: string;
}

function smokeRequest(startDate: string, endDate: string): TransportSearchRequest {
  return Object.freeze({
    originCity: 'Wrocław',
    destinations: Object.freeze([
      Object.freeze({ code: 'PRG', city: 'Prague', countryCode: 'CZ' }),
    ]),
    startDate,
    endDate,
    adults: 1,
    currency: 'PLN',
  });
}

export function createDuffelSmokeRuntimeIdentity(
  startDate: string,
  endDate: string,
): DuffelSmokeRuntimeIdentity {
  const request = smokeRequest(startDate, endDate);
  const requestPlans = buildDuffelOfferRequestPlans(request, DEFAULT_DUFFEL_ORIGIN_CATALOG);
  if (requestPlans.length !== 1 || requestPlans[0]?.destination.code !== 'PRG') {
    throw new DuffelSmokePlanError('RUNTIME_IDENTITY_MISMATCH');
  }
  const defaultManifest = createDuffelPlanningProviderManifest(
    'TEST',
    DEFAULT_DUFFEL_ORIGIN_CATALOG,
  );
  const manifest = createProviderConfigurationManifest(
    defaultManifest.entries,
    DUFFEL_SMOKE_EXECUTION_POLICY,
  );
  const lineage = providerManifestLineage(manifest);
  return Object.freeze({
    manifest,
    transportEntry: providerEntry(manifest, 'TRANSPORT'),
    request,
    queryFingerprint: requestPlans[0].queryFingerprint,
    manifestFingerprint: lineage.manifestFingerprint,
  });
}

function assertFutureDates(today: string, startDate: string, endDate: string): void {
  if (startDate <= today || endDate <= startDate) {
    throw new DuffelSmokePlanError('INVALID_FUTURE_DATES');
  }
}

export function buildDuffelSmokePlan(input: BuildDuffelSmokePlanInput): PreparedDuffelSmokePlan {
  const parsed = smokePlanInputSchema.safeParse(input);
  if (!parsed.success) throw new DuffelSmokePlanError('INVALID_PLAN_INPUT');
  if (parsed.data.repositoryTreeState !== 'CLEAN') {
    throw new DuffelSmokePlanError('DIRTY_REPOSITORY');
  }
  assertFutureDates(parsed.data.today, parsed.data.startDate, parsed.data.endDate);

  const runtime = createDuffelSmokeRuntimeIdentity(parsed.data.startDate, parsed.data.endDate);
  const plan = duffelSmokePlanSchema.parse({
    planVersion: DUFFEL_SMOKE_PLAN_VERSION,
    sourceSha: parsed.data.sourceSha,
    repositoryTreeState: 'CLEAN',
    environment: 'TEST',
    scenario: {
      scenarioId: DUFFEL_SMOKE_SCENARIO_ID,
      originCity: 'Wrocław',
      originIata: 'WRO',
      destinationCity: 'Prague',
      destinationIata: 'PRG',
      destinationCountryCode: 'CZ',
      startDate: parsed.data.startDate,
      endDate: parsed.data.endDate,
      adults: 1,
      cabinClass: 'economy',
      currency: 'PLN',
    },
    execution: {
      operation: 'CREATE_OFFER_REQUEST',
      logicalSearches: 1,
      physicalOfferRequests: 1,
      timeoutMs: DUFFEL_SMOKE_EXECUTION_POLICY.timeoutMs,
      supplierTimeoutMs: DUFFEL_SUPPLIER_TIMEOUT_MS,
      maxCallsPerRun: DUFFEL_SMOKE_EXECUTION_POLICY.maxCallsPerRun,
      maxConcurrency: DUFFEL_SMOKE_EXECUTION_POLICY.maxConcurrency,
      maxAttemptsPerCall: DUFFEL_SMOKE_EXECUTION_POLICY.maxAttemptsPerCall,
      retryCount: 0,
      rateLimitStrategy: DUFFEL_SMOKE_EXECUTION_POLICY.rateLimitStrategy,
      fallbackStrategy: DUFFEL_SMOKE_EXECUTION_POLICY.fallbackStrategy,
      pagination: false,
      polling: false,
      offerRefresh: false,
      order: false,
      payment: false,
      queryFingerprint: runtime.queryFingerprint,
    },
    versions: {
      adapterId: DUFFEL_ADAPTER_ID,
      adapterVersion: DUFFEL_ADAPTER_VERSION,
      apiVersion: DUFFEL_API_VERSION,
      upstreamSchemaVersion: DUFFEL_UPSTREAM_SCHEMA_VERSION,
      upstreamSchemaFingerprint: DUFFEL_UPSTREAM_SCHEMA_FINGERPRINT,
      termsPolicyVersion: DUFFEL_TERMS_POLICY_VERSION,
      searchPolicyVersion: DUFFEL_SEARCH_POLICY_VERSION,
      searchPolicyIdentity: createDuffelSearchPolicyIdentity(DEFAULT_DUFFEL_ORIGIN_CATALOG),
      originCatalogVersion: DUFFEL_ORIGIN_CATALOG_VERSION,
      destinationCatalogVersion: DUFFEL_DESTINATION_IATA_CATALOG_VERSION,
      sourceContractVersion: SOURCE_SNAPSHOT_CONTRACT_VERSION,
      offerPricingContractVersion: OFFER_PRICING_CONTRACT_VERSION,
      currencyContractVersion: CURRENCY_CONTRACT_VERSION,
      manifestVersion: PROVIDER_MANIFEST_VERSION,
      manifestFingerprint: runtime.manifestFingerprint,
      executionPolicyVersion: PROVIDER_EXECUTION_POLICY_VERSION,
    },
    authorization: {
      separateApprovalRequired: true,
      optInVariable: DUFFEL_SMOKE_OPT_IN_VARIABLE,
      approvalVariable: DUFFEL_SMOKE_APPROVAL_VARIABLE,
      credentialChannel: DUFFEL_SMOKE_CREDENTIAL_CHANNEL,
      requiredTokenPrefix: DUFFEL_TEST_TOKEN_PREFIX,
      credentialReadsDuringPreflight: 0,
    },
    cost: {
      pricingBasisVersion: DUFFEL_SMOKE_PRICING_BASIS_VERSION,
      plannedMaximumCostUsdMicros: 0,
      actualExternalCostUsdMicrosDuringPreflight: 0,
    },
  });
  return Object.freeze({
    plan: Object.freeze(plan),
    planFingerprint: createProviderFingerprint(plan as unknown as ProviderJsonValue),
  });
}

export function validatePreparedDuffelSmokePlan(
  input: PreparedDuffelSmokePlan,
): PreparedDuffelSmokePlan {
  const parsed = duffelSmokePlanSchema.safeParse(input.plan);
  if (!parsed.success) throw new DuffelSmokePlanError('RUNTIME_IDENTITY_MISMATCH');
  const actualFingerprint = createProviderFingerprint(parsed.data as unknown as ProviderJsonValue);
  if (actualFingerprint !== input.planFingerprint) {
    throw new DuffelSmokePlanError('RUNTIME_IDENTITY_MISMATCH');
  }
  const runtime = createDuffelSmokeRuntimeIdentity(
    parsed.data.scenario.startDate,
    parsed.data.scenario.endDate,
  );
  if (
    runtime.queryFingerprint !== parsed.data.execution.queryFingerprint ||
    runtime.manifestFingerprint !== parsed.data.versions.manifestFingerprint ||
    runtime.transportEntry.searchPolicyVersion !== parsed.data.versions.searchPolicyIdentity
  ) {
    throw new DuffelSmokePlanError('RUNTIME_IDENTITY_MISMATCH');
  }
  return Object.freeze({ plan: Object.freeze(parsed.data), planFingerprint: actualFingerprint });
}
