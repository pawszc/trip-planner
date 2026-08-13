namespace trip.planner;

// `cuid` dodaje UUID, a `managed` pola createdAt/modifiedAt zarządzane przez CAP.
using { cuid, managed } from '@sap/cds/common';

// Tempo oznacza gęstość przyszłego planu dnia, a nie szybkość działania aplikacji.
type Pace : String(16) enum {
  RELAXED;
  BALANCED;
  INTENSIVE;
}

// Zatwierdzony brief jest końcowym stanem tego pierwszego przepływu.
type TripRequestStatus : String(32) enum {
  DRAFT;
  CONSTRAINTS_CONFIRMED;
}

// Jawny profil ograniczeń jest osadzony w briefie, aby miał ten sam cykl życia
// i nie mógł być modyfikowany z pominięciem reguł TripRequest.
type HardConstraintProfile {
  hardBudgetLimit : Boolean not null default true;
  earliestDepartureTime : String(5);
  latestReturnTime : String(5);
  maxConnections : Integer not null default 1;
  maxTravelMinutes : Integer;
  allowFlight : Boolean not null default true;
  allowTrain : Boolean not null default true;
  allowBus : Boolean not null default true;
}

// Wartość 3 jest neutralną preferencją i zachowuje kompatybilność
// z dotychczasowym formularzem, który nie przesyła jeszcze tego profilu.
type SoftPreferenceProfile {
  food : Integer not null default 3;
  nature : Integer not null default 3;
  history : Integer not null default 3;
  museums : Integer not null default 3;
  nightlife : Integer not null default 3;
  centralAccommodation : Integer not null default 3;
  travelComfort : Integer not null default 3;
  priceSensitivity : Integer not null default 3;
}

// Stan wykonania workflow pozostaje niezależny od statusu samego briefu.
type WorkflowState : String(32) enum {
  COLLECTING;
  NEEDS_CLARIFICATION;
  CONSTRAINTS_CONFIRMED;
  SEARCHING;
  CANDIDATES_VALIDATED;
  OPTIONS_READY;
  OPTION_SELECTED;
  ITINERARY_GENERATED;
  VALIDATED;
  READY;
  REVISING;
}

// Stan pojedynczego, wersjonowanego uruchomienia planowania. Niedobór opcji jest
// kontrolowanym wynikiem biznesowym, a nie częściowym sukcesem.
type PlanningRunStatus : String(32) enum {
  SUCCEEDED;
  INSUFFICIENT_OPTIONS;
}

type SelectionRole : String(32) enum {
  BEST_OVERALL;
  MOST_CONVENIENT;
  BEST_VALUE;
}

type TransportMode : String(16) enum {
  FLIGHT;
  TRAIN;
  BUS;
}

type BudgetCategory : String(32) enum {
  TRANSPORT;
  ACCOMMODATION;
  LOCAL_TRANSPORT;
  FOOD;
  ATTRACTIONS;
  ADDITIONAL_FEES;
  BUFFER;
}

type PriceType : String(24) enum {
  LIVE_PRICE;
  FIXED_PRICE;
  ESTIMATE;
  UNKNOWN;
}

type MoneyClassification : String(16) enum {
  CONFIRMED;
  ESTIMATED;
  UNKNOWN;
}

type FreshnessType : String(24) enum {
  LIVE;
  CACHED;
  FIXTURE;
  INTERNAL_RULE;
}

type OptionNoteKind : String(16) enum {
  ADVANTAGE;
  TRADEOFF;
  RISK;
}

type AiRunStatus : String(16) enum {
  STARTED;
  SUCCEEDED;
  FAILED;
}

type AiProvider : String(16) enum {
  OPENAI;
  ANTHROPIC;
}

type AiTaskType : String(16) enum {
  DECIDE;
  GENERATE;
  JUDGE;
  SMOKE;
}

// Trwały zapis twardych ograniczeń i podstawowej preferencji tempa podróży.
entity TripRequests : cuid, managed {
  originCity : String(120) not null;
  startDate : Date not null;
  endDate : Date not null;
  adults : Integer not null;
  totalBudget : Decimal(13, 2) not null;
  currency : String(3) not null;
  pace : Pace not null;
  status : TripRequestStatus not null default 'DRAFT';
  hardConstraints : HardConstraintProfile not null;
  softPreferences : SoftPreferenceProfile not null;
}

