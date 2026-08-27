import type {
  Destination,
  Place,
  PlanningContext,
  RankedOption,
  RejectionReason,
  StayOption,
  TransportOption,
  TripCandidate,
} from '../domain/candidate.ts';
import { TRANSPORT_MODE_VALUES } from '../domain/candidate.ts';
import { isSupportedCurrency } from '../domain/currency.ts';
import { DomainError } from '../domain/domain-error.ts';
import { moneyValidationIssues, type Money, type SourceSnapshot } from '../domain/money.ts';
import { offerPricingValidationIssues } from '../domain/offer-pricing.ts';
import { PACE_VALUES, SOFT_PREFERENCE_KEYS } from '../domain/trip-request.ts';
import type {
  AccommodationProvider,
  PlacesProvider,
  TransportProvider,
} from '../providers/contracts.ts';
import {
  ProviderExecutionScope,
  type ProviderCallAuditEvent,
  type ProviderCallDescriptor,
  type ProviderCallOptions,
} from '../providers/provider-execution.ts';
import {
  providerEntry,
  providerManifestLineage,
  type ProviderConfigurationManifest,
  type ProviderManifestEntry,
} from '../providers/provider-manifest.ts';
import {
  createProviderFingerprint,
  isSha256Fingerprint,
  type ProviderJsonValue,
} from '../providers/provider-fingerprint.ts';
import {
  placeResultView,
  stayResultView,
  transportResultView,
} from '../providers/normalized-result.ts';
import {
  createSourceSnapshotResultFingerprint,
  isCompleteSourceSnapshot,
} from '../providers/source-snapshot.ts';
import { buildCandidates, type CandidateBuilderResult } from '../ranking/candidate-builder.ts';
import { filterCandidates, type CandidateValidationResult } from '../ranking/candidate-filter.ts';
import { rankCandidates, type ScoredCandidate } from '../ranking/candidate-scoring.ts';
import { selectDiverseOptions, type CandidateShortage } from '../ranking/candidate-selection.ts';
import {
  mergeCandidateEngineConfig,
  type CandidateEngineConfigOverride,
} from '../ranking/config.ts';
import { validateHardConstraints } from '../validation/hard-constraints-validation.ts';
import { validateSoftPreferences } from '../validation/soft-preferences-validation.ts';
import { parseStrictIsoDate } from '../validation/strict-iso-date.ts';

export interface CandidateEngineProviders {
  transport: TransportProvider;
  accommodation: AccommodationProvider;
  places: PlacesProvider;
}

export interface CandidateEngineInput {
  context: PlanningContext;
  destinations: readonly Destination[];
  providers: CandidateEngineProviders;
  providerManifest: ProviderConfigurationManifest;
  signal?: AbortSignal;
  config?: CandidateEngineConfigOverride;
}

export interface CandidateEngineCounts {
  destinations: number;
  transportOptions: number;
  stayOptions: number;
  builtCandidates: number;
  validCandidates: number;
  rejectedCandidates: number;
}

export interface CandidateEngineResult {
  configVersion: string;
  counts: CandidateEngineCounts;
  candidates: readonly TripCandidate[];
  validCandidates: readonly TripCandidate[];
  rejectedCandidates: readonly CandidateValidationResult[];
  rejectionReasons: readonly RejectionReason[];
  rankedCandidates: readonly ScoredCandidate[];
  options: readonly RankedOption[];
  shortage: CandidateShortage | null;
  providerExecution: {
    policyVersion: string;
    calls: readonly ProviderCallAuditEvent[];
  };
}

/** Providerzy nie są wywoływani dla niepoprawnego briefu wykonawczego. */
export function assertPlanningContext(context: PlanningContext): void {
  const start = parseStrictIsoDate(context.startDate);
  const end = parseStrictIsoDate(context.endDate);
  const valid =
    context.tripRequestId.trim().length > 0 &&
    context.originCity.trim().length > 0 &&
    Number.isSafeInteger(context.adults) &&
    context.adults > 0 &&
    Number.isSafeInteger(context.totalBudgetMinor) &&
    context.totalBudgetMinor > 0 &&
    isSupportedCurrency(context.currency) &&
    start !== null &&
    end !== null &&
    end > start &&
    PACE_VALUES.some((pace) => pace === context.pace);
  if (!valid) {
    throw new DomainError(
      'INVALID_PLANNING_CONTEXT',
      'Brief wykonawczy ma niepoprawne osoby, budżet, walutę, identyfikator lub daty.',
    );
  }
  validateHardConstraints(context.hardConstraints);
  validateSoftPreferences(context.softPreferences);
}

