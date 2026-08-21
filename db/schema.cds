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

type AiConfiguredEffort : String(16) enum {
  none;
  low;
  medium;
  high;
  xhigh;
  max;
}

type NarrativeRunStatus : String(16) enum {
  SUCCEEDED;
}

type NarrativeBlockKind : String(16) enum {
  SUMMARY;
  ADVANTAGE;
  TRADEOFF;
  RISK;
}

type NarrativeReviewStage : String(16) enum {
  GENERATE;
  PRECHECK;
  JUDGE;
}

type NarrativeReviewDecision : String(16) enum {
  PUBLISH;
  REJECT;
}

type NarrativeReviewDimensionResult : String(8) enum {
  PASS;
  FAIL;
}

type NarrativeReviewFindingSeverity : String(16) enum {
  MAJOR;
  CRITICAL;
}

type NarrativeReviewFindingCode : String(80) enum {
  REFERENCE_DOES_NOT_SUPPORT_CLAIM;
  UNSUPPORTED_CLAIM;
  CONTRADICTS_GROUNDED_FACT;
  CLAIM_MISSING_SUPPORT;
  FILLS_UNKNOWN_OR_MISSING;
  MONEY_VALUE_MISMATCH;
  MONEY_CALCULATION_OR_REFORMAT;
  DATE_TIME_MISMATCH;
  RANKING_ROLE_MISMATCH;
  HARD_CONSTRAINT_RELAXATION;
  PROVENANCE_OVERSTATED;
  AVAILABILITY_OR_BOOKING_GUARANTEE;
  UNSUPPORTED_LEGAL_VISA_HEALTH_OR_ACCESSIBILITY_ADVICE;
  UNSAFE_OR_ILLEGAL_GUIDANCE;
  PROMPT_INJECTION_FOLLOWED;
  UNTRUSTED_CONTENT_EXPOSED;
  PII_OR_SECRET_EXPOSURE;
  IRRELEVANT_OR_WRONG_BLOCK_KIND;
  CROSS_BLOCK_CONTRADICTION;
}