// Jeden brief ma najwyżej jeden bieżący run. Stan może być zmieniany
// wyłącznie przez kod domenowy i kontrolowane handlery usługi.
@assert.unique.tripRequest: [tripRequest]
entity WorkflowRuns : cuid, managed {
  tripRequest : Association to one TripRequests not null;
  state : WorkflowState not null;
  errorCode : String(80);
  errorMessage : String(500);
}

// PlanningRun jest niezmiennym wynikiem konkretnego wejścia i wersji silnika.
// Fingerprint zapewnia idempotencję ponownego wywołania dla potwierdzonego briefu.
@assert.unique.planningFingerprint: [tripRequest, requestFingerprint]
entity PlanningRuns : cuid, managed {
  tripRequest : Association to one TripRequests not null;
  workflowRun : Association to one WorkflowRuns not null;
  requestFingerprint : String(64) not null;
  status : PlanningRunStatus not null;
  providerFixtureVersion : String(80) not null;
  engineVersion : String(80) not null;
  scoringVersion : String(120) not null;
  startedAt : Timestamp not null;
  completedAt : Timestamp not null;
  destinationCount : Integer not null;
  transportOptionCount : Integer not null;
  stayOptionCount : Integer not null;
  builtCandidateCount : Integer not null;
  validCandidateCount : Integer not null;
  rejectedCandidateCount : Integer not null;
  selectedOptionCount : Integer not null;
  errorCode : String(80);
  errorMessage : String(500);
}

// Wewnętrzny audyt wykonania AI przechowuje wyłącznie bezpieczne metadane.
// Nie jest projektowany do publicznego TripPlannerService.
entity AiRuns : cuid, managed {
  planningRun : Association to one PlanningRuns;
  status : AiRunStatus not null;
  taskType : AiTaskType not null;
  provider : AiProvider not null;

  configuredModel : String(160) not null;
  responseModel : String(160);

  promptVersion : String(120) not null;
  schemaVersion : String(120) not null;
  inputFingerprint : String(64) not null;

  startedAt : Timestamp not null;
  completedAt : Timestamp;
  expiresAt : Timestamp not null;

  inputTokens : Integer64;
  outputTokens : Integer64;
  totalTokens : Integer64;
  cacheReadTokens : Integer64;
  cacheWriteTokens : Integer64;
  reasoningTokens : Integer64;

  latencyMs : Integer;
  attempts : Integer;

  providerRequestId : String(250);
  refusal : Boolean not null default false;
  refusalCategory : String(80);

  errorCode : String(80);
  retryable : Boolean;
}

// Audit kolejności przejść wykonywanych atomowo przez udany startPlanning.
@assert.unique.transitionSequence: [planningRun, sequence]
entity WorkflowTransitions : cuid, managed {
  tripRequest : Association to one TripRequests not null;
  workflowRun : Association to one WorkflowRuns not null;
  planningRun : Association to one PlanningRuns not null;
  sequence : Integer not null;
  fromState : WorkflowState not null;
  toState : WorkflowState not null;
}

// Publiczny model opcji zawiera wyłącznie jawnie wybrane, znormalizowane fakty domenowe.
@assert.unique.optionRank: [planningRun, rank]
@assert.unique.optionRole: [planningRun, role]
entity RankedOptions : cuid, managed {
  tripRequest : Association to one TripRequests not null;
  workflowRun : Association to one WorkflowRuns not null;
  planningRun : Association to one PlanningRuns not null;
  providerFixtureVersion : String(80) not null;
  scoringVersion : String(120) not null;
  rank : Integer not null;
  role : SelectionRole not null;
  candidateId : String(500) not null;
  destinationCode : String(12) not null;
  destinationCity : String(120) not null;
  destinationCountryCode : String(3) not null;
  transportId : String(200) not null;
  transportMode : TransportMode not null;
  outboundDepartureAt : Timestamp not null;
  outboundArrivalAt : Timestamp not null;
  returnDepartureAt : Timestamp not null;
  returnArrivalAt : Timestamp not null;
  outboundTravelMinutes : Integer not null;
  returnTravelMinutes : Integer not null;
  maximumConnections : Integer not null;
  effectiveTimeAtDestinationMinutes : Integer not null;
  stayId : String(200) not null;
  stayName : String(200) not null;
  checkInDate : Date not null;
  checkOutDate : Date not null;
  nights : Integer not null;
  accommodationCentralityScore : Decimal(5, 2) not null;
  currency : String(3) not null;
  budgetLimitMinor : Integer64 not null;
  confirmedAmountMinor : Integer64 not null;
  estimatedAmountMinor : Integer64 not null;
  unknownCategoryCount : Integer not null;
  totalAmountMinor : Integer64 not null;
  costPerPersonMinor : Integer64 not null;
  remainingBudgetMinor : Integer64 not null;
  totalScore : Decimal(5, 2) not null;
  budgetFitScore : Decimal(5, 2) not null;
  travelTimeScore : Decimal(5, 2) not null;
  effectiveTimeScore : Decimal(5, 2) not null;
  accommodationLocationScore : Decimal(5, 2) not null;
  dataCompletenessScore : Decimal(5, 2) not null;
  priceConfidenceScore : Decimal(5, 2) not null;
  preferenceFitScore : Decimal(5, 2) not null;
}