function stableDestinations(
  destinations: readonly Destination[],
  maximum: number,
): readonly Destination[] {
  if (
    destinations.some(
      (destination) =>
        !destination.code.trim() || !destination.city.trim() || !destination.countryCode.trim(),
    )
  ) {
    throw new DomainError(
      'INVALID_DESTINATION',
      'Każda destynacja musi mieć niepusty kod, miasto i kod kraju.',
    );
  }
  const unique = new Map<string, Destination>();
  for (const destination of [...destinations].sort(
    (left, right) =>
      left.code.localeCompare(right.code, 'en') ||
      left.city.localeCompare(right.city, 'en') ||
      left.countryCode.localeCompare(right.countryCode, 'en'),
  )) {
    if (!unique.has(destination.code)) unique.set(destination.code, destination);
  }
  return [...unique.values()].slice(0, maximum);
}

function offerMoneys(offer: TransportOption | StayOption): readonly Money[] {
  return [
    offer.price,
    offer.additionalFees,
    offer.pricing.mandatoryTotal,
    ...offer.pricing.conditionalCharges.items.map((charge) => charge.amount),
    ...offer.pricing.optionalAncillaries.items.map((charge) => charge.amount),
  ];
}

function offerSources(offer: TransportOption | StayOption): readonly (SourceSnapshot | null)[] {
  return [offer.sourceSnapshot, ...offerMoneys(offer).map((money) => money.sourceSnapshot)];
}

const PROVIDER_MANIFEST_ENTRY_KEYS = [
  'adapterId',
  'adapterVersion',
  'fixtureVersion',
  'mode',
  'providerKey',
  'providerName',
  'providerVersion',
  'role',
  'searchPolicyVersion',
  'sourceContractVersion',
  'upstreamApiVersion',
  'upstreamSchemaFingerprint',
  'upstreamSchemaVersion',
] as const;

function assertProviderBinding(
  provider: TransportProvider | AccommodationProvider | PlacesProvider,
  configuredEntry: ProviderManifestEntry,
): void {
  const runtimeEntry = provider.manifestEntry;
  // Fixture-only inline doubles are retained for deterministic unit tests. A live adapter must
  // always bind its identity independently of whether the upstream result contains any rows.
  if (runtimeEntry === undefined) {
    if (configuredEntry.mode === 'LIVE') throw new TypeError('Live provider identity is missing.');
    return;
  }
  const runtimeKeys = Object.keys(runtimeEntry).sort((left, right) =>
    left.localeCompare(right, 'en'),
  );
  const expectedKeys = [...PROVIDER_MANIFEST_ENTRY_KEYS].sort((left, right) =>
    left.localeCompare(right, 'en'),
  );
  if (
    runtimeKeys.length !== expectedKeys.length ||
    runtimeKeys.some((key, index) => key !== expectedKeys[index]) ||
    PROVIDER_MANIFEST_ENTRY_KEYS.some((key) => runtimeEntry[key] !== configuredEntry[key])
  ) {
    throw new TypeError('Runtime provider identity does not match the configured manifest.');
  }
}

function exactObjectKeys(value: unknown, expected: readonly string[]): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort((left, right) => left.localeCompare(right, 'en'));
  const sortedExpected = [...expected].sort((left, right) => left.localeCompare(right, 'en'));
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function safeProviderText(value: unknown, maximum: number): value is string {
  const containsControlCharacter = (text: string): boolean =>
    [...text].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || (codePoint >= 127 && codePoint <= 159);
    });
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= maximum &&
    !containsControlCharacter(value)
  );
}

