import { randomUUID } from 'node:crypto';
import cds from '@sap/cds';
import type { Request } from '@sap/cds';
import type { AiGateway } from './ai/ai-gateway.ts';
import { loadAiConfig } from './ai/config.ts';
import { createPersistentAiGateway } from './ai/create-persistent-ai-gateway.ts';
import { createInputFingerprint, isValidAiRunId } from './ai/contracts.ts';
import { AI_ERROR_CODE_VALUES, AiError, type AiErrorCode } from './ai/errors.ts';
import { CURRENCY_CONTRACT_VERSION } from './domain/currency.ts';
import type { SourceSnapshot } from './domain/money.ts';
import {
  CONDITIONAL_CHARGE_PAYABLE_AT_VALUES,
  OFFER_PRICING_CONTRACT_VERSION,
} from './domain/offer-pricing.ts';
import { confirmTripRequestStatus, DomainError } from './domain/trip-request.ts';
import { transitionWorkflowState } from './domain/workflow-run.ts';
import {
  materializeProfiles,
  mergeTripRequest,
  normalizeTripRequest,
  type MutableTripRequest,
  type PersistedTripRequest,
} from './mapping/trip-request-mapper.ts';
import {
  runCandidateEngine,
  type CandidateEngineProviders,
} from './orchestration/candidate-engine.ts';
import {
  createLegacyPlanningFingerprintV0,
  createLegacyPlanningFingerprintV1,
  createPlanningContext,
  createPlanningFingerprint,
  LEGACY_PLANNING_RUN_V1_LINEAGE,
  LEGACY_PLANNING_RUN_V0_LINEAGE,
  PLANNING_REQUEST_FINGERPRINT_VERSION,
} from './orchestration/planning-request.ts';
import {
  assertProviderExecutionAudit,
  buildPlanningPersistenceBundle,
} from './persistence/planning-result-records.ts';
import { CapNarrativeQualityReader } from './narratives/cap-narrative-quality-reader.ts';
import { CapNarrativeReviewStore } from './narratives/cap-narrative-review-store.ts';
import { CapNarrativeReviewWriter } from './narratives/cap-narrative-review-writer.ts';
import { NARRATIVE_FINALIZATION_VERSION } from './narratives/narrative-finalization.ts';
import {
  buildNarrativeGenerationView,
  NARRATIVE_GENERATION_VIEW_VERSION,
} from './narratives/narrative-generation-view.ts';
import {
  createNarrativeJudgeRequest,
  parseNarrativeJudgeOutput,
  type NarrativeJudgeOutput,
} from './narratives/narrative-judge.ts';
import {
  buildNarrativeModelView,
  NARRATIVE_MODEL_VIEW_VERSION,
} from './narratives/narrative-model-view.ts';
import { buildNarrativePersistenceBundle } from './narratives/narrative-persistence.ts';
import { decideNarrativePublication } from './narratives/narrative-publication-policy.ts';
import {
  NARRATIVE_JUDGE_REASON_DIMENSIONS,
  type NarrativeJudgeDimension,
  type NarrativeJudgeReasonCode,
} from './narratives/narrative-quality-rubric.ts';
import {
  buildNarrativeQualityContext,
  createNarrativeFingerprint,
  NARRATIVE_CONSTRAINT_SNAPSHOT_VERSION,
  NARRATIVE_QUALITY_CONTEXT_VERSION,
  type NarrativeQualityContractVersions,
} from './narratives/narrative-quality-context.ts';
import {
  NARRATIVE_JUDGE_PROMPT_VERSION,
  NARRATIVE_JUDGE_SCHEMA_VERSION,
  NARRATIVE_MODEL_PROFILE_VERSION,
  NARRATIVE_PRICE_CATALOG_VERSION,
  NARRATIVE_PUBLICATION_POLICY_VERSION,
  NARRATIVE_QUALITY_DATASET_VERSION,
  NARRATIVE_QUALITY_RUBRIC_VERSION,
  NARRATIVE_SAFETY_PRECHECK_VERSION,
} from './narratives/narrative-quality-versions.ts';
import {
  buildNarrativeReviewPublicationBundle,
  buildNarrativeReviewRejectionBundle,
  NARRATIVE_REVIEW_FAILURE_CODE_VALUES,
  type NarrativeReviewAiRunExpectation,
  type NarrativeReviewDimensionResults,
  type NarrativeReviewFailureCode,
  type NarrativeReviewPersistenceVersions,
} from './narratives/narrative-review-persistence.ts';
import { runNarrativeSafetyPrecheck } from './narratives/narrative-safety-precheck.ts';
import {
  createOptionNarrativeRequest,
  OPTION_NARRATIVE_PROMPT_VERSION,
  OPTION_NARRATIVE_SCHEMA_VERSION,
  parseOptionNarrativeOutput,
} from './narratives/option-narrative.ts';
import { REFERENCE_DESTINATIONS } from './providers/fixtures/europe-reference-fixtures.ts';
import { MOCK_FIXTURE_VERSION, MOCK_PROVIDER_NAMES } from './providers/fixtures/fixture-source.ts';
import { MockAccommodationProvider } from './providers/mock-accommodation-provider.ts';
import { MockPlacesProvider } from './providers/mock-places-provider.ts';
import { MockTransportProvider } from './providers/mock-transport-provider.ts';
import type { ProviderCallAuditEvent } from './providers/provider-execution.ts';
import {
  isLegacyFixtureCompatibleManifest,
  MOCK_PROVIDER_MANIFEST,
  providerManifestLineage,
  type ProviderConfigurationManifest,
} from './providers/provider-manifest.ts';
import { canonicalSourceSnapshot, isCompleteSourceSnapshot } from './providers/source-snapshot.ts';
import { SCORE_VERSION } from './ranking/candidate-scoring.ts';
import { INTERNAL_COST_FIXTURE_VERSION } from './ranking/budget.ts';
import { DEFAULT_CANDIDATE_ENGINE_CONFIG } from './ranking/config.ts';
import { validateTripRequest } from './validation/trip-request-validation.ts';

interface PersistedWorkflowRun {
  ID: string;
  tripRequest_ID: string;
  state: string;
  errorCode: string | null;
  errorMessage: string | null;
}

interface PersistedPlanningRun {
  ID: string;
  tripRequest_ID: string;
  workflowRun_ID: string;
  requestFingerprint: string;
  requestFingerprintVersion: string | null;
  status: 'SUCCEEDED' | 'INSUFFICIENT_OPTIONS';
  currencyContractVersion: string | null;
  offerPricingContractVersion: string | null;
  providerFixtureVersion: string | null;
  providerManifestVersion: string | null;
  providerManifestFingerprint: string | null;
  providerManifestJson: string | null;
  engineVersion: string;
  scoringVersion: string;
  rejectedCandidateCount: number;
  selectedOptionCount: number;
  providerExecutionCallCount: number | null;
  errorCode: string | null;
  errorMessage: string | null;
}

interface PersistedRankedOptionLineage {
  ID: string;
  tripRequest_ID: string;
  workflowRun_ID: string;
  planningRun_ID: string;
  providerFixtureVersion: string | null;
  providerManifestVersion: string | null;
  providerManifestFingerprint: string | null;
  offerPricingContractVersion: string | null;
  scoringVersion: string;
  transportMandatoryTotalMinor: number | string | null;
  transportMandatoryTotalPriceType: string | null;
  transportMandatoryTotalClassification: string | null;
  transportMandatoryTotalSourceKey: string | null;
  accommodationMandatoryTotalMinor: number | string | null;
  accommodationMandatoryTotalPriceType: string | null;
  accommodationMandatoryTotalClassification: string | null;
  accommodationMandatoryTotalSourceKey: string | null;
}

interface PersistedReplayAssociationLineage {
  ID: string;
  tripRequest_ID: string;
  workflowRun_ID: string;
  planningRun_ID: string;
}

interface PersistedReplayManifestLineage extends PersistedReplayAssociationLineage {
  providerFixtureVersion: string | null;
  providerManifestVersion: string | null;
  providerManifestFingerprint: string | null;
  scoringVersion: string;
}

interface PersistedSourceSnapshotReplayLineage extends PersistedReplayManifestLineage {
  sourceKey: string;
  sourceContractVersion: string | null;
  sourceType: string | null;
  provider: string;
  adapterVersion: string | null;
  providerVersion: string | null;
  upstreamApiVersion: string | null;
  upstreamSchemaFingerprint: string | null;
  queryFingerprint: string | null;
  resultFingerprint: string | null;
  externalItemId: string;
  fetchedAt: string;
  expiresAt: string | null;
  sourceUrl: string | null;
  attribution: string | null;
  freshnessType: string;
  currency: string | null;
  fixtureVersion: string | null;
  termsPolicyVersion: string | null;
  contexts: string;
  demonstrationData: boolean;
  rankedOption_ID: string;
}

interface PersistedBudgetItemReplayLineage extends PersistedReplayManifestLineage {
  rankedOption_ID: string;
  sourceSnapshot_ID: string | null;
  category: string;
}

interface PersistedOfferChargeCollectionReplayLineage extends PersistedReplayManifestLineage {
  rankedOption_ID: string;
  offerPricingContractVersion: string;
  scope: string;
  kind: string;
  itemCount: number;
}

interface PersistedOfferChargeDisclosureReplayLineage extends PersistedReplayAssociationLineage {
  rankedOption_ID: string;
  collection_ID: string;
  sourceSnapshot_ID: string | null;
  offerPricingContractVersion: string;
  chargeId: string;
  code: string;
  label: string;
  condition: string | null;
  payableAt: string | null;
  mandatoryWhenConditionMet: boolean | null;
  includedInBudget: boolean;
}

