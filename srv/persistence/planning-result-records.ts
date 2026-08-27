import { createHash, randomUUID } from 'node:crypto';
import type {
  BudgetCategoryAmounts,
  BudgetCategory,
  MachineReadableValue,
  PlanningContext,
  RankedOption,
  RejectionReason,
  ScoreBreakdown,
} from '../domain/candidate.ts';
import { DomainError } from '../domain/domain-error.ts';
import { isSupportedCurrencyContractVersion } from '../domain/currency.ts';
import { classifyMoney, type Money, type SourceSnapshot } from '../domain/money.ts';
import {
  OFFER_PRICING_CONTRACT_VERSION,
  offerPricingValidationIssues,
  type OfferChargeCollection,
} from '../domain/offer-pricing.ts';
import type { CandidateEngineResult } from '../orchestration/candidate-engine.ts';
import { PLANNING_REQUEST_FINGERPRINT_VERSION } from '../orchestration/planning-request.ts';
import {
  PROVIDER_FAILURE_CATEGORY_VALUES,
  PROVIDER_OPERATION_VALUES,
} from '../providers/provider-errors.ts';
import {
  DEFAULT_PROVIDER_EXECUTION_POLICY,
  PROVIDER_CALL_AUDIT_STATUS_VALUES,
  PROVIDER_EXECUTION_POLICY_VERSION,
  type ProviderCallAuditEvent,
} from '../providers/provider-execution.ts';
import { isSha256Fingerprint } from '../providers/provider-fingerprint.ts';
import { PROVIDER_MANIFEST_JSON_MAX_LENGTH } from '../providers/provider-manifest.ts';
import { canonicalSourceSnapshot, isCompleteSourceSnapshot } from '../providers/source-snapshot.ts';
import { SCORE_VERSION } from '../ranking/candidate-scoring.ts';

export interface PlanningPersistenceInput {
  tripRequestId: string;
  workflowRunId: string;
  requestFingerprint: string;
  currencyContractVersion: string;
  offerPricingContractVersion: string;
  providerFixtureVersion: string | null;
  providerManifestVersion: string;
  providerManifestFingerprint: string;
  providerManifestJson: string;
  startedAt: string;
  completedAt: string;
  context: PlanningContext;
  result: CandidateEngineResult;
}

export interface PlanningRunRecord {
  ID: string;
  tripRequest_ID: string;
  workflowRun_ID: string;
  requestFingerprint: string;
  requestFingerprintVersion: string;
  status: 'SUCCEEDED' | 'INSUFFICIENT_OPTIONS';
  currencyContractVersion: string;
  offerPricingContractVersion: string;
  providerFixtureVersion: string | null;
  providerManifestVersion: string;
  providerManifestFingerprint: string;
  providerManifestJson: string;
  engineVersion: string;
  scoringVersion: string;
  startedAt: string;
  completedAt: string;
  destinationCount: number;
  transportOptionCount: number;
  stayOptionCount: number;
  builtCandidateCount: number;
  validCandidateCount: number;
  rejectedCandidateCount: number;
  selectedOptionCount: number;
  errorCode: string | null;
  errorMessage: string | null;
}

export interface PlanningPersistenceBundle {
  planningRun: PlanningRunRecord;
  workflowTransitions: readonly Record<string, unknown>[];
  rankedOptions: readonly Record<string, unknown>[];
  sourceSnapshots: readonly Record<string, unknown>[];
  budgetItems: readonly Record<string, unknown>[];
  offerChargeCollections: readonly Record<string, unknown>[];
  offerChargeDisclosures: readonly Record<string, unknown>[];
  providerExecutionRecords: readonly Record<string, unknown>[];
  optionNotes: readonly Record<string, unknown>[];
  rejectionReasons: readonly Record<string, unknown>[];
  rejectionSummaries: readonly Record<string, unknown>[];
}

const BUDGET_ITEMS = [
  ['TRANSPORT', 'transport'],
  ['ACCOMMODATION', 'accommodation'],
  ['LOCAL_TRANSPORT', 'localTransport'],
  ['FOOD', 'food'],
  ['ATTRACTIONS', 'attractions'],
  ['ADDITIONAL_FEES', 'additionalFees'],
  ['BUFFER', 'buffer'],
] as const satisfies readonly (readonly [BudgetCategory, string])[];

const COMPONENT_LABELS = {
  budgetFit: 'dopasowanie do budżetu',
  travelTime: 'czas podróży',
  effectiveTimeAtDestination: 'efektywny czas na miejscu',
  accommodationLocation: 'lokalizacja noclegu',
  dataCompleteness: 'kompletność danych',
  priceConfidence: 'pewność ceny',
  deterministicPreferenceFit: 'dopasowanie preferencji',
} as const satisfies Record<
  Exclude<keyof ScoreBreakdown, 'scoreVersion' | 'total' | 'reasonCodes' | 'reasonTexts'>,
  string
>;

type ScoreComponentKey = keyof typeof COMPONENT_LABELS;

