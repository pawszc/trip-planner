import {
  type PlanningContext,
  type RejectionReason,
  type TripCandidate,
  TRANSPORT_MODE_VALUES,
} from '../domain/candidate.ts';
import { type Money, type SourceSnapshot } from '../domain/money.ts';
import { offerPricingValidationIssues } from '../domain/offer-pricing.ts';
import { canonicalSourceSnapshot, isCompleteSourceSnapshot } from '../providers/source-snapshot.ts';
import { SOFT_PREFERENCE_KEYS } from '../domain/trip-request.ts';
import { parseStrictIsoDate } from '../validation/strict-iso-date.ts';
import { mergeCandidateEngineConfig, type CandidateEngineConfigOverride } from './config.ts';
import { createRejectionReason } from './rejection-reasons.ts';

export interface CandidateValidationResult {
  candidate: TripCandidate;
  reasons: readonly RejectionReason[];
}

export interface CandidateFilterResult {
  validCandidates: readonly TripCandidate[];
  rejectedCandidates: readonly CandidateValidationResult[];
  results: readonly CandidateValidationResult[];
}

function timeOfDay(instant: string): string | null {
  const match = /T(\d{2}):(\d{2})/.exec(instant);
  return match ? `${match[1]}:${match[2]}` : null;
}

function normalizedName(value: string): string {
  return value.trim().toLocaleLowerCase('en').replace(/\s+/g, ' ');
}