interface PersistedProviderExecutionReplayLineage extends PersistedReplayAssociationLineage {
  providerManifestVersion: string;
  providerManifestFingerprint: string;
  policyVersion: string;
  providerKey: string;
  operation: ProviderCallAuditEvent['operation'];
  destinationCode: string | null;
  sequence: number;
  status: ProviderCallAuditEvent['status'];
  providerCallAttempted: boolean;
  attempts: ProviderCallAuditEvent['attempts'];
  latencyMs: number;
  queryFingerprint: string;
  resultFingerprint: string | null;
  resultCount: number | null;
  failureCategory: ProviderCallAuditEvent['failureCategory'];
  underlyingFailureCategory: ProviderCallAuditEvent['underlyingFailureCategory'];
  httpStatus: number | null;
  rateLimitRetryAfterMs: number | null;
  rateLimitLimit: number | null;
  rateLimitRemaining: number | null;
  rateLimitResetAt: string | null;
}

interface PlanningReplayDescendants {
  sourceSnapshots: readonly PersistedSourceSnapshotReplayLineage[];
  budgetItems: readonly PersistedBudgetItemReplayLineage[];
  offerChargeCollections: readonly PersistedOfferChargeCollectionReplayLineage[];
  offerChargeDisclosures: readonly PersistedOfferChargeDisclosureReplayLineage[];
  providerExecutionRecords: readonly PersistedProviderExecutionReplayLineage[];
  rejectionReasons: readonly PersistedReplayManifestLineage[];
  rejectionSummaries: readonly PersistedReplayManifestLineage[];
}

const CURRENT_PLANNING_RUN_SCORING_VERSION = `${SCORE_VERSION}:${DEFAULT_CANDIDATE_ENGINE_CONFIG.version}`;

function hasNoProviderManifestLineage(
  record: Pick<
    PersistedPlanningRun | PersistedRankedOptionLineage,
    'providerManifestVersion' | 'providerManifestFingerprint'
  >,
): boolean {
  return record.providerManifestVersion === null && record.providerManifestFingerprint === null;
}

function hasNoOfferPricingLineage(record: PersistedRankedOptionLineage): boolean {
  return (
    record.offerPricingContractVersion === null &&
    record.transportMandatoryTotalMinor === null &&
    record.transportMandatoryTotalPriceType === null &&
    record.transportMandatoryTotalClassification === null &&
    record.transportMandatoryTotalSourceKey === null &&
    record.accommodationMandatoryTotalMinor === null &&
    record.accommodationMandatoryTotalPriceType === null &&
    record.accommodationMandatoryTotalClassification === null &&
    record.accommodationMandatoryTotalSourceKey === null
  );
}

function hasCurrentOfferPricingLineage(record: PersistedRankedOptionLineage): boolean {
  const validMandatoryTotal = (
    amount: number | string | null,
    priceType: string | null,
    classification: string | null,
    sourceKey: string | null,
  ): boolean => {
    const normalizedAmount =
      typeof amount === 'number'
        ? amount
        : typeof amount === 'string' && /^\d+$/.test(amount)
          ? Number(amount)
          : Number.NaN;
    return (
      Number.isSafeInteger(normalizedAmount) &&
      normalizedAmount >= 0 &&
      (priceType === 'LIVE_PRICE' || priceType === 'FIXED_PRICE' || priceType === 'ESTIMATE') &&
      classification === (priceType === 'ESTIMATE' ? 'ESTIMATED' : 'CONFIRMED') &&
      typeof sourceKey === 'string' &&
      sourceKey.trim().length > 0 &&
      sourceKey.length <= 500
    );
  };
  return (
    record.offerPricingContractVersion === OFFER_PRICING_CONTRACT_VERSION &&
    validMandatoryTotal(
      record.transportMandatoryTotalMinor,
      record.transportMandatoryTotalPriceType,
      record.transportMandatoryTotalClassification,
      record.transportMandatoryTotalSourceKey,
    ) &&
    validMandatoryTotal(
      record.accommodationMandatoryTotalMinor,
      record.accommodationMandatoryTotalPriceType,
      record.accommodationMandatoryTotalClassification,
      record.accommodationMandatoryTotalSourceKey,
    )
  );
}

const REPLAY_BUDGET_CATEGORIES = [
  'TRANSPORT',
  'ACCOMMODATION',
  'LOCAL_TRANSPORT',
  'FOOD',
  'ATTRACTIONS',
  'ADDITIONAL_FEES',
  'BUFFER',
] as const;

const REPLAY_OFFER_COLLECTION_KEYS = [
  'TRANSPORT:CONDITIONAL',
  'TRANSPORT:OPTIONAL',
  'ACCOMMODATION:CONDITIONAL',
  'ACCOMMODATION:OPTIONAL',
] as const;

function hasReplayAssociationLineage(
  record: PersistedReplayAssociationLineage,
  tripRequestId: string,
  workflowRunId: string,
  planningRunId: string,
): boolean {
  return (
    record.tripRequest_ID === tripRequestId &&
    record.workflowRun_ID === workflowRunId &&
    record.planningRun_ID === planningRunId
  );
}

function hasCurrentReplayManifestLineage(
  record: PersistedReplayManifestLineage,
  tripRequestId: string,
  workflowRunId: string,
  planningRunId: string,
  manifest: ReturnType<typeof providerManifestLineage>,
): boolean {
  return (
    hasReplayAssociationLineage(record, tripRequestId, workflowRunId, planningRunId) &&
    record.providerFixtureVersion === manifest.fixtureVersion &&
    record.providerManifestVersion === manifest.manifestVersion &&
    record.providerManifestFingerprint === manifest.manifestFingerprint &&
    record.scoringVersion === CURRENT_PLANNING_RUN_SCORING_VERSION
  );
}

function hasLegacyReplayManifestLineage(
  record: PersistedReplayManifestLineage,
  tripRequestId: string,
  workflowRunId: string,
  planningRunId: string,
  providerFixtureVersion: string,
  scoringVersion: string,
): boolean {
  return (
    hasReplayAssociationLineage(record, tripRequestId, workflowRunId, planningRunId) &&
    record.providerFixtureVersion === providerFixtureVersion &&
    record.providerManifestVersion === null &&
    record.providerManifestFingerprint === null &&
    record.scoringVersion === scoringVersion
  );
}

function optionHasExactBudgetCategories(
  optionId: string,
  budgetItems: readonly PersistedBudgetItemReplayLineage[],
): boolean {
  const categories = budgetItems
    .filter((item) => item.rankedOption_ID === optionId)
    .map((item) => item.category)
    .sort((left, right) => left.localeCompare(right, 'en'));
  const expected = [...REPLAY_BUDGET_CATEGORIES].sort((left, right) =>
    left.localeCompare(right, 'en'),
  );
  return (
    categories.length === expected.length &&
    categories.every((category, index) => category === expected[index])
  );
}

function optionHasExactOfferCollections(
  optionId: string,
  collections: readonly PersistedOfferChargeCollectionReplayLineage[],
): boolean {
  const keys = collections
    .filter((collection) => collection.rankedOption_ID === optionId)
    .map((collection) => `${collection.scope}:${collection.kind}`)
    .sort((left, right) => left.localeCompare(right, 'en'));
  const expected = [...REPLAY_OFFER_COLLECTION_KEYS].sort((left, right) =>
    left.localeCompare(right, 'en'),
  );
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function safePersistedDisclosureText(value: unknown, maximum: number): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= maximum &&
    ![...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || (codePoint >= 127 && codePoint <= 159);
    })
  );
}