function scoringVersion(result: CandidateEngineResult): string {
  return (
    result.rankedCandidates[0]?.score.scoreVersion ?? `${SCORE_VERSION}:${result.configVersion}`
  );
}

function commonReferences(input: PlanningPersistenceInput, planningRunId: string) {
  return {
    tripRequest_ID: input.tripRequestId,
    workflowRun_ID: input.workflowRunId,
    planningRun_ID: planningRunId,
  };
}

function versionReferences(input: PlanningPersistenceInput, version: string) {
  return {
    providerFixtureVersion: input.providerFixtureVersion,
    providerManifestVersion: input.providerManifestVersion,
    providerManifestFingerprint: input.providerManifestFingerprint,
    scoringVersion: version,
  };
}

function requireKnownMinor(value: number | null, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new DomainError(
      'INVALID_FINAL_OPTION',
      `Finalny wariant nie ma poprawnej kwoty ${field} w minor units.`,
    );
  }
  return value;
}

function requireSourceKey(money: Money, field: string): string {
  const sourceKey = money.sourceSnapshot?.id;
  if (typeof sourceKey !== 'string' || sourceKey.trim().length === 0 || sourceKey.length > 500) {
    throw new DomainError(
      'INVALID_FINAL_OPTION',
      `Finalny wariant nie ma bezpiecznego SourceSnapshot dla ${field}.`,
    );
  }
  return sourceKey;
}

function requireCategoryAmounts(
  category: BudgetCategory,
  money: Money,
  amounts: BudgetCategoryAmounts | undefined,
): BudgetCategoryAmounts {
  if (amounts === undefined) {
    throw new DomainError(
      'INVALID_FINAL_OPTION',
      `Kategoria ${category} nie ma części confirmed/estimated.`,
    );
  }
  const values = [amounts.confirmedAmountMinor, amounts.estimatedAmountMinor];
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new DomainError(
      'INVALID_FINAL_OPTION',
      `Kategoria ${category} nie ma bezpiecznych części confirmed/estimated.`,
    );
  }
  const knownSubtotal = amounts.confirmedAmountMinor + amounts.estimatedAmountMinor;
  if (!Number.isSafeInteger(knownSubtotal)) {
    throw new DomainError(
      'INVALID_FINAL_OPTION',
      `Części kategorii ${category} przekraczają bezpieczny zakres minor units.`,
    );
  }
  if (money.amountMinor !== null && knownSubtotal !== money.amountMinor) {
    throw new DomainError(
      'INVALID_FINAL_OPTION',
      `Części kategorii ${category} nie sumują się do amountMinor.`,
    );
  }
  if (
    (money.priceType === 'LIVE_PRICE' || money.priceType === 'FIXED_PRICE') &&
    amounts.estimatedAmountMinor !== 0
  ) {
    throw new DomainError(
      'INVALID_FINAL_OPTION',
      `Potwierdzona kategoria ${category} zawiera część estimated.`,
    );
  }
  if (
    money.priceType === 'ESTIMATE' &&
    money.amountMinor > 0 &&
    amounts.estimatedAmountMinor === 0
  ) {
    throw new DomainError(
      'INVALID_FINAL_OPTION',
      `Estymowana kategoria ${category} nie zawiera części estimated.`,
    );
  }
  return amounts;
}

function serializeMachineValue(value: MachineReadableValue): string {
  return JSON.stringify(value);
}

function optionSourceSnapshots(option: RankedOption): readonly (SourceSnapshot | null)[] {
  const candidate = option.candidate;
  const offerMoneys = [
    candidate.transport.price,
    candidate.transport.additionalFees,
    candidate.transport.pricing.mandatoryTotal,
    ...candidate.transport.pricing.conditionalCharges.items.map((charge) => charge.amount),
    ...candidate.transport.pricing.optionalAncillaries.items.map((charge) => charge.amount),
    candidate.stay.price,
    candidate.stay.additionalFees,
    candidate.stay.pricing.mandatoryTotal,
    ...candidate.stay.pricing.conditionalCharges.items.map((charge) => charge.amount),
    ...candidate.stay.pricing.optionalAncillaries.items.map((charge) => charge.amount),
  ];
  const budgetMoneys = BUDGET_ITEMS.map(([, key]) => candidate.budget[key]);
  return [
    candidate.transport.sourceSnapshot,
    candidate.stay.sourceSnapshot,
    ...candidate.places.map((place) => place.sourceSnapshot),
    ...offerMoneys.map((money) => money.sourceSnapshot),
    ...budgetMoneys.map((money) => money.sourceSnapshot),
  ];
}

function assertRunScopedSourceIdentity(options: readonly RankedOption[]): void {
  const canonicalById = new Map<string, string>();
  for (const source of options.flatMap(optionSourceSnapshots)) {
    if (!isCompleteSourceSnapshot(source)) {
      throw new DomainError(
        'INVALID_FINAL_OPTION',
        'Finalny wynik zawiera niekompletny SourceSnapshot.',
      );
    }
    const canonical = canonicalSourceSnapshot(source);
    const existing = canonicalById.get(source.id);
    if (existing !== undefined && existing !== canonical) {
      throw new DomainError(
        'INVALID_FINAL_OPTION',
        'Finalny wariant zawiera kolizję identyfikatora SourceSnapshot.',
      );
    }
    canonicalById.set(source.id, canonical);
  }
}