function strictInstant(value: string): number | null {
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

/** Provider IDs do not participate in semantic transport + hotel identity. */
export function candidateSemanticSignature(candidate: TripCandidate): string {
  const transport = candidate.transport;
  const stay = candidate.stay;
  const canonicalInstant = (value: string): string => {
    const parsed = strictInstant(value);
    return parsed === null ? value.trim() : new Date(parsed).toISOString();
  };
  return [
    candidate.destination.code,
    transport.mode,
    canonicalInstant(transport.outbound.departureAt),
    canonicalInstant(transport.outbound.arrivalAt),
    transport.outbound.connections,
    canonicalInstant(transport.return.departureAt),
    canonicalInstant(transport.return.arrivalAt),
    transport.return.connections,
    normalizedName(stay.name),
    stay.checkInDate,
    stay.checkOutDate,
  ].join('|');
}

function moneyEntries(candidate: TripCandidate): readonly (readonly [string, Money])[] {
  return [
    ['transport.price', candidate.transport.price],
    ['transport.additionalFees', candidate.transport.additionalFees],
    ['transport.pricing.mandatoryTotal', candidate.transport.pricing.mandatoryTotal],
    ...candidate.transport.pricing.conditionalCharges.items.map(
      (charge) => [`transport.pricing.conditionalCharges.${charge.id}`, charge.amount] as const,
    ),
    ...candidate.transport.pricing.optionalAncillaries.items.map(
      (charge) => [`transport.pricing.optionalAncillaries.${charge.id}`, charge.amount] as const,
    ),
    ['stay.price', candidate.stay.price],
    ['stay.additionalFees', candidate.stay.additionalFees],
    ['stay.pricing.mandatoryTotal', candidate.stay.pricing.mandatoryTotal],
    ...candidate.stay.pricing.conditionalCharges.items.map(
      (charge) => [`stay.pricing.conditionalCharges.${charge.id}`, charge.amount] as const,
    ),
    ...candidate.stay.pricing.optionalAncillaries.items.map(
      (charge) => [`stay.pricing.optionalAncillaries.${charge.id}`, charge.amount] as const,
    ),
    ['budget.localTransport', candidate.budget.localTransport],
    ['budget.food', candidate.budget.food],
    ['budget.attractions', candidate.budget.attractions],
    ['budget.additionalFees', candidate.budget.additionalFees],
    ['budget.buffer', candidate.budget.buffer],
  ];
}

function sourceEntries(
  candidate: TripCandidate,
): readonly (readonly [string, SourceSnapshot | null])[] {
  return [
    ['transport', candidate.transport.sourceSnapshot],
    ['stay', candidate.stay.sourceSnapshot],
    ...candidate.places.map((place) => [`place:${place.id}`, place.sourceSnapshot] as const),
    ...moneyEntries(candidate).map(
      ([path, money]) => [`money:${path}`, money.sourceSnapshot] as const,
    ),
  ];
}

function invalidDates(candidate: TripCandidate, context: PlanningContext): readonly string[] {
  const issues: string[] = [];
  const outboundDeparture = strictInstant(candidate.transport.outbound.departureAt);
  const outboundArrival = strictInstant(candidate.transport.outbound.arrivalAt);
  const returnDeparture = strictInstant(candidate.transport.return.departureAt);
  const returnArrival = strictInstant(candidate.transport.return.arrivalAt);
  const tripStart = parseStrictIsoDate(context.startDate) ?? Number.NaN;
  const tripEndStart = parseStrictIsoDate(context.endDate);
  const tripEnd = tripEndStart === null ? Number.NaN : tripEndStart + 86_400_000 - 1;
  if (
    outboundDeparture === null ||
    outboundArrival === null ||
    returnDeparture === null ||
    returnArrival === null
  ) {
    issues.push('transport-instant-format');
  } else {
    if (outboundDeparture >= outboundArrival) issues.push('outbound-order');
    if (outboundArrival >= returnDeparture) issues.push('stay-window-order');
    if (returnDeparture >= returnArrival) issues.push('return-order');
    if (outboundDeparture < tripStart || returnArrival > tripEnd)
      issues.push('outside-trip-window');
    if (
      Math.floor((outboundArrival - outboundDeparture) / 60_000) !==
      candidate.transport.outbound.durationMinutes
    )
      issues.push('outbound-duration');
    if (
      Math.floor((returnArrival - returnDeparture) / 60_000) !==
      candidate.transport.return.durationMinutes
    )
      issues.push('return-duration');
  }

  const stayStart = parseStrictIsoDate(candidate.stay.checkInDate);
  const stayEnd = parseStrictIsoDate(candidate.stay.checkOutDate);
  const expectedNights =
    stayStart !== null && stayEnd !== null
      ? Math.floor((stayEnd - stayStart) / 86_400_000)
      : Number.NaN;
  if (
    stayStart === null ||
    stayEnd === null ||
    !Number.isFinite(expectedNights) ||
    expectedNights <= 0 ||
    expectedNights !== candidate.stay.nights ||
    candidate.stay.checkInDate !== context.startDate ||
    candidate.stay.checkOutDate !== context.endDate
  ) {
    issues.push('stay-dates');
  }
  return issues;
}

function incompleteFields(candidate: TripCandidate): readonly string[] {
  const fields: string[] = [];
  if (!candidate.id.trim()) fields.push('candidate.id');
  if (!candidate.destination.code.trim()) fields.push('destination.code');
  if (!candidate.destination.city.trim()) fields.push('destination.city');
  if (!candidate.destination.countryCode.trim()) fields.push('destination.countryCode');
  if (!candidate.transport.id.trim()) fields.push('transport.id');
  if (!candidate.stay.id.trim()) fields.push('stay.id');
  if (!candidate.stay.name.trim()) fields.push('stay.name');
  if (
    candidate.transport.destinationCode !== candidate.destination.code ||
    candidate.stay.destinationCode !== candidate.destination.code ||
    candidate.places.some((place) => place.destinationCode !== candidate.destination.code)
  ) {
    fields.push('destination-consistency');
  }
  for (const [path, leg] of [
    ['transport.outbound', candidate.transport.outbound],
    ['transport.return', candidate.transport.return],
  ] as const) {
    if (!Number.isSafeInteger(leg.durationMinutes) || leg.durationMinutes <= 0) {
      fields.push(`${path}.durationMinutes`);
    }
    if (!Number.isSafeInteger(leg.connections) || leg.connections < 0) {
      fields.push(`${path}.connections`);
    }
  }
  if (
    !Number.isFinite(candidate.stay.centralityScore) ||
    candidate.stay.centralityScore < 0 ||
    candidate.stay.centralityScore > 100
  ) {
    fields.push('stay.centralityScore');
  }
  for (const place of candidate.places) {
    if (!place.id.trim() || !place.name.trim()) fields.push(`place:${place.id || '(empty)'}`);
    if (
      SOFT_PREFERENCE_KEYS.some(
        (key) =>
          !Object.prototype.hasOwnProperty.call(place.preferenceScores, key) ||
          !Number.isFinite(place.preferenceScores[key]) ||
          place.preferenceScores[key] < 0 ||
          place.preferenceScores[key] > 100,
      )
    ) {
      fields.push(`place:${place.id}.preferenceScores`);
    }
  }
  return fields;
}

function isModeAllowed(candidate: TripCandidate, context: PlanningContext): boolean {
  if (!TRANSPORT_MODE_VALUES.includes(candidate.transport.mode)) return false;
  if (candidate.transport.mode === 'FLIGHT') return context.hardConstraints.allowFlight;
  if (candidate.transport.mode === 'TRAIN') return context.hardConstraints.allowTrain;
  return context.hardConstraints.allowBus;
}

/** Sprawdza wszystkie twarde reguły i nie zatrzymuje się na pierwszym błędzie. */
export function validateCandidate(
  candidate: TripCandidate,
  context: PlanningContext,
  configOverride: CandidateEngineConfigOverride = {},
): CandidateValidationResult {
  const config = mergeCandidateEngineConfig(configOverride);
  const reasons: RejectionReason[] = [];
  const subject = { candidateId: candidate.id } as const;
  const constraints = context.hardConstraints;

  if (
    constraints.hardBudgetLimit &&
    candidate.budget.totalAmountMinor !== null &&
    candidate.budget.totalAmountMinor > context.totalBudgetMinor
  ) {
    reasons.push(
      createRejectionReason({
        ...subject,
        code: 'BUDGET_EXCEEDED',
        expected: context.totalBudgetMinor,
        actual: candidate.budget.totalAmountMinor,
      }),
    );
  }

  const departureTime = timeOfDay(candidate.transport.outbound.departureAt);
  if (
    constraints.earliestDepartureTime !== null &&
    departureTime !== null &&
    departureTime < constraints.earliestDepartureTime
  ) {
    reasons.push(
      createRejectionReason({
        ...subject,
        code: 'DEPARTURE_TOO_EARLY',
        expected: constraints.earliestDepartureTime,
        actual: departureTime,
      }),
    );
  }

  const returnTime = timeOfDay(candidate.transport.return.arrivalAt);
  if (
    constraints.latestReturnTime !== null &&
    returnTime !== null &&
    returnTime > constraints.latestReturnTime
  ) {
    reasons.push(
      createRejectionReason({
        ...subject,
        code: 'RETURN_TOO_LATE',
        expected: constraints.latestReturnTime,
        actual: returnTime,
      }),
    );
  }

  const maximumConnections = Math.max(
    candidate.transport.outbound.connections,
    candidate.transport.return.connections,
  );
  if (maximumConnections > constraints.maxConnections) {
    reasons.push(
      createRejectionReason({
        ...subject,
        code: 'TOO_MANY_CONNECTIONS',
        expected: constraints.maxConnections,
        actual: maximumConnections,
      }),
    );
  }

  if (!isModeAllowed(candidate, context)) {
    reasons.push(
      createRejectionReason({
        ...subject,
        code: 'TRANSPORT_MODE_NOT_ALLOWED',
        expected: 'allowed transport mode',
        actual: candidate.transport.mode,
      }),
    );
  }

  const longestLegMinutes = Math.max(
    candidate.transport.outbound.durationMinutes,
    candidate.transport.return.durationMinutes,
  );
  if (constraints.maxTravelMinutes !== null && longestLegMinutes > constraints.maxTravelMinutes) {
    reasons.push(
      createRejectionReason({
        ...subject,
        code: 'TRAVEL_TIME_EXCEEDED',
        expected: constraints.maxTravelMinutes,
        actual: longestLegMinutes,
      }),
    );
  }

  const requiredPrices = [
    ['transport.price', candidate.transport.price],
    ['transport.additionalFees', candidate.transport.additionalFees],
    ['transport.pricing.mandatoryTotal', candidate.transport.pricing.mandatoryTotal],
    ['stay.price', candidate.stay.price],
    ['stay.additionalFees', candidate.stay.additionalFees],
    ['stay.pricing.mandatoryTotal', candidate.stay.pricing.mandatoryTotal],
    ['localCostEstimates.localTransport', candidate.localCostEstimates.localTransport],
    ['localCostEstimates.food', candidate.localCostEstimates.food],
    ['localCostEstimates.attractions', candidate.localCostEstimates.attractions],
    ['budget.buffer', candidate.budget.buffer],
  ] as const;
  const unknownPrices = requiredPrices
    .filter(([, money]) => money.priceType === 'UNKNOWN')
    .map(([path]) => path);
  if (unknownPrices.length > 0) {
    reasons.push(
      createRejectionReason({
        ...subject,
        code: 'REQUIRED_PRICE_UNKNOWN',
        details: { fields: unknownPrices },
        expected: 'known required prices',
        actual: unknownPrices,
      }),
    );
  }

  const missingSources = sourceEntries(candidate)
    .filter(([, source]) => !isCompleteSourceSnapshot(source))
    .map(([path]) => path);
  if (missingSources.length > 0) {
    reasons.push(
      createRejectionReason({
        ...subject,
        code: 'SOURCE_MISSING',
        details: { fields: missingSources },
        expected: 'source snapshot',
        actual: null,
      }),
    );
  }

  const mismatchedCurrencies = moneyEntries(candidate)
    .filter(
      ([, money]) =>
        money.currency !== context.currency ||
        (money.sourceSnapshot !== null && money.sourceSnapshot.currency !== money.currency),
    )
    .map(([path, money]) => `${path}:${money.currency}`);
  for (const [path, source] of sourceEntries(candidate)) {
    if (source !== null && source.currency !== context.currency) {
      mismatchedCurrencies.push(`source:${path}:${source.currency}`);
    }
  }
  if (mismatchedCurrencies.length > 0) {
    reasons.push(
      createRejectionReason({
        ...subject,
        code: 'CURRENCY_MISMATCH',
        details: { fields: mismatchedCurrencies },
        expected: context.currency,
        actual: mismatchedCurrencies,
      }),
    );
  }

  if (
    candidate.effectiveTimeAtDestinationMinutes < config.minimumEffectiveTimeAtDestinationMinutes
  ) {
    reasons.push(
      createRejectionReason({
        ...subject,
        code: 'INSUFFICIENT_TIME_AT_DESTINATION',
        expected: config.minimumEffectiveTimeAtDestinationMinutes,
        actual: candidate.effectiveTimeAtDestinationMinutes,
      }),
    );
  }

  const dateIssues = invalidDates(candidate, context);
  if (dateIssues.length > 0) {
    reasons.push(
      createRejectionReason({
        ...subject,
        code: 'INVALID_DATES',
        details: { issues: dateIssues },
        expected: 'chronological dates within trip window',
        actual: dateIssues,
      }),
    );
  }

  const missingFields = [...incompleteFields(candidate)];
  missingFields.push(
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
  );
  const sourceIdentity = new Map<string, string>();
  for (const [path, source] of sourceEntries(candidate)) {
    if (!isCompleteSourceSnapshot(source)) continue;
    const canonical = canonicalSourceSnapshot(source);
    const previous = sourceIdentity.get(source.id);
    if (previous !== undefined && previous !== canonical) {
      missingFields.push(`sourceCollision:${path}`);
    } else {
      sourceIdentity.set(source.id, canonical);
    }
  }
  if (
    candidate.budget.totalAmountMinor === null &&
    unknownPrices.length === 0 &&
    mismatchedCurrencies.length === 0
  ) {
    missingFields.push('budget.totalAmountMinor');
  }
  if (missingFields.length > 0) {
    reasons.push(
      createRejectionReason({
        ...subject,
        code: 'INCOMPLETE_DATA',
        details: { fields: missingFields },
        expected: 'complete candidate data',
        actual: missingFields,
      }),
    );
  }

  return { candidate, reasons };
}

export function filterCandidates(
  candidates: readonly TripCandidate[],
  context: PlanningContext,
  configOverride: CandidateEngineConfigOverride = {},
): CandidateFilterResult {
  const results = candidates.map((candidate) => {
    const validation = validateCandidate(candidate, context, configOverride);
    return { ...validation, mutableReasons: [...validation.reasons] };
  });
  const bySignature = new Map<string, typeof results>();
  for (const result of results) {
    const signature = candidateSemanticSignature(result.candidate);
    const group = bySignature.get(signature) ?? [];
    group.push(result);
    bySignature.set(signature, group);
  }

  for (const [signature, group] of bySignature) {
    const ordered = [...group].sort((left, right) => {
      const leftCost = left.candidate.budget.totalAmountMinor ?? Number.POSITIVE_INFINITY;
      const rightCost = right.candidate.budget.totalAmountMinor ?? Number.POSITIVE_INFINITY;
      return (
        left.mutableReasons.length - right.mutableReasons.length ||
        leftCost - rightCost ||
        left.candidate.id.localeCompare(right.candidate.id, 'en')
      );
    });
    for (const duplicate of ordered.slice(1)) {
      duplicate.mutableReasons.push(
        createRejectionReason({
          candidateId: duplicate.candidate.id,
          code: 'DUPLICATE_CANDIDATE',
          details: { signature, representativeId: ordered[0]?.candidate.id ?? null },
          expected: ordered[0]?.candidate.id ?? null,
          actual: duplicate.candidate.id,
        }),
      );
    }
  }

  const publicResults: CandidateValidationResult[] = results.map(
    ({ candidate, mutableReasons }) => ({
      candidate,
      reasons: mutableReasons,
    }),
  );
  return {
    validCandidates: publicResults
      .filter((result) => result.reasons.length === 0)
      .map((result) => result.candidate),
    rejectedCandidates: publicResults.filter((result) => result.reasons.length > 0),
    results: publicResults,
  };
}