function assertCurrentPlanningReplayDescendants(
  tripRequestId: string,
  workflowRun: PersistedWorkflowRun,
  planningRun: PersistedPlanningRun,
  providerManifest: ProviderConfigurationManifest,
  manifest: ReturnType<typeof providerManifestLineage>,
  rankedOptions: readonly PersistedRankedOptionLineage[],
  descendants: PlanningReplayDescendants,
): void {
  const optionIds = new Set(rankedOptions.map((option) => option.ID));
  const sourceById = new Map(
    descendants.sourceSnapshots.map((source) => [source.ID, source] as const),
  );
  const canonicalSourceByKey = new Map<string, string>();
  const collectionById = new Map(
    descendants.offerChargeCollections.map((collection) => [collection.ID, collection] as const),
  );
  const validSources = descendants.sourceSnapshots.every((source) => {
    const snapshot = {
      contractVersion: source.sourceContractVersion,
      id: source.sourceKey,
      sourceType: source.sourceType,
      provider: source.provider,
      adapterVersion: source.adapterVersion,
      providerVersion: source.providerVersion,
      upstreamApiVersion: source.upstreamApiVersion,
      upstreamSchemaFingerprint: source.upstreamSchemaFingerprint,
      queryFingerprint: source.queryFingerprint,
      resultFingerprint: source.resultFingerprint,
      externalItemId: source.externalItemId,
      fetchedAt: source.fetchedAt,
      expiresAt: source.expiresAt,
      sourceUrl: source.sourceUrl,
      attribution: source.attribution,
      freshnessType: source.freshnessType,
      currency: source.currency,
      fixtureVersion: source.fixtureVersion,
      termsPolicyVersion: source.termsPolicyVersion,
    } as SourceSnapshot;
    if (!isCompleteSourceSnapshot(snapshot)) return false;
    const canonical = canonicalSourceSnapshot(snapshot);
    const previousCanonical = canonicalSourceByKey.get(snapshot.id);
    if (previousCanonical !== undefined && previousCanonical !== canonical) return false;
    canonicalSourceByKey.set(snapshot.id, canonical);
    const exactInternalSource =
      source.sourceType === 'INTERNAL_RULE' &&
      source.provider === 'INTERNAL_FIXTURE' &&
      source.adapterVersion === 'internal-cost-estimator-v1' &&
      source.providerVersion === INTERNAL_COST_FIXTURE_VERSION &&
      source.upstreamApiVersion === null &&
      source.upstreamSchemaFingerprint === null &&
      source.expiresAt === null &&
      source.fixtureVersion === INTERNAL_COST_FIXTURE_VERSION;
    const exactProviderSource =
      exactInternalSource ||
      providerManifest.entries.some(
        (providerEntry) =>
          providerEntry.providerName === source.provider &&
          source.sourceType === (providerEntry.mode === 'LIVE' ? 'LIVE' : 'FIXTURE') &&
          source.adapterVersion === providerEntry.adapterVersion &&
          source.providerVersion === providerEntry.providerVersion &&
          source.upstreamApiVersion === providerEntry.upstreamApiVersion &&
          source.upstreamSchemaFingerprint === providerEntry.upstreamSchemaFingerprint &&
          source.fixtureVersion === providerEntry.fixtureVersion,
      );
    return (
      hasCurrentReplayManifestLineage(
        source,
        tripRequestId,
        workflowRun.ID,
        planningRun.ID,
        manifest,
      ) &&
      optionIds.has(source.rankedOption_ID) &&
      source.contexts.length > 0 &&
      source.contexts.length <= 1_000 &&
      /^[A-Z0-9_:, ]+$/.test(source.contexts) &&
      source.demonstrationData === (source.sourceType !== 'LIVE') &&
      exactProviderSource
    );
  });
  const everyOptionHasSources = [...optionIds].every((optionId) =>
    descendants.sourceSnapshots.some((source) => source.rankedOption_ID === optionId),
  );
  const everyMandatoryTotalHasSource = rankedOptions.every(
    (option) =>
      descendants.sourceSnapshots.some(
        (source) =>
          source.rankedOption_ID === option.ID &&
          source.sourceKey === option.transportMandatoryTotalSourceKey,
      ) &&
      descendants.sourceSnapshots.some(
        (source) =>
          source.rankedOption_ID === option.ID &&
          source.sourceKey === option.accommodationMandatoryTotalSourceKey,
      ),
  );
  const validBudgets =
    descendants.budgetItems.every(
      (item) =>
        hasCurrentReplayManifestLineage(
          item,
          tripRequestId,
          workflowRun.ID,
          planningRun.ID,
          manifest,
        ) &&
        optionIds.has(item.rankedOption_ID) &&
        item.sourceSnapshot_ID !== null &&
        sourceById.get(item.sourceSnapshot_ID)?.rankedOption_ID === item.rankedOption_ID,
    ) &&
    [...optionIds].every((optionId) =>
      optionHasExactBudgetCategories(optionId, descendants.budgetItems),
    );
  const validCollections =
    descendants.offerChargeCollections.every(
      (collection) =>
        hasCurrentReplayManifestLineage(
          collection,
          tripRequestId,
          workflowRun.ID,
          planningRun.ID,
          manifest,
        ) &&
        optionIds.has(collection.rankedOption_ID) &&
        collection.offerPricingContractVersion === OFFER_PRICING_CONTRACT_VERSION &&
        Number.isSafeInteger(collection.itemCount) &&
        collection.itemCount >= 0,
    ) &&
    [...optionIds].every((optionId) =>
      optionHasExactOfferCollections(optionId, descendants.offerChargeCollections),
    );
  const validDisclosures = descendants.offerChargeDisclosures.every((disclosure) => {
    const collection = collectionById.get(disclosure.collection_ID);
    const conditionalSemantics =
      collection?.kind === 'CONDITIONAL'
        ? safePersistedDisclosureText(disclosure.condition, 500) &&
          CONDITIONAL_CHARGE_PAYABLE_AT_VALUES.includes(
            disclosure.payableAt as (typeof CONDITIONAL_CHARGE_PAYABLE_AT_VALUES)[number],
          ) &&
          typeof disclosure.mandatoryWhenConditionMet === 'boolean'
        : collection?.kind === 'OPTIONAL' &&
          disclosure.condition === null &&
          disclosure.payableAt === null &&
          disclosure.mandatoryWhenConditionMet === null;
    return (
      hasReplayAssociationLineage(disclosure, tripRequestId, workflowRun.ID, planningRun.ID) &&
      optionIds.has(disclosure.rankedOption_ID) &&
      collection?.rankedOption_ID === disclosure.rankedOption_ID &&
      disclosure.offerPricingContractVersion === OFFER_PRICING_CONTRACT_VERSION &&
      safePersistedDisclosureText(disclosure.chargeId, 120) &&
      safePersistedDisclosureText(disclosure.code, 120) &&
      safePersistedDisclosureText(disclosure.label, 240) &&
      conditionalSemantics &&
      disclosure.includedInBudget === false &&
      disclosure.sourceSnapshot_ID !== null &&
      sourceById.get(disclosure.sourceSnapshot_ID)?.rankedOption_ID === disclosure.rankedOption_ID
    );
  });
  const exactDisclosureCounts = descendants.offerChargeCollections.every(
    (collection) =>
      descendants.offerChargeDisclosures.filter(
        (disclosure) => disclosure.collection_ID === collection.ID,
      ).length === collection.itemCount,
  );
  const validAuditLineage = descendants.providerExecutionRecords.every((record) => {
    const manifestEntry = providerManifest.entries.find(
      (entry) => entry.providerKey === record.providerKey,
    );
    const exactOperation =
      (manifestEntry?.role === 'TRANSPORT' &&
        record.operation === 'TRANSPORT_SEARCH' &&
        record.destinationCode === null) ||
      (manifestEntry?.role === 'ACCOMMODATION' &&
        record.operation === 'ACCOMMODATION_SEARCH' &&
        record.destinationCode !== null) ||
      (manifestEntry?.role === 'PLACES' &&
        record.operation === 'PLACES_SEARCH' &&
        record.destinationCode !== null);
    return (
      hasReplayAssociationLineage(record, tripRequestId, workflowRun.ID, planningRun.ID) &&
      record.providerManifestVersion === manifest.manifestVersion &&
      record.providerManifestFingerprint === manifest.manifestFingerprint &&
      record.policyVersion === providerManifest.executionPolicy.version &&
      exactOperation
    );
  });
  const auditEvents = [...descendants.providerExecutionRecords]
    .sort((left, right) => left.sequence - right.sequence)
    .map((record): ProviderCallAuditEvent => ({
      sequence: record.sequence,
      policyVersion: record.policyVersion as ProviderCallAuditEvent['policyVersion'],
      providerKey: record.providerKey,
      operation: record.operation,
      destinationCode: record.destinationCode,
      status: record.status,
      providerCallAttempted: record.providerCallAttempted,
      attempts: record.attempts,
      latencyMs: record.latencyMs,
      queryFingerprint: record.queryFingerprint,
      resultFingerprint: record.resultFingerprint,
      resultCount: record.resultCount,
      failureCategory: record.failureCategory,
      underlyingFailureCategory: record.underlyingFailureCategory,
      httpStatus: record.httpStatus,
      rateLimitRetryAfterMs: record.rateLimitRetryAfterMs,
      rateLimitLimit: record.rateLimitLimit,
      rateLimitRemaining: record.rateLimitRemaining,
      rateLimitResetAt: record.rateLimitResetAt,
    }));
  let validAuditContract = true;
  try {
    assertProviderExecutionAudit(providerManifest.executionPolicy.version, auditEvents);
  } catch {
    validAuditContract = false;
  }
  const validRejections = [
    ...descendants.rejectionReasons,
    ...descendants.rejectionSummaries,
  ].every((record) =>
    hasCurrentReplayManifestLineage(
      record,
      tripRequestId,
      workflowRun.ID,
      planningRun.ID,
      manifest,
    ),
  );

  if (
    !validSources ||
    !everyOptionHasSources ||
    !everyMandatoryTotalHasSource ||
    !validBudgets ||
    !validCollections ||
    !validDisclosures ||
    !exactDisclosureCounts ||
    !validAuditLineage ||
    !validAuditContract ||
    planningRun.providerExecutionCallCount === null ||
    planningRun.providerExecutionCallCount <= 0 ||
    descendants.providerExecutionRecords.length !== planningRun.providerExecutionCallCount ||
    !validRejections
  ) {
    throw new DomainError(
      'PLANNING_STATE_INCONSISTENT',
      'Potomny zapis planowania nie spełnia bieżącego kontraktu lineage.',
    );
  }
}

function assertLegacyPlanningReplayDescendants(
  tripRequestId: string,
  workflowRun: PersistedWorkflowRun,
  planningRun: PersistedPlanningRun,
  rankedOptions: readonly PersistedRankedOptionLineage[],
  descendants: PlanningReplayDescendants,
  lineage: { readonly providerFixtureVersion: string; readonly scoringVersion: string },
): void {
  const optionIds = new Set(rankedOptions.map((option) => option.ID));
  const sourceById = new Map(
    descendants.sourceSnapshots.map((source) => [source.ID, source] as const),
  );
  const historicalFixtureProviderNames = new Set<string>(Object.values(MOCK_PROVIDER_NAMES));
  const validSources = descendants.sourceSnapshots.every((source) => {
    const exactFixtureSource =
      historicalFixtureProviderNames.has(source.provider) &&
      source.fixtureVersion === MOCK_FIXTURE_VERSION &&
      source.freshnessType === 'FIXTURE' &&
      source.sourceUrl === 'INTERNAL_FIXTURE';
    const exactInternalRuleSource =
      source.provider === 'INTERNAL_FIXTURE' &&
      source.fixtureVersion === INTERNAL_COST_FIXTURE_VERSION &&
      source.freshnessType === 'INTERNAL_RULE' &&
      source.sourceUrl === 'INTERNAL_FIXTURE';
    return (
      hasLegacyReplayManifestLineage(
        source,
        tripRequestId,
        workflowRun.ID,
        planningRun.ID,
        lineage.providerFixtureVersion,
        lineage.scoringVersion,
      ) &&
      optionIds.has(source.rankedOption_ID) &&
      source.sourceContractVersion === null &&
      source.sourceType === null &&
      source.adapterVersion === null &&
      source.providerVersion === null &&
      source.upstreamApiVersion === null &&
      source.upstreamSchemaFingerprint === null &&
      source.queryFingerprint === null &&
      source.resultFingerprint === null &&
      source.expiresAt === null &&
      source.attribution === null &&
      source.termsPolicyVersion === null &&
      (exactFixtureSource || exactInternalRuleSource)
    );
  });
  const everyOptionHasSources = [...optionIds].every((optionId) =>
    descendants.sourceSnapshots.some((source) => source.rankedOption_ID === optionId),
  );
  const validBudgets =
    descendants.budgetItems.every(
      (item) =>
        hasLegacyReplayManifestLineage(
          item,
          tripRequestId,
          workflowRun.ID,
          planningRun.ID,
          lineage.providerFixtureVersion,
          lineage.scoringVersion,
        ) &&
        optionIds.has(item.rankedOption_ID) &&
        (item.sourceSnapshot_ID === null ||
          sourceById.get(item.sourceSnapshot_ID)?.rankedOption_ID === item.rankedOption_ID),
    ) &&
    [...optionIds].every((optionId) =>
      optionHasExactBudgetCategories(optionId, descendants.budgetItems),
    );
  const validRejections = [
    ...descendants.rejectionReasons,
    ...descendants.rejectionSummaries,
  ].every((record) =>
    hasLegacyReplayManifestLineage(
      record,
      tripRequestId,
      workflowRun.ID,
      planningRun.ID,
      lineage.providerFixtureVersion,
      lineage.scoringVersion,
    ),
  );
  const shortageDescendantsValid =
    planningRun.status !== 'INSUFFICIENT_OPTIONS' ||
    (rankedOptions.length === 0 &&
      descendants.sourceSnapshots.length === 0 &&
      descendants.budgetItems.length === 0 &&
      descendants.rejectionReasons.length > 0 &&
      descendants.rejectionSummaries.length > 0);
  if (
    !validSources ||
    !everyOptionHasSources ||
    !validBudgets ||
    !validRejections ||
    descendants.offerChargeCollections.length !== 0 ||
    descendants.offerChargeDisclosures.length !== 0 ||
    descendants.providerExecutionRecords.length !== 0 ||
    !shortageDescendantsValid
  ) {
    throw new DomainError(
      'PLANNING_STATE_INCONSISTENT',
      'Potomny zapis planowania zanieczyszcza zamrożony kontrakt legacy replay.',
    );
  }
}