// Zamknięty kod opisuje wyłącznie kontrolowaną przyczynę fail-closed. Szczegóły
// providera, treść kandydata i raw output nie są utrwalane.
type NarrativeReviewFailureCode : String(80) enum {
  PRECHECK_REJECTED;
  SEMANTIC_REJECTED;
  MISSING_CREDENTIALS;
  INVALID_AI_CONFIGURATION;
  UNSUPPORTED_AI_PROVIDER;
  AI_AUDIT_FAILED;
  AUTHENTICATION_FAILED;
  MODEL_ACCESS_DENIED;
  RATE_LIMITED;
  AI_TIMEOUT;
  PROVIDER_UNAVAILABLE;
  PROVIDER_ERROR;
  MODEL_REFUSAL;
  EMPTY_MODEL_OUTPUT;
  INVALID_STRUCTURED_OUTPUT;
  INVALID_NARRATIVE_MODEL_VIEW;
  INVALID_NARRATIVE_QUALITY_CONTEXT;
  INVALID_NARRATIVE_JUDGE_OUTPUT;
  AUDIT_LINKAGE_MISMATCH;
  PRODUCT_WRITE_FAILED;
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
  // Nullable bez defaultu: legacy row nie może otrzymać wersji, której nie da się udowodnić.
  currencyContractVersion : String(80);
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
  // Nullable bez defaultu: istniejące AiRuns pozostają jawnie legacy, a każdy nowy
  // STARTED zapisuje dokładny profil i efektywny limit obliczony przez gateway.
  configuredEffort : AiConfiguredEffort;
  configuredMaxOutputTokens : Integer;
  effectiveMaxOutputTokens : Integer;
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

// Produktowy wynik narracji powstaje dopiero po lokalnej walidacji i trwałym SUCCEEDED
// właściwego AiRun. Audyt jest efemeryczny, więc produkt zachowuje tylko historyczny UUID.
// Prompt, ugruntowane wejście i raw output nie są tu przechowywane.
@assert.unique.narrativeAiRun: [aiRunId]
entity NarrativeRuns : cuid, managed {
  planningRun : Association to one PlanningRuns not null;
  rankedOption : Association to one RankedOptions not null;
  // Niezmienny historyczny UUID; cleanup efemerycznego AiRuns nie narusza produktu.
  aiRunId : UUID not null;
  status : NarrativeRunStatus not null;
  contextVersion : String(120) not null;
  contextFingerprint : String(64) not null;
  promptVersion : String(120) not null;
  schemaVersion : String(120) not null;
  // Addytywne linkage quality gate. Brak defaultów zachowuje legacy 3B2 jako unreviewed.
  reviewRunId : UUID;
  judgeAiRunId : UUID;
  modelViewVersion : String(120);
  modelViewFingerprint : String(64);
  narrativeFingerprint : String(64);
  qualityContextVersion : String(120);
  qualityContextFingerprint : String(64);
  constraintSnapshotVersion : String(120);
  safetyPrecheckVersion : String(120);
  judgePromptVersion : String(120);
  judgeSchemaVersion : String(120);
  rubricVersion : String(120);
  rubricFingerprint : String(64);
  publicationPolicyVersion : String(120);
  datasetVersion : String(120);
  modelProfileVersion : String(120);
  priceCatalogVersion : String(120);
  blockCount : Integer not null;
  completedAt : Timestamp not null;
}

// Review jest trwałym, wewnętrznym dowodem bramki jakości. Identyfikatory AiRuns są
// skalarami, a nie associations, dlatego retencja audytu nie blokuje cleanupu i nie uszkadza
// review ani opublikowanej narracji.
@assert.unique.reviewGenerateAiRun: [generateAiRunId]
entity NarrativeReviewRuns : cuid, managed {
  planningRun : Association to one PlanningRuns not null;
  rankedOption : Association to one RankedOptions not null;
  generateAiRunId : UUID not null;
  judgeAiRunId : UUID;

  contextVersion : String(120) not null;
  contextFingerprint : String(64) not null;
  modelViewVersion : String(120) not null;
  modelViewFingerprint : String(64) not null;
  narrativeFingerprint : String(64);
  qualityContextVersion : String(120) not null;
  qualityContextFingerprint : String(64);
  constraintSnapshotVersion : String(120) not null;
  safetyPrecheckVersion : String(120) not null;

  generatePromptVersion : String(120) not null;
  generateSchemaVersion : String(120) not null;
  judgePromptVersion : String(120) not null;
  judgeSchemaVersion : String(120) not null;
  rubricVersion : String(120) not null;
  // Nullable/no-default keeps already persisted reviews compatible;
  // every new 3B3 review sets it.
  rubricFingerprint : String(64);
  publicationPolicyVersion : String(120) not null;
  datasetVersion : String(120) not null;
  modelProfileVersion : String(120) not null;
  priceCatalogVersion : String(120) not null;

  stage : NarrativeReviewStage not null;
  decision : NarrativeReviewDecision not null;
  failureCode : NarrativeReviewFailureCode;

  factualEntailmentResult : NarrativeReviewDimensionResult;
  referenceRelevanceResult : NarrativeReviewDimensionResult;
  unknownMissingDisciplineResult : NarrativeReviewDimensionResult;
  constraintRankingFidelityResult : NarrativeReviewDimensionResult;
  moneyDateTimeFidelityResult : NarrativeReviewDimensionResult;
  provenanceIntegrityResult : NarrativeReviewDimensionResult;
  safetyInstructionIntegrityResult : NarrativeReviewDimensionResult;
  relevanceAndBlockKindResult : NarrativeReviewDimensionResult;

  passedDimensionCount : Integer not null;
  failedDimensionCount : Integer not null;
  findingCount : Integer not null;
  majorFindingCount : Integer not null;
  criticalFindingCount : Integer not null;
  completedAt : Timestamp not null;
}

// Każdy finding jest osobnym rekordem. Listy zawierają wyłącznie kanonicznie
// posortowane liczby sekwencji i lokalne factId; nigdy rationale ani treść modelu.
@assert.unique.reviewFindingSequence: [narrativeReviewRun, sequence]
entity NarrativeReviewFindings : cuid, managed {
  narrativeReviewRun : Association to one NarrativeReviewRuns not null;
  planningRun : Association to one PlanningRuns not null;
  rankedOption : Association to one RankedOptions not null;
  sequence : Integer not null;
  reasonCode : NarrativeReviewFindingCode not null;
  severity : NarrativeReviewFindingSeverity not null;
  blockSequences : String(80) not null;
  factIds : String(2400);
  blockSequenceCount : Integer not null;
  factIdCount : Integer not null;
}

// Każdy blok narracji jest osobnym rekordem; brak częściowego zapisu zapewnia jedna
// krótka transakcja produktu wykonywana po terminalnym audycie AI.
@assert.unique.narrativeBlockSequence: [narrativeRun, sequence]
entity OptionNarratives : cuid, managed {
  narrativeRun : Association to one NarrativeRuns not null;
  planningRun : Association to one PlanningRuns not null;
  rankedOption : Association to one RankedOptions not null;
  sequence : Integer not null;
  kind : NarrativeBlockKind not null;
  text : String(1200) not null;
}

// Referencje pozostają znormalizowane, aby każdy utrwalony blok zachował dokładne factId
// z kontekstu requestu zamiast niezwalidowanej listy JSON.
@assert.unique.narrativeFactSequence: [optionNarrative, sequence]
@assert.unique.narrativeFactId: [optionNarrative, factId]
entity NarrativeFactReferences : cuid, managed {
  narrativeRun : Association to one NarrativeRuns not null;
  optionNarrative : Association to one OptionNarratives not null;
  planningRun : Association to one PlanningRuns not null;
  rankedOption : Association to one RankedOptions not null;
  sequence : Integer not null;
  factId : String(80) not null;
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
  // Nullable bez defaultu zapewnia bezpieczny upgrade; wszystkie nowe zapisy podają obie części.
  confirmedAmountMinor : Integer64;
  estimatedAmountMinor : Integer64;
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