function safeAuditIdentifier(value: unknown, maximum: number): boolean {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximum &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
  );
}

function safeAuditInstant(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?Z$/.exec(value);
  if (match === null || Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4]) > 59) {
    return false;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === match[1];
}

function assertProviderAuditEvent(event: ProviderCallAuditEvent, expectedSequence: number): void {
  const failureCategoryIsClosed =
    event.failureCategory === null ||
    PROVIDER_FAILURE_CATEGORY_VALUES.includes(event.failureCategory);
  const underlyingCategoryIsClosed =
    event.underlyingFailureCategory === null ||
    PROVIDER_FAILURE_CATEGORY_VALUES.includes(event.underlyingFailureCategory);
  const safeNullableInteger = (value: number | null): boolean =>
    value === null || (Number.isSafeInteger(value) && value >= 0);
  const rateLimitFields = [
    event.rateLimitRetryAfterMs,
    event.rateLimitLimit,
    event.rateLimitRemaining,
  ];
  const rateEvidenceAllowed =
    event.failureCategory === 'RATE_LIMITED' || event.underlyingFailureCategory === 'RATE_LIMITED';
  const commonValid =
    event.sequence === expectedSequence &&
    event.policyVersion === PROVIDER_EXECUTION_POLICY_VERSION &&
    safeAuditIdentifier(event.providerKey, 160) &&
    PROVIDER_OPERATION_VALUES.includes(event.operation) &&
    (event.destinationCode === null || safeAuditIdentifier(event.destinationCode, 12)) &&
    PROVIDER_CALL_AUDIT_STATUS_VALUES.includes(event.status) &&
    typeof event.providerCallAttempted === 'boolean' &&
    event.attempts === (event.providerCallAttempted ? 1 : 0) &&
    Number.isSafeInteger(event.latencyMs) &&
    event.latencyMs >= 0 &&
    (event.providerCallAttempted || event.latencyMs === 0) &&
    isSha256Fingerprint(event.queryFingerprint) &&
    failureCategoryIsClosed &&
    underlyingCategoryIsClosed &&
    (event.httpStatus === null ||
      (Number.isSafeInteger(event.httpStatus) &&
        event.httpStatus >= 100 &&
        event.httpStatus <= 599)) &&
    rateLimitFields.every(safeNullableInteger) &&
    (event.rateLimitResetAt === null || safeAuditInstant(event.rateLimitResetAt)) &&
    (rateEvidenceAllowed ||
      (rateLimitFields.every((value) => value === null) && event.rateLimitResetAt === null));
  const successValid =
    event.status === 'SUCCEEDED' &&
    event.providerCallAttempted &&
    event.resultFingerprint !== null &&
    isSha256Fingerprint(event.resultFingerprint) &&
    event.resultCount !== null &&
    Number.isSafeInteger(event.resultCount) &&
    event.resultCount >= 0 &&
    event.failureCategory === null &&
    event.underlyingFailureCategory === null &&
    event.httpStatus === null &&
    !rateEvidenceAllowed;
  const failureBaseValid =
    event.resultFingerprint === null &&
    event.resultCount === null &&
    event.failureCategory !== null;
  const failureValid =
    event.status === 'FAILED' &&
    failureBaseValid &&
    event.failureCategory !== 'CANCELLED' &&
    event.failureCategory !== 'CALL_BUDGET_EXCEEDED';
  const cancelledValid =
    event.status === 'CANCELLED' && failureBaseValid && event.failureCategory === 'CANCELLED';
  const blockedValid =
    event.status === 'BLOCKED' &&
    failureBaseValid &&
    !event.providerCallAttempted &&
    event.failureCategory === 'CALL_BUDGET_EXCEEDED';
  if (!commonValid || (!successValid && !failureValid && !cancelledValid && !blockedValid)) {
    throw new DomainError(
      'INVALID_PLANNING_RESULT',
      'Provider execution audit nie spełnia zamkniętego kontraktu persistence.',
    );
  }
}

/** Shared closed audit validator used before writes and during current-contract replay. */
export function assertProviderExecutionAudit(
  policyVersion: string,
  calls: readonly ProviderCallAuditEvent[],
): void {
  if (
    policyVersion !== PROVIDER_EXECUTION_POLICY_VERSION ||
    calls.length > DEFAULT_PROVIDER_EXECUTION_POLICY.maxCallsPerRun
  ) {
    throw new DomainError(
      'INVALID_PLANNING_RESULT',
      'Provider execution audit ma nieobsługiwaną wersję policy lub przekracza limit wywołań.',
    );
  }
  calls.forEach((event, index) => {
    if (event.policyVersion !== policyVersion) {
      throw new DomainError(
        'INVALID_PLANNING_RESULT',
        'Provider execution audit ma niespójną wersję policy.',
      );
    }
    assertProviderAuditEvent(event, index + 1);
  });
}