function assertLegacyPlanningReplay(
  tripRequestId: string,
  workflowRun: PersistedWorkflowRun,
  planningRun: PersistedPlanningRun,
  expectedFingerprint: string,
  rankedOptions: readonly PersistedRankedOptionLineage[],
): void {
  const optionsHaveExactHistoricalLineage =
    rankedOptions.length === 3 &&
    rankedOptions.every(
      (option) =>
        option.tripRequest_ID === tripRequestId &&
        option.workflowRun_ID === workflowRun.ID &&
        option.planningRun_ID === planningRun.ID &&
        option.providerFixtureVersion === LEGACY_PLANNING_RUN_V0_LINEAGE.providerFixtureVersion &&
        hasNoProviderManifestLineage(option) &&
        hasNoOfferPricingLineage(option) &&
        option.scoringVersion === LEGACY_PLANNING_RUN_V0_LINEAGE.scoringVersion,
    );
  const runHasExactHistoricalLineage =
    planningRun.tripRequest_ID === tripRequestId &&
    planningRun.workflowRun_ID === workflowRun.ID &&
    planningRun.requestFingerprint === expectedFingerprint &&
    planningRun.currencyContractVersion === null &&
    planningRun.offerPricingContractVersion === null &&
    planningRun.requestFingerprintVersion === null &&
    planningRun.status === 'SUCCEEDED' &&
    planningRun.providerFixtureVersion === LEGACY_PLANNING_RUN_V0_LINEAGE.providerFixtureVersion &&
    planningRun.providerManifestJson === null &&
    hasNoProviderManifestLineage(planningRun) &&
    planningRun.engineVersion === LEGACY_PLANNING_RUN_V0_LINEAGE.engineVersion &&
    planningRun.scoringVersion === LEGACY_PLANNING_RUN_V0_LINEAGE.scoringVersion &&
    planningRun.providerExecutionCallCount === null &&
    planningRun.selectedOptionCount === 3;

  if (
    workflowRun.tripRequest_ID !== tripRequestId ||
    workflowRun.state !== 'OPTIONS_READY' ||
    !runHasExactHistoricalLineage ||
    !optionsHaveExactHistoricalLineage
  ) {
    throw new DomainError(
      'PLANNING_STATE_INCONSISTENT',
      'Historyczny wynik planowania v0 nie spełnia zamrożonego kontraktu replay.',
    );
  }
}

function assertLegacyPlanningReplayV1(
  tripRequestId: string,
  workflowRun: PersistedWorkflowRun,
  planningRun: PersistedPlanningRun,
  expectedFingerprint: string,
  rankedOptions: readonly PersistedRankedOptionLineage[],
): void {
  const optionsHaveExactHistoricalLineage =
    rankedOptions.length === 3 &&
    rankedOptions.every(
      (option) =>
        option.tripRequest_ID === tripRequestId &&
        option.workflowRun_ID === workflowRun.ID &&
        option.planningRun_ID === planningRun.ID &&
        option.providerFixtureVersion === LEGACY_PLANNING_RUN_V1_LINEAGE.providerFixtureVersion &&
        option.scoringVersion === LEGACY_PLANNING_RUN_V1_LINEAGE.scoringVersion &&
        hasNoProviderManifestLineage(option) &&
        hasNoOfferPricingLineage(option),
    );
  const runHasSharedHistoricalLineage =
    planningRun.tripRequest_ID === tripRequestId &&
    planningRun.workflowRun_ID === workflowRun.ID &&
    planningRun.requestFingerprint === expectedFingerprint &&
    planningRun.requestFingerprintVersion === null &&
    planningRun.currencyContractVersion ===
      LEGACY_PLANNING_RUN_V1_LINEAGE.currencyContractVersion &&
    planningRun.offerPricingContractVersion === null &&
    planningRun.providerFixtureVersion === LEGACY_PLANNING_RUN_V1_LINEAGE.providerFixtureVersion &&
    planningRun.providerManifestJson === null &&
    hasNoProviderManifestLineage(planningRun) &&
    planningRun.engineVersion === LEGACY_PLANNING_RUN_V1_LINEAGE.engineVersion &&
    planningRun.scoringVersion === LEGACY_PLANNING_RUN_V1_LINEAGE.scoringVersion &&
    planningRun.providerExecutionCallCount === null;
  const succeededRun =
    planningRun.status === 'SUCCEEDED' &&
    workflowRun.state === 'OPTIONS_READY' &&
    planningRun.selectedOptionCount === 3 &&
    optionsHaveExactHistoricalLineage;
  const shortageRun =
    planningRun.status === 'INSUFFICIENT_OPTIONS' &&
    workflowRun.state === 'CONSTRAINTS_CONFIRMED' &&
    planningRun.selectedOptionCount === 0 &&
    planningRun.rejectedCandidateCount > 0 &&
    planningRun.errorCode === 'INSUFFICIENT_VALID_CANDIDATES' &&
    rankedOptions.length === 0;

  if (
    workflowRun.tripRequest_ID !== tripRequestId ||
    !runHasSharedHistoricalLineage ||
    (!succeededRun && !shortageRun)
  ) {
    throw new DomainError(
      'PLANNING_STATE_INCONSISTENT',
      'Historyczny wynik planowania v1 nie spełnia zamrożonego kontraktu replay.',
    );
  }
}

function assertCurrentPlanningReplay(
  tripRequestId: string,
  workflowRun: PersistedWorkflowRun,
  planningRun: PersistedPlanningRun,
  manifest: ReturnType<typeof providerManifestLineage>,
  rankedOptions: readonly PersistedRankedOptionLineage[],
): void {
  const valid =
    workflowRun.tripRequest_ID === tripRequestId &&
    workflowRun.state === 'OPTIONS_READY' &&
    planningRun.tripRequest_ID === tripRequestId &&
    planningRun.workflowRun_ID === workflowRun.ID &&
    planningRun.status === 'SUCCEEDED' &&
    planningRun.requestFingerprintVersion === PLANNING_REQUEST_FINGERPRINT_VERSION &&
    planningRun.currencyContractVersion === CURRENCY_CONTRACT_VERSION &&
    planningRun.offerPricingContractVersion === OFFER_PRICING_CONTRACT_VERSION &&
    planningRun.providerManifestVersion === manifest.manifestVersion &&
    planningRun.providerManifestFingerprint === manifest.manifestFingerprint &&
    planningRun.providerManifestJson === manifest.manifestJson &&
    planningRun.providerFixtureVersion === manifest.fixtureVersion &&
    planningRun.engineVersion === DEFAULT_CANDIDATE_ENGINE_CONFIG.version &&
    planningRun.scoringVersion === CURRENT_PLANNING_RUN_SCORING_VERSION &&
    planningRun.providerExecutionCallCount !== null &&
    planningRun.providerExecutionCallCount > 0 &&
    planningRun.selectedOptionCount === 3 &&
    rankedOptions.length === 3 &&
    rankedOptions.every(
      (option) =>
        option.tripRequest_ID === tripRequestId &&
        option.workflowRun_ID === workflowRun.ID &&
        option.planningRun_ID === planningRun.ID &&
        option.providerFixtureVersion === manifest.fixtureVersion &&
        option.providerManifestVersion === manifest.manifestVersion &&
        option.providerManifestFingerprint === manifest.manifestFingerprint &&
        hasCurrentOfferPricingLineage(option) &&
        option.scoringVersion === CURRENT_PLANNING_RUN_SCORING_VERSION,
    );
  if (!valid) {
    throw new DomainError(
      'PLANNING_STATE_INCONSISTENT',
      'Bieżący wynik planowania nie spełnia kontraktu provider manifest v2.',
    );
  }
}

/** Tłumaczy błąd domenowy na kontrolowaną odpowiedź HTTP 400 bez gubienia jego kodu. */
function rejectDomainError(request: Request, error: unknown): never {
  if (error instanceof DomainError) {
    const status =
      error.code === 'PROVIDER_SEARCH_FAILED'
        ? 502
        : [
              'TRIP_REQUEST_NOT_CONFIRMED',
              'WORKFLOW_RUN_NOT_FOUND',
              'PLANNING_ALREADY_IN_PROGRESS',
              'PLANNING_STATE_INCONSISTENT',
            ].includes(error.code)
          ? 409
          : 400;
    return request.reject({ status, code: error.code, message: error.message });
  }

  throw error;
}

