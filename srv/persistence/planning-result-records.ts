import { randomUUID } from 'node:crypto';
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
import type { CandidateEngineResult } from '../orchestration/candidate-engine.ts';
import { SCORE_VERSION } from '../ranking/candidate-scoring.ts';

export interface PlanningPersistenceInput {
  tripRequestId: string;
  workflowRunId: string;
  requestFingerprint: string;
  currencyContractVersion: string;
  providerFixtureVersion: string;
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
  status: 'SUCCEEDED' | 'INSUFFICIENT_OPTIONS';
  currencyContractVersion: string;
  providerFixtureVersion: string;
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
      code: 'INTERNAL_FIXTURE_DATA',
      text: 'Oferty pochodzą z wersjonowanych danych demonstracyjnych, a nie z bieżącej dostępności.',
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
  optionNotes: readonly Record<string, unknown>[];
} {
  const rankedOptionId = randomUUID();
  const candidate = option.candidate;
  const budget = candidate.budget;
  const references = commonReferences(input, planningRunId);
  const versions = versionReferences(input, version);
  const rankedOption = {
    ID: rankedOptionId,
    ...references,
    ...versions,
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
    { source: SourceSnapshot; contexts: Set<string>; persistenceId: string }
  >();
  const addSource = (source: SourceSnapshot | null, context: string): void => {
    if (source === null) {
      throw new DomainError(
        'INVALID_FINAL_OPTION',
        `Finalny wariant nie ma wymaganego SourceSnapshot dla ${context}.`,
      );
    }
    const existing = sourceContexts.get(source.id);
    if (existing) {
      existing.contexts.add(context);
      return;
    }
    sourceContexts.set(source.id, {
      source,
      contexts: new Set([context]),
      persistenceId: randomUUID(),
    });
  };

  addSource(candidate.transport.sourceSnapshot, 'TRANSPORT_FACT');
  addSource(candidate.stay.sourceSnapshot, 'ACCOMMODATION_FACT');
  for (const place of candidate.places) addSource(place.sourceSnapshot, `PLACE:${place.id}`);

  const budgetMoney = new Map<BudgetCategory, Money>();
  for (const [category, key] of BUDGET_ITEMS) {
    const money = budget[key as keyof typeof budget] as Money;
    budgetMoney.set(category, money);
    addSource(money.sourceSnapshot, `BUDGET:${category}`);
  }

  const sourceSnapshots = [...sourceContexts.values()]
    .sort((left, right) => left.source.id.localeCompare(right.source.id, 'en'))
    .map(({ source, contexts, persistenceId }) => ({
      ID: persistenceId,
      ...references,
      rankedOption_ID: rankedOptionId,
      ...versions,
      sourceKey: source.id,
      provider: source.provider,
      externalItemId: source.externalItemId,
      fetchedAt: source.fetchedAt,
      sourceUrl: source.sourceUrl,
      freshnessType: source.freshnessType,
      currency: source.currency,
      fixtureVersion: source.fixtureVersion,
      contexts: [...contexts].sort((left, right) => left.localeCompare(right, 'en')).join(', '),
      demonstrationData:
        source.sourceUrl === 'INTERNAL_FIXTURE' || source.freshnessType === 'FIXTURE',
    }));

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

  return {
    rankedOption,
    sourceSnapshots,
    budgetItems,
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

  const optionRecords = succeeded
    ? input.result.options.map((option) => recordsForOption(input, planningRunId, version, option))
    : [];
  const rejections = rejectionRecords(input, planningRunId, version, input.result.rejectionReasons);
  const planningRun: PlanningRunRecord = {
    ID: planningRunId,
    tripRequest_ID: input.tripRequestId,
    workflowRun_ID: input.workflowRunId,
    requestFingerprint: input.requestFingerprint,
    status: succeeded ? 'SUCCEEDED' : 'INSUFFICIENT_OPTIONS',
    currencyContractVersion: input.currencyContractVersion,
    providerFixtureVersion: input.providerFixtureVersion,
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
    optionNotes: optionRecords.flatMap((records) => records.optionNotes),
    rejectionReasons: rejections.details,
    rejectionSummaries: rejections.summaries,
  };
}