function optionNotes(
  input: PlanningPersistenceInput,
  planningRunId: string,
  rankedOptionId: string,
  option: RankedOption,
): readonly Record<string, unknown>[] {
  const scoreEntries = (Object.keys(COMPONENT_LABELS) as ScoreComponentKey[]).map((key) => ({
    key,
    value: option.score[key],
  }));
  const strongest = [...scoreEntries].sort(
    (left, right) => right.value - left.value || left.key.localeCompare(right.key, 'en'),
  )[0];
  const weakest = [...scoreEntries].sort(
    (left, right) => left.value - right.value || left.key.localeCompare(right.key, 'en'),
  )[0];
  if (!strongest || !weakest) {
    throw new DomainError('INVALID_FINAL_OPTION', 'Finalny wariant nie ma komponentów score.');
  }
  const providerSources = [
    option.candidate.transport.sourceSnapshot,
    option.candidate.stay.sourceSnapshot,
    ...option.candidate.places.map((place) => place.sourceSnapshot),
    option.candidate.transport.price.sourceSnapshot,
    option.candidate.transport.additionalFees.sourceSnapshot,
    option.candidate.transport.pricing.mandatoryTotal.sourceSnapshot,
    option.candidate.stay.price.sourceSnapshot,
    option.candidate.stay.additionalFees.sourceSnapshot,
    option.candidate.stay.pricing.mandatoryTotal.sourceSnapshot,
  ];
  const hasLiveSource = providerSources.some((source) => source?.sourceType === 'LIVE');
  const hasFixtureSource = providerSources.some((source) => source?.sourceType === 'FIXTURE');
  const dataRisk = hasLiveSource
    ? hasFixtureSource
      ? {
          code: 'MIXED_PROVIDER_DATA',
          text: 'Wariant łączy źródła live i jawnie oznaczone dane demonstracyjne.',
        }
      : {
          code: 'PROVIDER_OFFER_FRESHNESS',
          text: 'Dane providera odzwierciedlają zapisany moment pobrania i mogą wygasnąć.',
        }
    : {
        code: 'INTERNAL_FIXTURE_DATA',
        text: 'Oferty pochodzą z wersjonowanych danych demonstracyjnych, a nie z bieżącej dostępności.',
      };

  const roleText = {
    BEST_OVERALL: 'Najwyższy łączny score spośród poprawnych kandydatów.',
    MOST_CONVENIENT: 'Najlepszy deterministyczny profil wygody spośród pozostałych opcji.',
    BEST_VALUE: 'Najlepszy deterministyczny profil wartości spośród pozostałych opcji.',
  }[option.role];
  const notes = [
    {
      kind: 'ADVANTAGE',
      sequence: 1,
      code: option.role,
      text: roleText,
    },
    {
      kind: 'ADVANTAGE',
      sequence: 2,
      code: `STRONGEST_${strongest.key.toUpperCase()}`,
      text: `Najmocniejszy komponent to ${COMPONENT_LABELS[strongest.key]}: ${strongest.value.toFixed(2)}/100.`,
    },
    {
      kind: 'TRADEOFF',
      sequence: 1,
      code: `WEAKEST_${weakest.key.toUpperCase()}`,
      text: `Największy kompromis dotyczy komponentu ${COMPONENT_LABELS[weakest.key]}: ${weakest.value.toFixed(2)}/100.`,
    },
    {
      kind: 'TRADEOFF',
      sequence: 2,
      code: 'ESTIMATED_COSTS_INCLUDED',
      text: 'Całkowity koszt zawiera jawnie oznaczone estymacje kosztów lokalnych i bufora.',
    },
    {
      kind: 'RISK',
      sequence: 1,
      ...dataRisk,
    },
    {
      kind: 'RISK',
      sequence: 2,
      code: 'NO_BOOKING_GUARANTEE',
      text: 'Wariant nie jest rezerwacją i nie gwarantuje ceny ani dostępności.',
    },
  ] as const;

  return notes.map((note) => ({
    ID: randomUUID(),
    ...commonReferences(input, planningRunId),
    rankedOption_ID: rankedOptionId,
    ...note,
  }));
}