/** Zwraca wyłącznie zamknięty kod AI/domeny; raw provider error nie trafia do klienta. */
function rejectNarrativeError(request: Request, error: unknown): never {
  if (error instanceof DomainError) {
    const status = ['RANKED_OPTION_NOT_FOUND', 'PLANNING_RUN_NOT_FOUND'].includes(error.code)
      ? 404
      : [
            'INVALID_NARRATIVE_AUDIT_LINK',
            'INVALID_GROUNDED_OPTION_CONTEXT',
            'INVALID_NARRATIVE_PERSISTENCE',
            'INVALID_NARRATIVE_MODEL_VIEW',
            'INVALID_NARRATIVE_GENERATION_VIEW',
            'INVALID_NARRATIVE_FINALIZATION',
            'INVALID_NARRATIVE_QUALITY_CONTEXT',
            'INVALID_NARRATIVE_JUDGE_OUTPUT',
            'INVALID_NARRATIVE_REVIEW_PERSISTENCE',
            'PRODUCT_WRITE_FAILED',
          ].includes(error.code)
        ? 500
        : 409;
    return request.reject({ status, code: error.code, message: error.message });
  }
  const aiError = normalizeAiError(error);
  if (aiError !== null) {
    const status = [
      'AI_DISABLED',
      'LIVE_AI_NOT_ENABLED',
      'MISSING_CREDENTIALS',
      'INVALID_AI_CONFIGURATION',
      'UNSUPPORTED_AI_PROVIDER',
    ].includes(aiError.code)
      ? 503
      : aiError.code === 'AI_AUDIT_FAILED'
        ? 500
        : 502;
    return request.reject({ status, code: aiError.code, message: aiError.message });
  }
  throw error;
}

interface NormalizedNarrativeAiError {
  readonly code: AiErrorCode;
  readonly message: string;
  readonly aiRunId?: string;
}

function normalizeAiError(error: unknown): NormalizedNarrativeAiError | null {
  if (error instanceof AiError) {
    const aiRunId = error.details.aiRunId;
    return {
      code: error.code,
      message: error.message,
      ...(typeof aiRunId === 'string' ? { aiRunId } : {}),
    };
  }
  if (typeof error !== 'object' || error === null) return null;
  const candidate = error as Readonly<Record<string, unknown>>;
  if (
    candidate.name !== 'AiError' ||
    typeof candidate.code !== 'string' ||
    typeof candidate.message !== 'string' ||
    !AI_ERROR_CODE_VALUES.includes(candidate.code as AiErrorCode)
  ) {
    return null;
  }
  const details =
    typeof candidate.details === 'object' && candidate.details !== null
      ? (candidate.details as Readonly<Record<string, unknown>>)
      : undefined;
  const aiRunId = details?.aiRunId;
  return {
    code: candidate.code as AiErrorCode,
    message: candidate.message,
    ...(typeof aiRunId === 'string' ? { aiRunId } : {}),
  };
}

const NARRATIVE_REVIEW_FAILURE_CODES = new Set<string>(NARRATIVE_REVIEW_FAILURE_CODE_VALUES);

function createNarrativeVersions(
  groundedContextVersion: string,
): NarrativeReviewPersistenceVersions {
  const qualityVersions: NarrativeQualityContractVersions = {
    groundedContextVersion,
    modelViewVersion: NARRATIVE_MODEL_VIEW_VERSION,
    generationViewVersion: NARRATIVE_GENERATION_VIEW_VERSION,
    finalizationVersion: NARRATIVE_FINALIZATION_VERSION,
    qualityContextVersion: NARRATIVE_QUALITY_CONTEXT_VERSION,
    constraintSnapshotVersion: NARRATIVE_CONSTRAINT_SNAPSHOT_VERSION,
    generatePromptVersion: OPTION_NARRATIVE_PROMPT_VERSION,
    generateSchemaVersion: OPTION_NARRATIVE_SCHEMA_VERSION,
    judgePromptVersion: NARRATIVE_JUDGE_PROMPT_VERSION,
    judgeSchemaVersion: NARRATIVE_JUDGE_SCHEMA_VERSION,
    rubricVersion: NARRATIVE_QUALITY_RUBRIC_VERSION,
    datasetVersion: NARRATIVE_QUALITY_DATASET_VERSION,
    publicationPolicyVersion: NARRATIVE_PUBLICATION_POLICY_VERSION,
    modelProfileVersion: NARRATIVE_MODEL_PROFILE_VERSION,
    priceCatalogVersion: NARRATIVE_PRICE_CATALOG_VERSION,
    safetyPrecheckVersion: NARRATIVE_SAFETY_PRECHECK_VERSION,
  };
  return qualityVersions;
}

function createSucceededReviewAudit(input: {
  readonly ID: string;
  readonly planningRunId: string;
  readonly taskType: 'GENERATE' | 'JUDGE';
  readonly promptVersion: string;
  readonly schemaVersion: string;
  readonly inputFingerprint: string;
}): NarrativeReviewAiRunExpectation {
  if (!isValidAiRunId(input.ID)) {
    throw new DomainError(
      'INVALID_NARRATIVE_AUDIT_LINK',
      'Narrative quality gate requires an audited AI run UUID.',
    );
  }
  return {
    ID: input.ID,
    planningRun_ID: input.planningRunId,
    status: 'SUCCEEDED',
    taskType: input.taskType,
    promptVersion: input.promptVersion,
    schemaVersion: input.schemaVersion,
    inputFingerprint: input.inputFingerprint,
  };
}

function createFailedReviewAudit(
  error: unknown,
  input: Omit<NarrativeReviewAiRunExpectation, 'ID' | 'status'>,
): NarrativeReviewAiRunExpectation | undefined {
  const normalized = normalizeAiError(error);
  const aiRunId = normalized?.aiRunId;
  if (normalized === null || aiRunId === undefined || !isValidAiRunId(aiRunId)) {
    return undefined;
  }
  return {
    ...input,
    ID: aiRunId,
    // A terminal recorder failure leaves the already durable STARTED row unchanged.
    status: normalized.code === 'AI_AUDIT_FAILED' ? 'STARTED' : 'FAILED',
  };
}

function narrativeReviewFailureCode(
  error: unknown,
  fallback: NarrativeReviewFailureCode,
): NarrativeReviewFailureCode {
  const normalizedAiError = normalizeAiError(error);
  const code =
    normalizedAiError?.code ??
    (typeof error === 'object' &&
    error !== null &&
    typeof (error as { code?: unknown }).code === 'string'
      ? (error as { code: string }).code
      : undefined);
  return code !== undefined && NARRATIVE_REVIEW_FAILURE_CODES.has(code)
    ? (code as NarrativeReviewFailureCode)
    : fallback;
}

function toNarrativeReviewDimensions(
  output: NarrativeJudgeOutput,
): NarrativeReviewDimensionResults {
  return Object.fromEntries(
    output.dimensions.map(({ dimension, status }) => [dimension, status]),
  ) as unknown as NarrativeReviewDimensionResults;
}

function precheckFindingDimension(reasonCode: NarrativeJudgeReasonCode): NarrativeJudgeDimension {
  const dimensions = NARRATIVE_JUDGE_REASON_DIMENSIONS[reasonCode];
  if (dimensions.length !== 1) {
    throw new DomainError(
      'INVALID_NARRATIVE_REVIEW_PERSISTENCE',
      'A deterministic precheck finding must have one canonical review dimension.',
    );
  }
  return dimensions[0]!;
}

function narrativeQualityRejected(): DomainError {
  return new DomainError(
    'NARRATIVE_QUALITY_REJECTED',
    'Narrative candidate did not pass the deterministic quality gate.',
  );
}

export default class TripPlannerService extends cds.ApplicationService {
  private readonly activePlanningRequests = new Map<string, Promise<unknown>>();
  private readonly narrativeQualityReader = new CapNarrativeQualityReader();
  private readonly narrativeReviewStore = new CapNarrativeReviewStore();
  private readonly narrativeReviewWriter = new CapNarrativeReviewWriter();

  /** Jawny seam zależności pozwala testować awarię providera bez flag w publicznym API. */
  public createPlanningProviders(): CandidateEngineProviders {
    return {
      transport: new MockTransportProvider(),
      accommodation: new MockAccommodationProvider(),
      places: new MockPlacesProvider(),
    };
  }

  /** Pure lineage seam; replay can validate configuration without constructing a provider. */
  public createPlanningProviderManifest(): ProviderConfigurationManifest {
    return MOCK_PROVIDER_MANIFEST;
  }

  /** Jawny seam testowy; produkcja nadal używa profilu GENERATE i fail-closed AiRuns. */
  public createNarrativeGateway(): AiGateway {
    return createPersistentAiGateway(loadAiConfig(process.env));
  }

  /**
   * Równoległe requesty tego samego nieedytowalnego briefu współdzielą jedno wykonanie.
   * Obserwatorzy otrzymują wynik dopiero po commicie requestu-właściciela.
   */
  private runPlanningOnce(
    tripRequestId: string,
    request: Request,
    execute: () => Promise<unknown>,
  ): Promise<unknown> {
    const active = this.activePlanningRequests.get(tripRequestId);
    if (active) return active;

    let committedResult: unknown;
    let executionError: unknown;
    let resolveCommitted!: (value: unknown) => void;
    let rejectCommitted!: (reason: unknown) => void;
    const committed = new Promise<unknown>((resolve, reject) => {
      resolveCommitted = resolve;
      rejectCommitted = reject;
    });

    // Właściciel requestu zwraca własny błąd HTTP. Ten handler zapobiega nieobsłużonemu
    // rejection odroczonego Promise, gdy nie było żadnego równoległego obserwatora.
    void committed.catch(() => undefined);
    this.activePlanningRequests.set(tripRequestId, committed);

    request.on('succeeded', () => resolveCommitted(committedResult));
    request.on('failed', () =>
      rejectCommitted(executionError ?? new Error('Nie udało się zatwierdzić wyniku planowania.')),
    );
    request.on('done', () => {
      if (this.activePlanningRequests.get(tripRequestId) === committed) {
        this.activePlanningRequests.delete(tripRequestId);
      }
    });

    return execute().then(
      (result) => {
        committedResult = result;
        return result;
      },
      (error: unknown) => {
        executionError = error;
        throw error;
      },
    );
  }