function strictProviderInstant(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match =
    /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (
    match === null ||
    parseStrictIsoDate(match[1] ?? '') === null ||
    Number(match[2]) > 23 ||
    Number(match[3]) > 59 ||
    Number(match[4]) > 59
  ) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function liveTransportShape(value: TransportOption): boolean {
  if (
    !exactObjectKeys(value, [
      'additionalFees',
      'destinationCode',
      'id',
      'mode',
      'outbound',
      'price',
      'pricing',
      'return',
      'sourceSnapshot',
    ]) ||
    !safeProviderText(value.id, 200) ||
    !safeProviderText(value.destinationCode, 12) ||
    !TRANSPORT_MODE_VALUES.includes(value.mode)
  ) {
    return false;
  }
  const validLeg = (leg: TransportOption['outbound']): boolean =>
    exactObjectKeys(leg, ['arrivalAt', 'connections', 'departureAt', 'durationMinutes']) &&
    strictProviderInstant(leg.departureAt) !== null &&
    strictProviderInstant(leg.arrivalAt) !== null &&
    Number.isSafeInteger(leg.durationMinutes) &&
    leg.durationMinutes > 0 &&
    Number.isSafeInteger(leg.connections) &&
    leg.connections >= 0;
  return (
    validLeg(value.outbound) &&
    validLeg(value.return) &&
    offerPricingValidationIssues(value.price, value.additionalFees, value.pricing, 'pricing')
      .length === 0
  );
}

function liveStayShape(value: StayOption): boolean {
  return (
    exactObjectKeys(value, [
      'additionalFees',
      'centralityScore',
      'checkInDate',
      'checkOutDate',
      'destinationCode',
      'id',
      'name',
      'nights',
      'price',
      'pricing',
      'sourceSnapshot',
    ]) &&
    safeProviderText(value.id, 200) &&
    safeProviderText(value.destinationCode, 12) &&
    safeProviderText(value.name, 200) &&
    parseStrictIsoDate(value.checkInDate) !== null &&
    parseStrictIsoDate(value.checkOutDate) !== null &&
    Number.isSafeInteger(value.nights) &&
    value.nights > 0 &&
    Number.isFinite(value.centralityScore) &&
    value.centralityScore >= 0 &&
    value.centralityScore <= 100 &&
    offerPricingValidationIssues(value.price, value.additionalFees, value.pricing, 'pricing')
      .length === 0
  );
}

function livePlaceShape(value: Place): boolean {
  return (
    exactObjectKeys(value, [
      'destinationCode',
      'id',
      'name',
      'preferenceScores',
      'sourceSnapshot',
    ]) &&
    safeProviderText(value.id, 200) &&
    safeProviderText(value.destinationCode, 12) &&
    safeProviderText(value.name, 200) &&
    exactObjectKeys(value.preferenceScores, SOFT_PREFERENCE_KEYS) &&
    SOFT_PREFERENCE_KEYS.every((key) => {
      const score = value.preferenceScores[key];
      return Number.isFinite(score) && score >= 0 && score <= 100;
    })
  );
}

function providerResultFingerprint<T extends { id: string }>(
  values: readonly T[],
  entry: ProviderManifestEntry,
  queryFingerprint: string,
  sourceSnapshots: (value: T) => readonly (SourceSnapshot | null)[],
  normalizedResult: (value: T) => ProviderJsonValue,
  moneyValues: (value: T) => readonly Money[] = () => [],
  liveShape: (value: T) => boolean = () => true,
): string {
  if (!Array.isArray(values)) {
    throw new TypeError('Provider result failed the local array schema.');
  }
  if (entry.mode === 'LIVE' && values.some((value) => !liveShape(value))) {
    throw new TypeError('Provider result failed the local DTO schema.');
  }
  const normalizedResults = values.map((value) => normalizedResult(value));
  const mappedMoneys = values.flatMap((value) => moneyValues(value));
  if (mappedMoneys.some((money) => moneyValidationIssues(money, 'provider.money').length > 0)) {
    throw new TypeError('Provider result failed the local money schema.');
  }
  const exactConfiguredLineage = (sourceSnapshot: SourceSnapshot): boolean =>
    sourceSnapshot.provider === entry.providerName &&
    sourceSnapshot.adapterVersion === entry.adapterVersion &&
    sourceSnapshot.providerVersion === entry.providerVersion &&
    sourceSnapshot.upstreamApiVersion === entry.upstreamApiVersion &&
    sourceSnapshot.upstreamSchemaFingerprint === entry.upstreamSchemaFingerprint &&
    sourceSnapshot.fixtureVersion === entry.fixtureVersion &&
    sourceSnapshot.contractVersion === entry.sourceContractVersion;
  if (entry.mode === 'FIXTURE') {
    // The frozen reference fixture deliberately contains malformed rows used to exercise every
    // hard-filter code. Complete rows still have to match the configured fixture lineage; null
    // or deliberately malformed rows continue to the candidate filter unchanged.
    if (
      values.some((value, index) =>
        sourceSnapshots(value).some(
          (sourceSnapshot) =>
            isCompleteSourceSnapshot(sourceSnapshot) &&
            (sourceSnapshot.sourceType !== 'FIXTURE' ||
              !exactConfiguredLineage(sourceSnapshot) ||
              sourceSnapshot.resultFingerprint !==
                createSourceSnapshotResultFingerprint(sourceSnapshot, normalizedResults[index]!)),
        ),
      )
    ) {
      throw new TypeError('Fixture result failed the local manifest/source lineage contract.');
    }
    return createProviderFingerprint(
      values.map((value, index) => ({
        normalizedResult: normalizedResults[index]!,
        sourceResultFingerprints: sourceSnapshots(value).map(
          (source) => source?.resultFingerprint ?? null,
        ),
      })),
    );
  }
  const lineageIsExact = values.every((value, index) =>
    sourceSnapshots(value).every((sourceSnapshot) => {
      if (!isCompleteSourceSnapshot(sourceSnapshot)) return false;
      return (
        sourceSnapshot.sourceType === 'LIVE' &&
        exactConfiguredLineage(sourceSnapshot) &&
        sourceSnapshot.queryFingerprint === queryFingerprint &&
        sourceSnapshot.fixtureVersion === null &&
        sourceSnapshot.resultFingerprint ===
          createSourceSnapshotResultFingerprint(sourceSnapshot, normalizedResults[index]!)
      );
    }),
  );
  if (!lineageIsExact) {
    throw new TypeError('Provider result failed the local manifest/source lineage contract.');
  }
  return createProviderFingerprint(
    values.map((value, index) => ({
      normalizedResult: normalizedResults[index]!,
      sourceResultFingerprints: sourceSnapshots(value).map(
        (source) => source?.resultFingerprint ?? null,
      ),
    })),
  );
}

function providerSearchFailed(): DomainError {
  return new DomainError('PROVIDER_SEARCH_FAILED', 'Nie udało się pobrać danych do planowania.');
}

async function executeProviderSearch<T>(
  execution: ProviderExecutionScope,
  entry: ProviderManifestEntry,
  descriptor: ProviderCallDescriptor<T>,
  invoke: (options: ProviderCallOptions) => Promise<T>,
): Promise<T> {
  if (entry.mode === 'FIXTURE') {
    return execution.execute(descriptor, ({ signal }) =>
      invoke({
        signal,
        executeUpstream: async () => {
          throw new TypeError('Fixture adapters cannot create nested upstream calls.');
        },
      }),
    );
  }

  let upstreamCallCount = 0;
  const result = await invoke({
    signal: execution.signal,
    executeUpstream: (upstreamDescriptor, upstreamInvoke) => {
      upstreamCallCount += 1;
      return execution.execute(
        {
          providerKey: descriptor.providerKey,
          operation: descriptor.operation,
          ...(descriptor.destinationCode === undefined
            ? {}
            : { destinationCode: descriptor.destinationCode }),
          ...upstreamDescriptor,
        },
        upstreamInvoke,
      );
    },
  });
  if (upstreamCallCount === 0) {
    throw new TypeError('Live adapter completed without the run-scoped upstream executor.');
  }
  const resultFingerprint = descriptor.resultFingerprint(result);
  const resultCount = descriptor.resultCount(result);
  if (
    !isSha256Fingerprint(resultFingerprint) ||
    !Number.isSafeInteger(resultCount) ||
    resultCount < 0
  ) {
    throw new TypeError('Live adapter result failed aggregate validation.');
  }
  return result;
}

function assertSelectedFixtureQueryLineage(
  candidates: readonly TripCandidate[],
  entries: {
    transport: ProviderManifestEntry;
    accommodation: ProviderManifestEntry;
    places: ProviderManifestEntry;
  },
  queries: {
    transport: string;
    accommodation: ReadonlyMap<string, string>;
    places: ReadonlyMap<string, string>;
  },
): void {
  const exactQuery = (
    sources: readonly (SourceSnapshot | null)[],
    entry: ProviderManifestEntry,
    expectedQuery: string | undefined,
  ): boolean =>
    entry.mode !== 'FIXTURE' ||
    (expectedQuery !== undefined &&
      sources.every(
        (source) =>
          isCompleteSourceSnapshot(source) &&
          source.sourceType === 'FIXTURE' &&
          source.queryFingerprint === expectedQuery,
      ));
  for (const candidate of candidates) {
    if (
      !exactQuery(offerSources(candidate.transport), entries.transport, queries.transport) ||
      !exactQuery(
        offerSources(candidate.stay),
        entries.accommodation,
        queries.accommodation.get(candidate.destination.code),
      ) ||
      !exactQuery(
        candidate.places.map((place) => place.sourceSnapshot),
        entries.places,
        queries.places.get(candidate.destination.code),
      )
    ) {
      throw new TypeError('Selected fixture result does not match the executed query.');
    }
  }
}

/** Wykonuje ograniczony pipeline provider → build → hard filter → score → diversity. */
export async function runCandidateEngine(
  input: CandidateEngineInput,
): Promise<CandidateEngineResult> {
  assertPlanningContext(input.context);
  const config = mergeCandidateEngineConfig(input.config);
  const destinations = stableDestinations(input.destinations, config.limits.maxDestinations);
  const providerRequest = {
    startDate: input.context.startDate,
    endDate: input.context.endDate,
    adults: input.context.adults,
    currency: input.context.currency,
  };
  let execution: ProviderExecutionScope | undefined;
  let transportEntry: ProviderManifestEntry;
  let accommodationEntry: ProviderManifestEntry;
  let placesEntry: ProviderManifestEntry;
  try {
    providerManifestLineage(input.providerManifest);
    execution = new ProviderExecutionScope({
      policy: input.providerManifest.executionPolicy,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    execution.assertCallBudget(1 + destinations.length * 2);
    transportEntry = providerEntry(input.providerManifest, 'TRANSPORT');
    accommodationEntry = providerEntry(input.providerManifest, 'ACCOMMODATION');
    placesEntry = providerEntry(input.providerManifest, 'PLACES');
    assertProviderBinding(input.providers.transport, transportEntry);
    assertProviderBinding(input.providers.accommodation, accommodationEntry);
    assertProviderBinding(input.providers.places, placesEntry);
  } catch {
    execution?.dispose();
    throw providerSearchFailed();
  }
  if (execution === undefined) throw providerSearchFailed();
  const transportRequest = {
    ...providerRequest,
    originCity: input.context.originCity,
    destinations,
  };
  const transportQueryFingerprint = createProviderFingerprint(
    transportRequest as unknown as ProviderJsonValue,
  );
  const transportPromise = executeProviderSearch<readonly TransportOption[]>(
    execution,
    transportEntry,
    {
      providerKey: transportEntry.providerKey,
      operation: 'TRANSPORT_SEARCH',
      queryFingerprint: transportQueryFingerprint,
      resultFingerprint: (result) =>
        providerResultFingerprint(
          result,
          transportEntry,
          transportQueryFingerprint,
          offerSources,
          transportResultView,
          offerMoneys,
          liveTransportShape,
        ),
      resultCount: (result) => result.length,
    },
    (options) => input.providers.transport.search(transportRequest, options),
  );
  const accommodationQueryFingerprints = new Map<string, string>();
  const stayPromises = destinations.map((destination) => {
    const queryFingerprint = createProviderFingerprint({
      ...providerRequest,
      destination: { ...destination },
    });
    accommodationQueryFingerprints.set(destination.code, queryFingerprint);
    return executeProviderSearch<readonly StayOption[]>(
      execution,
      accommodationEntry,
      {
        providerKey: accommodationEntry.providerKey,
        operation: 'ACCOMMODATION_SEARCH',
        destinationCode: destination.code,
        queryFingerprint,
        resultFingerprint: (result) =>
          providerResultFingerprint(
            result,
            accommodationEntry,
            queryFingerprint,
            offerSources,
            stayResultView,
            offerMoneys,
            liveStayShape,
          ),
        resultCount: (result) => result.length,
      },
      (options) =>
        input.providers.accommodation.search({ ...providerRequest, destination }, options),
    );
  });
  const placesQueryFingerprints = new Map<string, string>();
  const placePromises = destinations.map((destination) => {
    const queryFingerprint = createProviderFingerprint({
      ...providerRequest,
      destination: { ...destination },
    });
    placesQueryFingerprints.set(destination.code, queryFingerprint);
    return executeProviderSearch<readonly Place[]>(
      execution,
      placesEntry,
      {
        providerKey: placesEntry.providerKey,
        operation: 'PLACES_SEARCH',
        destinationCode: destination.code,
        queryFingerprint,
        resultFingerprint: (result) =>
          providerResultFingerprint(
            result,
            placesEntry,
            queryFingerprint,
            (place) => [place.sourceSnapshot],
            placeResultView,
            undefined,
            livePlaceShape,
          ),
        resultCount: (result) => result.length,
      },
      (options) => input.providers.places.search({ ...providerRequest, destination }, options),
    );
  });
  let providerResults: readonly [
    Awaited<typeof transportPromise>,
    Awaited<(typeof stayPromises)[number]>[],
    Awaited<(typeof placePromises)[number]>[],
  ];
  try {
    providerResults = await Promise.all([
      transportPromise,
      Promise.all(stayPromises),
      Promise.all(placePromises),
    ]);
  } catch {
    execution.cancel();
    await Promise.allSettled([transportPromise, ...stayPromises, ...placePromises]);
    execution.dispose();
    // Adapter nie może przepuścić stack trace'u ani zależnego od providera payloadu do API.
    throw providerSearchFailed();
  }
  execution.dispose();
  const [transportOptions, stayGroups, placeGroups] = providerResults;
  const builder: CandidateBuilderResult = buildCandidates({
    context: input.context,
    destinations,
    transportOptions,
    stayOptions: stayGroups.flat(),
    places: placeGroups.flat(),
    config,
  });
  const filtered = filterCandidates(builder.candidates, input.context, config);
  try {
    assertSelectedFixtureQueryLineage(
      filtered.validCandidates,
      {
        transport: transportEntry,
        accommodation: accommodationEntry,
        places: placesEntry,
      },
      {
        transport: transportQueryFingerprint,
        accommodation: accommodationQueryFingerprints,
        places: placesQueryFingerprints,
      },
    );
  } catch {
    throw providerSearchFailed();
  }
  const rankedCandidates = rankCandidates(filtered.validCandidates, input.context, config);
  const selected = selectDiverseOptions(rankedCandidates, config);

  return {
    configVersion: config.version,
    counts: {
      destinations: builder.destinationCount,
      transportOptions: builder.transportOptionCount,
      stayOptions: builder.stayOptionCount,
      builtCandidates: builder.candidates.length,
      validCandidates: filtered.validCandidates.length,
      rejectedCandidates: filtered.rejectedCandidates.length,
    },
    candidates: builder.candidates,
    validCandidates: filtered.validCandidates,
    rejectedCandidates: filtered.rejectedCandidates,
    rejectionReasons: filtered.rejectedCandidates.flatMap((result) => result.reasons),
    rankedCandidates,
    options: selected.options,
    shortage: selected.shortage,
    providerExecution: {
      policyVersion: execution.policy.version,
      calls: execution.getAuditEvents(),
    },
  };
}