function recordsForOption(
  input: PlanningPersistenceInput,
  planningRunId: string,
  version: string,
  option: RankedOption,
): {
  rankedOption: Record<string, unknown>;
  sourceSnapshots: readonly Record<string, unknown>[];
  budgetItems: readonly Record<string, unknown>[];
  offerChargeCollections: readonly Record<string, unknown>[];
  offerChargeDisclosures: readonly Record<string, unknown>[];
  optionNotes: readonly Record<string, unknown>[];
} {
  const rankedOptionId = randomUUID();
  const candidate = option.candidate;
  const budget = candidate.budget;
  const references = commonReferences(input, planningRunId);
  const versions = versionReferences(input, version);
  const pricingIssues = [
    ...offerPricingValidationIssues(
      candidate.transport.price,
      candidate.transport.additionalFees,
      candidate.transport.pricing,
      'transport.pricing',
    ),
    ...offerPricingValidationIssues(
      candidate.stay.price,
      candidate.stay.additionalFees,
      candidate.stay.pricing,
      'stay.pricing',
    ),
  ];
  if (pricingIssues.length > 0) {
    throw new DomainError(
      'INVALID_FINAL_OPTION',
      'Finalny wariant ma niespójny kontrakt obowiązkowej ceny.',
    );
  }
  const rankedOption = {
    ID: rankedOptionId,
    ...references,
    ...versions,
    offerPricingContractVersion: input.offerPricingContractVersion,
    rank: option.rank,
    role: option.role,
    candidateId: candidate.id,
    destinationCode: candidate.destination.code,
    destinationCity: candidate.destination.city,
    destinationCountryCode: candidate.destination.countryCode,
    transportId: candidate.transport.id,
    transportMode: candidate.transport.mode,
    outboundDepartureAt: candidate.transport.outbound.departureAt,
    outboundArrivalAt: candidate.transport.outbound.arrivalAt,
    returnDepartureAt: candidate.transport.return.departureAt,
    returnArrivalAt: candidate.transport.return.arrivalAt,
    outboundTravelMinutes: candidate.transport.outbound.durationMinutes,
    returnTravelMinutes: candidate.transport.return.durationMinutes,
    maximumConnections: Math.max(
      candidate.transport.outbound.connections,
      candidate.transport.return.connections,
    ),
    effectiveTimeAtDestinationMinutes: candidate.effectiveTimeAtDestinationMinutes,
    stayId: candidate.stay.id,
    stayName: candidate.stay.name,
    checkInDate: candidate.stay.checkInDate,
    checkOutDate: candidate.stay.checkOutDate,
    nights: candidate.stay.nights,
    accommodationCentralityScore: candidate.stay.centralityScore,
    currency: input.context.currency,
    budgetLimitMinor: budget.budgetLimitMinor,
    confirmedAmountMinor: budget.confirmedAmountMinor,
    estimatedAmountMinor: budget.estimatedAmountMinor,
    unknownCategoryCount: budget.unknownCategories.length,
    totalAmountMinor: requireKnownMinor(budget.totalAmountMinor, 'totalAmountMinor'),
    costPerPersonMinor: requireKnownMinor(budget.costPerPersonMinor, 'costPerPersonMinor'),
    remainingBudgetMinor: requireKnownMinor(budget.remainingBudgetMinor, 'remainingBudgetMinor'),
    transportMandatoryTotalMinor: requireKnownMinor(
      candidate.transport.pricing.mandatoryTotal.amountMinor,
      'transportMandatoryTotalMinor',
    ),
    transportMandatoryTotalPriceType: candidate.transport.pricing.mandatoryTotal.priceType,
    transportMandatoryTotalClassification: classifyMoney(
      candidate.transport.pricing.mandatoryTotal,
    ),
    transportMandatoryTotalSourceKey: requireSourceKey(
      candidate.transport.pricing.mandatoryTotal,
      'transportMandatoryTotal',
    ),
    accommodationMandatoryTotalMinor: requireKnownMinor(
      candidate.stay.pricing.mandatoryTotal.amountMinor,
      'accommodationMandatoryTotalMinor',
    ),
    accommodationMandatoryTotalPriceType: candidate.stay.pricing.mandatoryTotal.priceType,
    accommodationMandatoryTotalClassification: classifyMoney(candidate.stay.pricing.mandatoryTotal),
    accommodationMandatoryTotalSourceKey: requireSourceKey(
      candidate.stay.pricing.mandatoryTotal,
      'accommodationMandatoryTotal',
    ),
    totalScore: option.score.total,
    budgetFitScore: option.score.budgetFit,
    travelTimeScore: option.score.travelTime,
    effectiveTimeScore: option.score.effectiveTimeAtDestination,
    accommodationLocationScore: option.score.accommodationLocation,
    dataCompletenessScore: option.score.dataCompleteness,
    priceConfidenceScore: option.score.priceConfidence,
    preferenceFitScore: option.score.deterministicPreferenceFit,
  };

  const sourceContexts = new Map<
    string,
    { source: SourceSnapshot; canonical: string; contexts: Set<string>; persistenceId: string }
  >();
  const addSource = (source: SourceSnapshot | null, context: string): void => {
    if (source === null) {
      throw new DomainError(
        'INVALID_FINAL_OPTION',
        `Finalny wariant nie ma wymaganego SourceSnapshot dla ${context}.`,
      );
    }
    const canonical = canonicalSourceSnapshot(source);
    const existing = sourceContexts.get(source.id);
    if (existing) {
      if (existing.canonical !== canonical) {
        throw new DomainError(
          'INVALID_FINAL_OPTION',
          'Finalny wariant zawiera kolizję identyfikatora SourceSnapshot.',
        );
      }
      existing.contexts.add(context);
      return;
    }
    sourceContexts.set(source.id, {
      source,
      canonical,
      contexts: new Set([context]),
      persistenceId: randomUUID(),
    });
  };

  addSource(candidate.transport.sourceSnapshot, 'TRANSPORT_FACT');
  addSource(candidate.stay.sourceSnapshot, 'ACCOMMODATION_FACT');
  addSource(candidate.transport.price.sourceSnapshot, 'OFFER_PRICE:TRANSPORT:SUBTOTAL');
  addSource(
    candidate.transport.additionalFees.sourceSnapshot,
    'OFFER_PRICE:TRANSPORT:MANDATORY_FEES',
  );
  addSource(
    candidate.transport.pricing.mandatoryTotal.sourceSnapshot,
    'OFFER_PRICE:TRANSPORT:MANDATORY_TOTAL',
  );
  addSource(
    candidate.stay.pricing.mandatoryTotal.sourceSnapshot,
    'OFFER_PRICE:ACCOMMODATION:MANDATORY_TOTAL',
  );
  addSource(candidate.stay.price.sourceSnapshot, 'OFFER_PRICE:ACCOMMODATION:SUBTOTAL');
  addSource(
    candidate.stay.additionalFees.sourceSnapshot,
    'OFFER_PRICE:ACCOMMODATION:MANDATORY_FEES',
  );
  for (const charge of candidate.transport.pricing.conditionalCharges.items) {
    addSource(charge.amount.sourceSnapshot, 'OFFER_CHARGE:TRANSPORT:CONDITIONAL');
  }
  for (const charge of candidate.transport.pricing.optionalAncillaries.items) {
    addSource(charge.amount.sourceSnapshot, 'OFFER_CHARGE:TRANSPORT:OPTIONAL');
  }
  for (const charge of candidate.stay.pricing.conditionalCharges.items) {
    addSource(charge.amount.sourceSnapshot, 'OFFER_CHARGE:ACCOMMODATION:CONDITIONAL');
  }
  for (const charge of candidate.stay.pricing.optionalAncillaries.items) {
    addSource(charge.amount.sourceSnapshot, 'OFFER_CHARGE:ACCOMMODATION:OPTIONAL');
  }
  for (const place of candidate.places) addSource(place.sourceSnapshot, 'PLACE_FACT');

  const budgetMoney = new Map<BudgetCategory, Money>();
  for (const [category, key] of BUDGET_ITEMS) {
    const money = budget[key as keyof typeof budget] as Money;
    budgetMoney.set(category, money);
    addSource(money.sourceSnapshot, `BUDGET:${category}`);
  }

  const sourceSnapshots = [...sourceContexts.values()]
    .sort((left, right) => left.source.id.localeCompare(right.source.id, 'en'))
    .map(({ source, contexts, persistenceId }) => {
      const serializedContexts = [...contexts]
        .sort((left, right) => left.localeCompare(right, 'en'))
        .join(', ');
      if (serializedContexts.length > 1_000) {
        throw new DomainError(
          'INVALID_FINAL_OPTION',
          'Finalny wariant przekracza limit bezpiecznych kontekstów SourceSnapshot.',
        );
      }
      return {
        ID: persistenceId,
        ...references,
        rankedOption_ID: rankedOptionId,
        ...versions,
        sourceKey: source.id,
        sourceContractVersion: source.contractVersion,
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
        freshnessType: source.freshnessType,
        currency: source.currency,
        fixtureVersion: source.fixtureVersion,
        contexts: serializedContexts,
        demonstrationData: source.sourceType !== 'LIVE',
      };
    });

  const budgetItems = BUDGET_ITEMS.map(([category]) => {
    const money = budgetMoney.get(category);
    if (!money) throw new DomainError('INVALID_FINAL_OPTION', `Brak kategorii ${category}.`);
    const sourceId =
      money.sourceSnapshot === null
        ? null
        : (sourceContexts.get(money.sourceSnapshot.id)?.persistenceId ?? null);
    const amounts = requireCategoryAmounts(category, money, budget.categoryAmounts[category]);
    return {
      ID: randomUUID(),
      ...references,
      rankedOption_ID: rankedOptionId,
      sourceSnapshot_ID: sourceId,
      ...versions,
      category,
      priceType: money.priceType,
      classification: classifyMoney(money),
      currency: money.currency,
      amountMinor: money.amountMinor,
      confirmedAmountMinor: amounts.confirmedAmountMinor,
      estimatedAmountMinor: amounts.estimatedAmountMinor,
    };
  });

  const chargeCollectionInputs: readonly {
    scope: 'TRANSPORT' | 'ACCOMMODATION';
    kind: 'CONDITIONAL' | 'OPTIONAL';
    collection: OfferChargeCollection;
  }[] = [
    {
      scope: 'TRANSPORT',
      kind: 'CONDITIONAL',
      collection: candidate.transport.pricing.conditionalCharges,
    },
    {
      scope: 'TRANSPORT',
      kind: 'OPTIONAL',
      collection: candidate.transport.pricing.optionalAncillaries,
    },
    {
      scope: 'ACCOMMODATION',
      kind: 'CONDITIONAL',
      collection: candidate.stay.pricing.conditionalCharges,
    },
    {
      scope: 'ACCOMMODATION',
      kind: 'OPTIONAL',
      collection: candidate.stay.pricing.optionalAncillaries,
    },
  ];
  const offerChargeCollections: Record<string, unknown>[] = [];
  const offerChargeDisclosures: Record<string, unknown>[] = [];
  for (const inputCollection of chargeCollectionInputs) {
    const collectionId = randomUUID();
    offerChargeCollections.push({
      ID: collectionId,
      ...references,
      rankedOption_ID: rankedOptionId,
      ...versions,
      offerPricingContractVersion: input.offerPricingContractVersion,
      scope: inputCollection.scope,
      kind: inputCollection.kind,
      completeness: inputCollection.collection.completeness,
      itemCount: inputCollection.collection.items.length,
    });
    for (const charge of inputCollection.collection.items) {
      const sourceId =
        charge.amount.sourceSnapshot === null
          ? null
          : (sourceContexts.get(charge.amount.sourceSnapshot.id)?.persistenceId ?? null);
      if (sourceId === null) {
        throw new DomainError(
          'INVALID_FINAL_OPTION',
          'Jawna opłata warunkowa lub opcjonalna nie ma bezpiecznego SourceSnapshot.',
        );
      }
      offerChargeDisclosures.push({
        ID: randomUUID(),
        ...references,
        rankedOption_ID: rankedOptionId,
        collection_ID: collectionId,
        sourceSnapshot_ID: sourceId,
        offerPricingContractVersion: input.offerPricingContractVersion,
        chargeId: charge.id,
        code: charge.code,
        priceType: charge.amount.priceType,
        classification: classifyMoney(charge.amount),
        currency: charge.amount.currency,
        amountMinor: charge.amount.amountMinor,
        includedInBudget: false,
      });
    }
  }

  return {
    rankedOption,
    sourceSnapshots,
    budgetItems,
    offerChargeCollections,
    offerChargeDisclosures,
    optionNotes: optionNotes(input, planningRunId, rankedOptionId, option),
  };
}