// Snapshoty są kontrolowanym, znormalizowanym kontraktem pochodzenia danych.
// Żaden surowy payload providera nie trafia do modelu publicznego.
@assert.unique.optionSource: [rankedOption, sourceKey]
entity SourceSnapshots : cuid, managed {
  tripRequest : Association to one TripRequests not null;
  workflowRun : Association to one WorkflowRuns not null;
  planningRun : Association to one PlanningRuns not null;
  rankedOption : Association to one RankedOptions not null;
  providerFixtureVersion : String(80) not null;
  scoringVersion : String(120) not null;
  sourceKey : String(500) not null;
  provider : String(120) not null;
  externalItemId : String(250) not null;
  fetchedAt : Timestamp not null;
  sourceUrl : String(500) not null;
  freshnessType : FreshnessType not null;
  currency : String(3) not null;
  fixtureVersion : String(80) not null;
  contexts : String(1000) not null;
  demonstrationData : Boolean not null;
}

@assert.unique.optionBudgetCategory: [rankedOption, category]
entity BudgetItems : cuid, managed {
  tripRequest : Association to one TripRequests not null;
  workflowRun : Association to one WorkflowRuns not null;
  planningRun : Association to one PlanningRuns not null;
  rankedOption : Association to one RankedOptions not null;
  sourceSnapshot : Association to one SourceSnapshots;
  providerFixtureVersion : String(80) not null;
  scoringVersion : String(120) not null;
  category : BudgetCategory not null;
  priceType : PriceType not null;
  classification : MoneyClassification not null;
  currency : String(3) not null;
  amountMinor : Integer64;
}

@assert.unique.optionNote: [rankedOption, kind, sequence]
entity OptionNotes : cuid, managed {
  tripRequest : Association to one TripRequests not null;
  workflowRun : Association to one WorkflowRuns not null;
  planningRun : Association to one PlanningRuns not null;
  rankedOption : Association to one RankedOptions not null;
  kind : OptionNoteKind not null;
  sequence : Integer not null;
  code : String(80) not null;
  text : String(500) not null;
}

@assert.unique.candidateRejectionCode: [planningRun, candidateId, code]
entity RejectionReasons : cuid, managed {
  tripRequest : Association to one TripRequests not null;
  workflowRun : Association to one WorkflowRuns not null;
  planningRun : Association to one PlanningRuns not null;
  providerFixtureVersion : String(80) not null;
  scoringVersion : String(120) not null;
  candidateId : String(500) not null;
  code : String(80) not null;
  message : String(500) not null;
  expectedValue : String(2000) not null;
  actualValue : String(2000) not null;
  detailsJson : String(4000) not null;
}

@assert.unique.rejectionSummaryCode: [planningRun, code]
entity RejectionSummaries : cuid, managed {
  tripRequest : Association to one TripRequests not null;
  workflowRun : Association to one WorkflowRuns not null;
  planningRun : Association to one PlanningRuns not null;
  providerFixtureVersion : String(80) not null;
  scoringVersion : String(120) not null;
  code : String(80) not null;
  candidateCount : Integer not null;
  occurrenceCount : Integer not null;
}
