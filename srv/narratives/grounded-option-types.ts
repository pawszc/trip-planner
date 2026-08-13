import type { JsonObject, JsonValue } from '../ai/contracts.ts';

export const GROUNDED_OPTION_CONTEXT_VERSION = 'grounded-option-context-v1';

export const GROUNDED_BUDGET_CATEGORIES = [
  'TRANSPORT',
  'ACCOMMODATION',
  'LOCAL_TRANSPORT',
  'FOOD',
  'ATTRACTIONS',
  'ADDITIONAL_FEES',
  'BUFFER',
] as const;

export type GroundedBudgetCategory = (typeof GROUNDED_BUDGET_CATEGORIES)[number];
export type GroundedFactStatus = 'KNOWN' | 'UNKNOWN' | 'MISSING';
export type IntegerValue = number | string;
export type DecimalValue = number | string;

export interface GroundedPlanningRunRecord {
  ID: string;
  status: 'SUCCEEDED' | 'INSUFFICIENT_OPTIONS';
  requestFingerprint: string;
  providerFixtureVersion: string;
  engineVersion: string;
  scoringVersion: string;
}

export interface GroundedRankedOptionRecord {
  ID: string;
  planningRun_ID: string;
  rank: number;
  role: 'BEST_OVERALL' | 'MOST_CONVENIENT' | 'BEST_VALUE';
  destinationCode: string;
  destinationCity: string;
  destinationCountryCode: string;
  transportMode: 'FLIGHT' | 'TRAIN' | 'BUS';
  outboundDepartureAt: string;
  outboundArrivalAt: string;
  returnDepartureAt: string;
  returnArrivalAt: string;
  outboundTravelMinutes: number;
  returnTravelMinutes: number;
  maximumConnections: number;
  effectiveTimeAtDestinationMinutes: number;
  stayName: string;
  checkInDate: string;
  checkOutDate: string;
  nights: number;
  accommodationCentralityScore: DecimalValue;
  currency: string;
  budgetLimitMinor: IntegerValue;
  confirmedAmountMinor: IntegerValue;
  estimatedAmountMinor: IntegerValue;
  unknownCategoryCount: number;
  totalAmountMinor: IntegerValue;
  costPerPersonMinor: IntegerValue;
  remainingBudgetMinor: IntegerValue;
  totalScore: DecimalValue;
  budgetFitScore: DecimalValue;
  travelTimeScore: DecimalValue;
  effectiveTimeScore: DecimalValue;
  accommodationLocationScore: DecimalValue;
  dataCompletenessScore: DecimalValue;
  priceConfidenceScore: DecimalValue;
  preferenceFitScore: DecimalValue;
}

export interface GroundedBudgetItemRecord {
  ID: string;
  planningRun_ID: string;
  rankedOption_ID: string;
  sourceSnapshot_ID: string | null;
  category: GroundedBudgetCategory;
  priceType: 'LIVE_PRICE' | 'FIXED_PRICE' | 'ESTIMATE' | 'UNKNOWN';
  classification: 'CONFIRMED' | 'ESTIMATED' | 'UNKNOWN';
  currency: string;
  amountMinor: IntegerValue | null;
}

export interface GroundedSourceSnapshotRecord {
  ID: string;
  planningRun_ID: string;
  rankedOption_ID: string;
  sourceKey: string;
  provider: string;
  externalItemId: string;
  fetchedAt: string;
  sourceUrl: string;
  freshnessType: 'LIVE' | 'CACHED' | 'FIXTURE' | 'INTERNAL_RULE';
  currency: string;
  fixtureVersion: string;
  contexts: string;
  demonstrationData: boolean;
}

export interface GroundedOptionContextInput {
  planningRun: GroundedPlanningRunRecord;
  rankedOption: GroundedRankedOptionRecord;
  budgetItems: readonly GroundedBudgetItemRecord[];
  sourceSnapshots: readonly GroundedSourceSnapshotRecord[];
  contextVersion?: string;
}

export type GroundedContextPlanningRun = JsonObject & {
  readonly id: string;
  readonly requestFingerprint: string;
  readonly providerFixtureVersion: string;
  readonly engineVersion: string;
  readonly scoringVersion: string;
};

export type GroundedContextRankedOption = JsonObject & {
  readonly id: string;
  readonly rank: number;
  readonly role: string;
};

export type GroundedSourceSnapshot = JsonObject & {
  readonly id: string;
  readonly sourceKey: string;
  readonly provider: string;
  readonly externalItemId: string;
  readonly fetchedAt: string;
  readonly sourceUrl: string;
  readonly freshnessType: string;
  readonly currency: string;
  readonly fixtureVersion: string;
  readonly contexts: string;
  readonly demonstrationData: boolean;
};

export type GroundedFact = JsonObject & {
  readonly factId: string;
  readonly key: string;
  readonly status: GroundedFactStatus;
  readonly value: JsonValue;
  readonly sourceSnapshotIds: readonly string[];
};

export type GroundedFactDraft = JsonObject & {
  readonly key: string;
  readonly status: GroundedFactStatus;
  readonly value: JsonValue;
  readonly sourceSnapshotIds: readonly string[];
};

export type GroundedOptionContext = JsonObject & {
  readonly version: string;
  readonly fingerprint: string;
  readonly planningRun: GroundedContextPlanningRun;
  readonly rankedOption: GroundedContextRankedOption;
  readonly facts: readonly GroundedFact[];
  readonly sourceSnapshots: readonly GroundedSourceSnapshot[];
};