function rejectionRecords(
  input: PlanningPersistenceInput,
  planningRunId: string,
  version: string,
  reasons: readonly RejectionReason[],
): {
  details: readonly Record<string, unknown>[];
  summaries: readonly Record<string, unknown>[];
} {
  const references = commonReferences(input, planningRunId);
  const versions = versionReferences(input, version);
  const byCode = new Map<string, { occurrences: number; candidates: Set<string> }>();
  const details = reasons.map((reason) => {
    const candidateId = 'candidateId' in reason ? reason.candidateId : `option:${reason.optionId}`;
    const summary = byCode.get(reason.code) ?? { occurrences: 0, candidates: new Set<string>() };
    summary.occurrences += 1;
    summary.candidates.add(candidateId);
    byCode.set(reason.code, summary);
    return {
      ID: randomUUID(),
      ...references,
      ...versions,
      candidateId,
      code: reason.code,
      message: reason.message,
      expectedValue: serializeMachineValue(reason.expected),
      actualValue: serializeMachineValue(reason.actual),
      detailsJson: JSON.stringify(reason.details),
    };
  });
  const summaries = [...byCode.entries()]
    .sort(([left], [right]) => left.localeCompare(right, 'en'))
    .map(([code, summary]) => ({
      ID: randomUUID(),
      ...references,
      ...versions,
      code,
      candidateCount: summary.candidates.size,
      occurrenceCount: summary.occurrences,
    }));
  return { details, summaries };
}