  override async init(): Promise<void> {
    const { NarrativeRuns, TripRequests } = this.entities;
    const {
      BudgetItems: PersistedBudgetItems,
      OfferChargeCollections: PersistedOfferChargeCollections,
      OfferChargeDisclosures: PersistedOfferChargeDisclosures,
      OptionNotes: PersistedOptionNotes,
      PlanningRuns: PersistedPlanningRuns,
      RankedOptions: PersistedRankedOptions,
      RejectionReasons: PersistedRejectionReasons,
      RejectionSummaries: PersistedRejectionSummaries,
      SourceSnapshots: PersistedSourceSnapshots,
      ProviderExecutionRecords: PersistedProviderExecutionRecords,
      WorkflowRuns: PersistedWorkflowRuns,
      WorkflowTransitions: PersistedWorkflowTransitions,
    } = cds.entities('trip.planner');
    const { DELETE, INSERT, SELECT, UPDATE } = cds.ql;
    if (
      !TripRequests ||
      !NarrativeRuns ||
      !PersistedWorkflowRuns ||
      !PersistedPlanningRuns ||
      !PersistedWorkflowTransitions ||
      !PersistedRankedOptions ||
      !PersistedBudgetItems ||
      !PersistedOfferChargeCollections ||
      !PersistedOfferChargeDisclosures ||
      !PersistedSourceSnapshots ||
      !PersistedProviderExecutionRecords ||
      !PersistedOptionNotes ||
      !PersistedRejectionReasons ||
      !PersistedRejectionSummaries
    ) {
      throw new Error('Brak wymaganych encji planowania w modelu persistence.');
    }

    // Obecny formularz nie wysyła jeszcze profili, dlatego backend materializuje ich defaults.
    this.before('CREATE', TripRequests, (request: Request) => {
      const data = request.data as MutableTripRequest;
      data.status = 'DRAFT';

      try {
        const normalized = normalizeTripRequest(data);
        validateTripRequest(normalized);
        materializeProfiles(data, normalized);
      } catch (error) {
        rejectDomainError(request, error);
      }
    });

    // Płaski PATCH profilu łączymy z pełnym rekordem przed walidacją domenową.
    this.before('UPDATE', TripRequests, async (request: Request) => {
      const ID = String(request.data.ID ?? request.params[0]?.ID ?? '');
      const current = (await SELECT.one.from(TripRequests).where({ ID })) as
        PersistedTripRequest | undefined;
      if (!current) {
        request.reject(404, 'Nie znaleziono briefu podróży.');
      }
      if (current.status !== 'DRAFT') {
        request.reject(409, 'Potwierdzonego briefu nie można edytować.');
      }
      if (request.data.status !== undefined && request.data.status !== current.status) {
        request.reject(400, 'Status briefu można zmienić wyłącznie przez dedykowaną akcję.');
      }

      try {
        const data = request.data as MutableTripRequest;
        const normalized = normalizeTripRequest(mergeTripRequest(current, data));
        validateTripRequest(normalized);
        materializeProfiles(data, normalized);
      } catch (error) {
        rejectDomainError(request, error);
      }
    });

    // Usunięcie jest dozwolone wyłącznie dla roboczego, jeszcze niepotwierdzonego briefu.
    this.before('DELETE', TripRequests, async (request: Request) => {
      const ID = String(request.data.ID ?? request.params[0]?.ID ?? '');
      const transaction = cds.tx(request);
      const current = (await transaction.run(SELECT.one.from(TripRequests).where({ ID }))) as
        PersistedTripRequest | undefined;
      if (!current) {
        request.reject(404, 'Nie znaleziono briefu podróży.');
      }
      if (current.status !== 'DRAFT') {
        request.reject(409, 'Można usunąć wyłącznie wersję roboczą briefu.');
      }

      // Generic DELETE briefu wykona się później w tej samej transakcji requestu.
      await transaction.run(DELETE.from(PersistedWorkflowRuns).where({ tripRequest_ID: ID }));
    });

    // Oba zapisy należą do transakcji bieżącego requestu; błąd wycofuje je razem.
    this.on('confirmConstraints', async (request: Request) => {
      const ID = String(request.params[0]?.ID ?? '');
      const transaction = cds.tx(request);

      try {
        const current = (await transaction.run(SELECT.one.from(TripRequests).where({ ID }))) as
          PersistedTripRequest | undefined;
        if (!current) {
          return request.reject(404, 'Nie znaleziono briefu podróży.');
        }

        const normalized = normalizeTripRequest(current);
        validateTripRequest(normalized);
        const status = confirmTripRequestStatus(current.status);

        const workflowRun = (await transaction.run(
          SELECT.one.from(PersistedWorkflowRuns).where({ tripRequest_ID: ID }),
        )) as PersistedWorkflowRun | undefined;
        const workflowState = transitionWorkflowState(
          workflowRun?.state ?? 'COLLECTING',
          'CONSTRAINTS_CONFIRMED',
        );

        const updatedRows = (await transaction.run(
          UPDATE.entity(TripRequests).set({ status }).where({ ID, status: 'DRAFT' }),
        )) as number;
        if (updatedRows !== 1) {
          throw new DomainError(
            'TRIP_REQUEST_ALREADY_CONFIRMED',
            'Ograniczenia dla tego briefu zostały już potwierdzone.',
          );
        }

        if (workflowRun) {
          await transaction.run(
            UPDATE.entity(PersistedWorkflowRuns)
              .set({ state: workflowState, errorCode: null, errorMessage: null })
              .where({ ID: workflowRun.ID }),
          );
        } else {
          await transaction.run(
            INSERT.into(PersistedWorkflowRuns).entries({
              ID: randomUUID(),
              tripRequest_ID: ID,
              state: workflowState,
              errorCode: null,
              errorMessage: null,
            }),
          );
        }

        return transaction.run(SELECT.one.from(TripRequests).where({ ID }));
      } catch (error) {
        if (error instanceof DomainError && error.code === 'TRIP_REQUEST_ALREADY_CONFIRMED') {
          return request.reject({ status: 409, code: error.code, message: error.message });
        }
        return rejectDomainError(request, error);
      }
    });

    // Pipeline działa na niezmiennym, potwierdzonym briefie. Providerzy są wywoływani
    // przed pierwszym zapisem, a cały trwały wynik powstaje w jednej transakcji requestu.
    const executeStartPlanning = async (request: Request, ID: string): Promise<unknown> => {
      const transaction = cds.tx(request);
      const readReplayDescendants = async (
        planningRunId: string,
      ): Promise<PlanningReplayDescendants> => ({
        sourceSnapshots: (await transaction.run(
          SELECT.from(PersistedSourceSnapshots).where({ planningRun_ID: planningRunId }),
        )) as PersistedSourceSnapshotReplayLineage[],
        budgetItems: (await transaction.run(
          SELECT.from(PersistedBudgetItems).where({ planningRun_ID: planningRunId }),
        )) as PersistedBudgetItemReplayLineage[],
        offerChargeCollections: (await transaction.run(
          SELECT.from(PersistedOfferChargeCollections).where({ planningRun_ID: planningRunId }),
        )) as PersistedOfferChargeCollectionReplayLineage[],
        offerChargeDisclosures: (await transaction.run(
          SELECT.from(PersistedOfferChargeDisclosures).where({ planningRun_ID: planningRunId }),
        )) as PersistedOfferChargeDisclosureReplayLineage[],
        providerExecutionRecords: (await transaction.run(
          SELECT.from(PersistedProviderExecutionRecords).where({ planningRun_ID: planningRunId }),
        )) as PersistedProviderExecutionReplayLineage[],
        rejectionReasons: (await transaction.run(
          SELECT.from(PersistedRejectionReasons).where({ planningRun_ID: planningRunId }),
        )) as PersistedReplayManifestLineage[],
        rejectionSummaries: (await transaction.run(
          SELECT.from(PersistedRejectionSummaries).where({ planningRun_ID: planningRunId }),
        )) as PersistedReplayManifestLineage[],
      });

      try {
        const current = (await transaction.run(SELECT.one.from(TripRequests).where({ ID }))) as
          PersistedTripRequest | undefined;
        if (!current) {
          return request.reject(404, 'Nie znaleziono briefu podróży.');
        }
        if (current.status !== 'CONSTRAINTS_CONFIRMED') {
          throw new DomainError(
            'TRIP_REQUEST_NOT_CONFIRMED',
            'Planowanie można uruchomić dopiero po potwierdzeniu ograniczeń.',
          );
        }

        const normalized = normalizeTripRequest(current);
        validateTripRequest(normalized);
        const workflowRun = (await transaction.run(
          SELECT.one.from(PersistedWorkflowRuns).where({ tripRequest_ID: ID }),
        )) as PersistedWorkflowRun | undefined;
        if (!workflowRun) {
          throw new DomainError(
            'WORKFLOW_RUN_NOT_FOUND',
            'Potwierdzony brief nie ma powiązanego WorkflowRun.',
          );
        }

        const context = createPlanningContext(current);
        const providerManifest = this.createPlanningProviderManifest();
        const providerLineage = providerManifestLineage(providerManifest);
        const versions = {
          currencyContractVersion: CURRENCY_CONTRACT_VERSION,
          offerPricingContractVersion: OFFER_PRICING_CONTRACT_VERSION,
          providerManifestVersion: providerLineage.manifestVersion,
          providerManifestFingerprint: providerLineage.manifestFingerprint,
          engineVersion: DEFAULT_CANDIDATE_ENGINE_CONFIG.version,
          scoringVersion: SCORE_VERSION,
        };
        const requestFingerprint = createPlanningFingerprint(context, versions);
        const existingRun = (await transaction.run(
          SELECT.one.from(PersistedPlanningRuns).where({
            tripRequest_ID: ID,
            requestFingerprint,
          }),
        )) as PersistedPlanningRun | undefined;

        // Potwierdzony brief jest nieedytowalny, dlatego identyczny fingerprint oznacza
        // identyczny wynik. Zwracamy istniejący run zamiast duplikować opcje i diagnostyki.
        if (existingRun) {
          const existingOptions = (await transaction.run(
            SELECT.from(PersistedRankedOptions).where({ planningRun_ID: existingRun.ID }),
          )) as PersistedRankedOptionLineage[];
          if (existingRun.status === 'SUCCEEDED') {
            assertCurrentPlanningReplay(
              ID,
              workflowRun,
              existingRun,
              providerLineage,
              existingOptions,
            );
          } else if (
            workflowRun.state !== 'CONSTRAINTS_CONFIRMED' ||
            existingRun.selectedOptionCount !== 0 ||
            existingOptions.length !== 0 ||
            existingRun.requestFingerprintVersion !== PLANNING_REQUEST_FINGERPRINT_VERSION ||
            existingRun.providerManifestVersion !== providerLineage.manifestVersion ||
            existingRun.providerManifestFingerprint !== providerLineage.manifestFingerprint ||
            existingRun.providerManifestJson !== providerLineage.manifestJson ||
            existingRun.providerFixtureVersion !== providerLineage.fixtureVersion ||
            existingRun.currencyContractVersion !== CURRENCY_CONTRACT_VERSION ||
            existingRun.offerPricingContractVersion !== OFFER_PRICING_CONTRACT_VERSION ||
            existingRun.engineVersion !== DEFAULT_CANDIDATE_ENGINE_CONFIG.version ||
            existingRun.scoringVersion !== CURRENT_PLANNING_RUN_SCORING_VERSION ||
            existingRun.providerExecutionCallCount === null ||
            existingRun.providerExecutionCallCount <= 0
          ) {
            throw new DomainError(
              'PLANNING_STATE_INCONSISTENT',
              'Zapisany niedobór opcji nie spełnia kontraktu provider manifest v2.',
            );
          }
          assertCurrentPlanningReplayDescendants(
            ID,
            workflowRun,
            existingRun,
            providerManifest,
            providerLineage,
            existingOptions,
            await readReplayDescendants(existingRun.ID),
          );
          return transaction.run(
            SELECT.one.from(PersistedPlanningRuns).where({ ID: existingRun.ID }),
          );
        }

        // Dual-read v1/v0 jest dozwolony wyłącznie dla exact fixture-compatible manifestu.
        // Live/mixed configuration never falls back to historical fixture data.
        if (
          (workflowRun.state === 'OPTIONS_READY' ||
            workflowRun.state === 'CONSTRAINTS_CONFIRMED') &&
          isLegacyFixtureCompatibleManifest(providerManifest)
        ) {
          const legacyV1Fingerprint = createLegacyPlanningFingerprintV1(context);
          const legacyV1Run = (await transaction.run(
            SELECT.one.from(PersistedPlanningRuns).where({
              tripRequest_ID: ID,
              requestFingerprint: legacyV1Fingerprint,
            }),
          )) as PersistedPlanningRun | undefined;
          if (legacyV1Run) {
            const legacyV1Options = (await transaction.run(
              SELECT.from(PersistedRankedOptions).where({ planningRun_ID: legacyV1Run.ID }),
            )) as PersistedRankedOptionLineage[];
            assertLegacyPlanningReplayV1(
              ID,
              workflowRun,
              legacyV1Run,
              legacyV1Fingerprint,
              legacyV1Options,
            );
            assertLegacyPlanningReplayDescendants(
              ID,
              workflowRun,
              legacyV1Run,
              legacyV1Options,
              await readReplayDescendants(legacyV1Run.ID),
              LEGACY_PLANNING_RUN_V1_LINEAGE,
            );
            return transaction.run(
              SELECT.one.from(PersistedPlanningRuns).where({ ID: legacyV1Run.ID }),
            );
          }

          if (workflowRun.state === 'OPTIONS_READY') {
            const legacyV0Fingerprint = createLegacyPlanningFingerprintV0(context);
            const legacyV0Run = (await transaction.run(
              SELECT.one.from(PersistedPlanningRuns).where({
                tripRequest_ID: ID,
                requestFingerprint: legacyV0Fingerprint,
              }),
            )) as PersistedPlanningRun | undefined;
            if (legacyV0Run) {
              const legacyV0Options = (await transaction.run(
                SELECT.from(PersistedRankedOptions).where({ planningRun_ID: legacyV0Run.ID }),
              )) as PersistedRankedOptionLineage[];
              assertLegacyPlanningReplay(
                ID,
                workflowRun,
                legacyV0Run,
                legacyV0Fingerprint,
                legacyV0Options,
              );
              assertLegacyPlanningReplayDescendants(
                ID,
                workflowRun,
                legacyV0Run,
                legacyV0Options,
                await readReplayDescendants(legacyV0Run.ID),
                LEGACY_PLANNING_RUN_V0_LINEAGE,
              );
              return transaction.run(
                SELECT.one.from(PersistedPlanningRuns).where({ ID: legacyV0Run.ID }),
              );
            }
          }
        }

        if (workflowRun.state !== 'CONSTRAINTS_CONFIRMED') {
          throw new DomainError(
            workflowRun.state === 'SEARCHING'
              ? 'PLANNING_ALREADY_IN_PROGRESS'
              : 'PLANNING_STATE_INCONSISTENT',
            `Planowania nie można rozpocząć ze stanu ${workflowRun.state}.`,
          );
        }

        const startedAt = new Date().toISOString();
        const result = await runCandidateEngine({
          context,
          destinations: REFERENCE_DESTINATIONS,
          providers: this.createPlanningProviders(),
          providerManifest,
        });
        const bundle = buildPlanningPersistenceBundle({
          tripRequestId: ID,
          workflowRunId: workflowRun.ID,
          requestFingerprint,
          currencyContractVersion: versions.currencyContractVersion,
          offerPricingContractVersion: versions.offerPricingContractVersion,
          providerFixtureVersion: providerLineage.fixtureVersion,
          providerManifestVersion: providerLineage.manifestVersion,
          providerManifestFingerprint: providerLineage.manifestFingerprint,
          providerManifestJson: providerLineage.manifestJson,
          startedAt,
          completedAt: new Date().toISOString(),
          context,
          result,
        });

        await transaction.run(INSERT.into(PersistedPlanningRuns).entries(bundle.planningRun));
        if (bundle.providerExecutionRecords.length > 0) {
          await transaction.run(
            INSERT.into(PersistedProviderExecutionRecords).entries(
              ...bundle.providerExecutionRecords,
            ),
          );
        }
        if (bundle.rejectionReasons.length > 0) {
          await transaction.run(
            INSERT.into(PersistedRejectionReasons).entries(...bundle.rejectionReasons),
          );
        }
        if (bundle.rejectionSummaries.length > 0) {
          await transaction.run(
            INSERT.into(PersistedRejectionSummaries).entries(...bundle.rejectionSummaries),
          );
        }

        // Niedobór jest trwałym, kontrolowanym wynikiem. Nie zapisujemy nawet dwóch
        // częściowych kart i pozostawiamy WorkflowRun gotowy do świadomej zmiany briefu.
        if (bundle.planningRun.status === 'INSUFFICIENT_OPTIONS') {
          return transaction.run(
            SELECT.one.from(PersistedPlanningRuns).where({ ID: bundle.planningRun.ID }),
          );
        }

        if (bundle.rankedOptions.length !== 3 || bundle.workflowTransitions.length !== 3) {
          throw new DomainError(
            'INVALID_PLANNING_RESULT',
            'Udany wynik musi zawierać dokładnie trzy opcje i trzy przejścia workflow.',
          );
        }

        let workflowState = workflowRun.state;
        for (const targetState of ['SEARCHING', 'CANDIDATES_VALIDATED', 'OPTIONS_READY'] as const) {
          const nextState = transitionWorkflowState(workflowState, targetState);
          const updatedRows = (await transaction.run(
            UPDATE.entity(PersistedWorkflowRuns)
              .set({ state: nextState, errorCode: null, errorMessage: null })
              .where({ ID: workflowRun.ID, state: workflowState }),
          )) as number;
          if (updatedRows !== 1) {
            throw new DomainError(
              'PLANNING_STATE_INCONSISTENT',
              'WorkflowRun zmienił się podczas atomowego zapisu planowania.',
            );
          }
          workflowState = nextState;
        }
        await transaction.run(
          INSERT.into(PersistedWorkflowTransitions).entries(...bundle.workflowTransitions),
        );
        await transaction.run(INSERT.into(PersistedRankedOptions).entries(...bundle.rankedOptions));
        await transaction.run(
          INSERT.into(PersistedSourceSnapshots).entries(...bundle.sourceSnapshots),
        );
        await transaction.run(INSERT.into(PersistedBudgetItems).entries(...bundle.budgetItems));
        await transaction.run(
          INSERT.into(PersistedOfferChargeCollections).entries(...bundle.offerChargeCollections),
        );
        if (bundle.offerChargeDisclosures.length > 0) {
          await transaction.run(
            INSERT.into(PersistedOfferChargeDisclosures).entries(...bundle.offerChargeDisclosures),
          );
        }
        await transaction.run(INSERT.into(PersistedOptionNotes).entries(...bundle.optionNotes));

        return transaction.run(
          SELECT.one.from(PersistedPlanningRuns).where({ ID: bundle.planningRun.ID }),
        );
      } catch (error) {
        return rejectDomainError(request, error);
      }
    };

    this.on('startPlanning', (request: Request) => {
      const ID = String(request.params[0]?.ID ?? '');
      return this.runPlanningOnce(ID, request, () => executeStartPlanning(request, ID));
    });

    this.on('generateNarrative', async (request: Request) => {
      const rankedOptionId = String(request.params[0]?.ID ?? '');

      try {
        // The short read commits before either audited provider call. Confirmed constraints
        // remain in a separate envelope and do not mutate the frozen 3B2 grounded context.
        const { context, constraints } = await this.narrativeQualityReader.read(rankedOptionId);
        const modelView = buildNarrativeModelView(context);
        const generationView = buildNarrativeGenerationView(context, modelView);
        const versions = createNarrativeVersions(context.version);
        const gateway = this.createNarrativeGateway();
        const generateRequest = createOptionNarrativeRequest(context, modelView, generationView);
        const generateInputFingerprint = createInputFingerprint(generateRequest.input);

        let generateResult;
        try {
          generateResult = await gateway.call(generateRequest);
        } catch (error) {
          const generateAudit = createFailedReviewAudit(error, {
            planningRun_ID: context.planningRun.id,
            taskType: 'GENERATE',
            promptVersion: generateRequest.promptVersion,
            schemaVersion: generateRequest.schemaVersion,
            inputFingerprint: generateInputFingerprint,
          });
          // A STARTED write failure has no durable UUID to link. Every failure after durable
          // STARTED is recorded without prompt, context, candidate, provider payload or text.
          if (generateAudit !== undefined) {
            await this.narrativeReviewStore.persistRejection(
              buildNarrativeReviewRejectionBundle({
                planningRunId: context.planningRun.id,
                rankedOptionId: context.rankedOption.id,
                generateAudit,
                contextFingerprint: context.fingerprint,
                modelViewFingerprint: modelView.fingerprint,
                versions,
                stage: 'GENERATE',
                failureCode: narrativeReviewFailureCode(error, 'PROVIDER_ERROR'),
                completedAt: new Date().toISOString(),
              }),
            );
          }
          throw error;
        }

        const generateAudit = createSucceededReviewAudit({
          ID: generateResult.aiRunId,
          planningRunId: context.planningRun.id,
          taskType: 'GENERATE',
          promptVersion: generateRequest.promptVersion,
          schemaVersion: generateRequest.schemaVersion,
          inputFingerprint: generateResult.inputFingerprint,
        });
        const narrativeOutput = parseOptionNarrativeOutput(generateResult.output, context);
        const narrativeFingerprint = createNarrativeFingerprint(narrativeOutput);
        const precheck = runNarrativeSafetyPrecheck({
          context,
          modelView,
          generationView,
          narrativeOutput,
        });
        if (!precheck.passed) {
          await this.narrativeReviewStore.persistRejection(
            buildNarrativeReviewRejectionBundle({
              planningRunId: context.planningRun.id,
              rankedOptionId: context.rankedOption.id,
              generateAudit,
              contextFingerprint: context.fingerprint,
              modelViewFingerprint: modelView.fingerprint,
              narrativeFingerprint,
              versions,
              stage: 'PRECHECK',
              failureCode: 'PRECHECK_REJECTED',
              findings: precheck.findings.map((finding) => ({
                dimension: precheckFindingDimension(finding.reasonCode),
                reasonCode: finding.reasonCode,
                severity: finding.severity,
                blockSequences: [finding.blockSequence],
                factIds: [],
              })),
              completedAt: new Date().toISOString(),
            }),
          );
          throw narrativeQualityRejected();
        }

        let qualityContext;
        try {
          qualityContext = buildNarrativeQualityContext({
            context,
            modelView,
            narrativeOutput,
            constraints,
            versions,
          });
        } catch (error) {
          await this.narrativeReviewStore.persistRejection(
            buildNarrativeReviewRejectionBundle({
              planningRunId: context.planningRun.id,
              rankedOptionId: context.rankedOption.id,
              generateAudit,
              contextFingerprint: context.fingerprint,
              modelViewFingerprint: modelView.fingerprint,
              narrativeFingerprint,
              versions,
              stage: 'PRECHECK',
              failureCode: narrativeReviewFailureCode(error, 'INVALID_NARRATIVE_QUALITY_CONTEXT'),
              completedAt: new Date().toISOString(),
            }),
          );
          throw error;
        }

        const judgeRequest = createNarrativeJudgeRequest(qualityContext);
        const judgeInputFingerprint = createInputFingerprint(judgeRequest.input);
        let judgeResult;
        try {
          judgeResult = await gateway.call(judgeRequest);
        } catch (error) {
          const judgeAudit = createFailedReviewAudit(error, {
            planningRun_ID: context.planningRun.id,
            taskType: 'JUDGE',
            promptVersion: judgeRequest.promptVersion,
            schemaVersion: judgeRequest.schemaVersion,
            inputFingerprint: judgeInputFingerprint,
          });
          // A JUDGE attempt that never reached durable STARTED has no truthful judgeAiRunId.
          // Its closed operational signal is emitted by the gateway; do not create a review
          // row that would imply a durable judge audit or persist the in-memory candidate.
          if (judgeAudit !== undefined) {
            await this.narrativeReviewStore.persistRejection(
              buildNarrativeReviewRejectionBundle({
                planningRunId: context.planningRun.id,
                rankedOptionId: context.rankedOption.id,
                generateAudit,
                judgeAiRunId: judgeAudit.ID,
                judgeAudit,
                contextFingerprint: context.fingerprint,
                modelViewFingerprint: modelView.fingerprint,
                narrativeFingerprint,
                qualityContextFingerprint: qualityContext.fingerprint,
                versions,
                stage: 'JUDGE',
                failureCode: narrativeReviewFailureCode(error, 'PROVIDER_ERROR'),
                completedAt: new Date().toISOString(),
              }),
            );
          }
          throw error;
        }

        const judgeAudit = createSucceededReviewAudit({
          ID: judgeResult.aiRunId,
          planningRunId: context.planningRun.id,
          taskType: 'JUDGE',
          promptVersion: judgeRequest.promptVersion,
          schemaVersion: judgeRequest.schemaVersion,
          inputFingerprint: judgeResult.inputFingerprint,
        });
        let judgeOutput: NarrativeJudgeOutput;
        try {
          judgeOutput = parseNarrativeJudgeOutput(judgeResult.output, qualityContext);
        } catch (error) {
          await this.narrativeReviewStore.persistRejection(
            buildNarrativeReviewRejectionBundle({
              planningRunId: context.planningRun.id,
              rankedOptionId: context.rankedOption.id,
              generateAudit,
              judgeAiRunId: judgeAudit.ID,
              judgeAudit,
              contextFingerprint: context.fingerprint,
              modelViewFingerprint: modelView.fingerprint,
              narrativeFingerprint,
              qualityContextFingerprint: qualityContext.fingerprint,
              versions,
              stage: 'JUDGE',
              failureCode: 'INVALID_NARRATIVE_JUDGE_OUTPUT',
              completedAt: new Date().toISOString(),
            }),
          );
          throw error;
        }

        const dimensions = toNarrativeReviewDimensions(judgeOutput);
        if (decideNarrativePublication(judgeOutput) === 'REJECT') {
          await this.narrativeReviewStore.persistRejection(
            buildNarrativeReviewRejectionBundle({
              planningRunId: context.planningRun.id,
              rankedOptionId: context.rankedOption.id,
              generateAudit,
              judgeAiRunId: judgeAudit.ID,
              judgeAudit,
              contextFingerprint: context.fingerprint,
              modelViewFingerprint: modelView.fingerprint,
              narrativeFingerprint,
              qualityContextFingerprint: qualityContext.fingerprint,
              versions,
              stage: 'JUDGE',
              failureCode: 'SEMANTIC_REJECTED',
              dimensions,
              findings: judgeOutput.findings,
              completedAt: new Date().toISOString(),
            }),
          );
          throw narrativeQualityRejected();
        }

        // Candidate text is materialized only after the deterministic precheck and the
        // code-owned all-pass policy. These are the exact locally validated bytes judged above.
        const narrativeBundle = buildNarrativePersistenceBundle({
          context,
          modelView,
          generationView,
          output: narrativeOutput,
          aiRunId: generateResult.aiRunId,
          completedAt: new Date().toISOString(),
        });
        const publicationBundle = buildNarrativeReviewPublicationBundle({
          planningRunId: context.planningRun.id,
          rankedOptionId: context.rankedOption.id,
          generateAudit,
          judgeAiRunId: judgeAudit.ID,
          judgeAudit,
          contextFingerprint: context.fingerprint,
          modelViewFingerprint: modelView.fingerprint,
          narrativeFingerprint,
          qualityContextFingerprint: qualityContext.fingerprint,
          versions,
          dimensions,
          narrativeBundle,
          completedAt: new Date().toISOString(),
        });

        // If the request transaction is rolled back (including a late CAP after-handler
        // failure), persist only safe PRODUCT_WRITE_FAILED evidence after rollback completes.
        const productFailureBundle = buildNarrativeReviewRejectionBundle({
          planningRunId: context.planningRun.id,
          rankedOptionId: context.rankedOption.id,
          generateAudit,
          judgeAiRunId: judgeAudit.ID,
          judgeAudit,
          contextFingerprint: context.fingerprint,
          modelViewFingerprint: modelView.fingerprint,
          narrativeFingerprint,
          qualityContextFingerprint: qualityContext.fingerprint,
          versions,
          stage: 'JUDGE',
          failureCode: 'PRODUCT_WRITE_FAILED',
          completedAt: new Date().toISOString(),
        });
        request.on('failed', async () => {
          try {
            await this.narrativeReviewStore.persistRejection(productFailureBundle);
          } catch {
            // The request outcome is already failed. Never expose or log persistence causes.
          }
        });

        const productTransaction = cds.tx(request);
        await this.narrativeReviewWriter.writePublication(productTransaction, publicationBundle);
        return productTransaction.run(
          SELECT.one.from(NarrativeRuns).where({ ID: publicationBundle.narrativeRun.ID }),
        );
      } catch (error) {
        return rejectNarrativeError(request, error);
      }
    });

    await super.init();
  }
}