/**
 * Materializuje wyłącznie znormalizowane rekordy domenowe. Przy niedoborze zwraca
 * pustą listę finalnych opcji, ale zachowuje kontrolowane diagnostyki odrzuceń.
 */
export function buildPlanningPersistenceBundle(
  input: PlanningPersistenceInput,
): PlanningPersistenceBundle {
  if (!isSupportedCurrencyContractVersion(input.currencyContractVersion)) {
    throw new DomainError(
      'INVALID_PLANNING_RESULT',
      'PlanningRun nie ma obsługiwanej wersji kontraktu walut.',
    );
  }
  if (input.offerPricingContractVersion !== OFFER_PRICING_CONTRACT_VERSION) {
    throw new DomainError(
      'INVALID_PLANNING_RESULT',
      'PlanningRun nie ma obsługiwanej wersji kontraktu ceny oferty.',
    );
  }
  const manifestFingerprint = createHash('sha256')
    .update(input.providerManifestJson, 'utf8')
    .digest('hex');
  if (
    input.providerManifestVersion.trim().length === 0 ||
    input.providerManifestJson.length > PROVIDER_MANIFEST_JSON_MAX_LENGTH ||
    !/^[a-f0-9]{64}$/.test(input.providerManifestFingerprint) ||
    manifestFingerprint !== input.providerManifestFingerprint
  ) {
    throw new DomainError(
      'INVALID_PLANNING_RESULT',
      'PlanningRun nie ma spójnego, bezpiecznego provider manifestu.',
    );
  }
  const planningRunId = randomUUID();
  const version = scoringVersion(input.result);
  const shortage = input.result.shortage;
  const succeeded = shortage === null && input.result.options.length === 3;
  if (!succeeded && shortage === null) {
    throw new DomainError(
      'INVALID_PLANNING_RESULT',
      'Silnik nie zwrócił ani trzech opcji, ani kontrolowanego niedoboru.',
    );
  }

  if (succeeded) assertRunScopedSourceIdentity(input.result.options);
  const optionRecords = succeeded
    ? input.result.options.map((option) => recordsForOption(input, planningRunId, version, option))
    : [];
  const rejections = rejectionRecords(input, planningRunId, version, input.result.rejectionReasons);
  const planningRun: PlanningRunRecord = {
    ID: planningRunId,
    tripRequest_ID: input.tripRequestId,
    workflowRun_ID: input.workflowRunId,
    requestFingerprint: input.requestFingerprint,
    requestFingerprintVersion: PLANNING_REQUEST_FINGERPRINT_VERSION,
    status: succeeded ? 'SUCCEEDED' : 'INSUFFICIENT_OPTIONS',
    currencyContractVersion: input.currencyContractVersion,
    providerFixtureVersion: input.providerFixtureVersion,
    providerManifestVersion: input.providerManifestVersion,
    providerManifestFingerprint: input.providerManifestFingerprint,
    providerManifestJson: input.providerManifestJson,
    offerPricingContractVersion: input.offerPricingContractVersion,
    engineVersion: input.result.configVersion,
    scoringVersion: version,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    destinationCount: input.result.counts.destinations,
    transportOptionCount: input.result.counts.transportOptions,
    stayOptionCount: input.result.counts.stayOptions,
    builtCandidateCount: input.result.counts.builtCandidates,
    validCandidateCount: input.result.counts.validCandidates,
    rejectedCandidateCount: input.result.counts.rejectedCandidates,
    selectedOptionCount: succeeded ? 3 : 0,
    errorCode: succeeded ? null : (shortage?.code ?? 'INSUFFICIENT_VALID_CANDIDATES'),
    errorMessage: succeeded ? null : (shortage?.message ?? 'Brak trzech poprawnych wariantów.'),
  };
  const references = commonReferences(input, planningRunId);
  assertProviderExecutionAudit(
    input.result.providerExecution.policyVersion,
    input.result.providerExecution.calls,
  );
  const providerExecutionRecords = input.result.providerExecution.calls.map((event) => {
    return {
      ID: randomUUID(),
      ...references,
      sequence: event.sequence,
      providerManifestVersion: input.providerManifestVersion,
      providerManifestFingerprint: input.providerManifestFingerprint,
      policyVersion: event.policyVersion,
      providerKey: event.providerKey,
      operation: event.operation,
      destinationCode: event.destinationCode,
      status: event.status,
      providerCallAttempted: event.providerCallAttempted,
      attempts: event.attempts,
      latencyMs: event.latencyMs,
      queryFingerprint: event.queryFingerprint,
      resultFingerprint: event.resultFingerprint,
      resultCount: event.resultCount,
      failureCategory: event.failureCategory,
      underlyingFailureCategory: event.underlyingFailureCategory,
      httpStatus: event.httpStatus,
      rateLimitRetryAfterMs: event.rateLimitRetryAfterMs,
      rateLimitLimit: event.rateLimitLimit,
      rateLimitRemaining: event.rateLimitRemaining,
      rateLimitResetAt: event.rateLimitResetAt,
    };
  });
  const workflowTransitions = succeeded
    ? [
        ['CONSTRAINTS_CONFIRMED', 'SEARCHING'],
        ['SEARCHING', 'CANDIDATES_VALIDATED'],
        ['CANDIDATES_VALIDATED', 'OPTIONS_READY'],
      ].map(([fromState, toState], index) => ({
        ID: randomUUID(),
        ...references,
        sequence: index + 1,
        fromState,
        toState,
      }))
    : [];

  return {
    planningRun,
    workflowTransitions,
    rankedOptions: optionRecords.map((records) => records.rankedOption),
    sourceSnapshots: optionRecords.flatMap((records) => records.sourceSnapshots),
    budgetItems: optionRecords.flatMap((records) => records.budgetItems),
    offerChargeCollections: optionRecords.flatMap((records) => records.offerChargeCollections),
    offerChargeDisclosures: optionRecords.flatMap((records) => records.offerChargeDisclosures),
    providerExecutionRecords,
    optionNotes: optionRecords.flatMap((records) => records.optionNotes),
    rejectionReasons: rejections.details,
    rejectionSummaries: rejections.summaries,
  };
}
