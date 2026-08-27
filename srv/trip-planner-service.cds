using { trip.planner as db } from '../db/schema';

// Publiczny kontrakt OData jest oddzielony od fizycznego modelu bazy przez projekcję.
@path: '/trip-planner'
service TripPlannerService {
  entity TripRequests as projection on db.TripRequests actions {
    // Akcja związana z konkretnym briefem wymusza kontrolowaną zmianę statusu.
    action confirmConstraints() returns TripRequests;
    // Planowanie używa wyłącznie potwierdzonego briefu i jawnego provider manifestu.
    action startPlanning() returns PlanningRuns;
  };

  // Stan workflow jest publicznie widoczny, ale nie może omijać domenowej maszyny stanów.
  @readonly
  entity WorkflowRuns as projection on db.WorkflowRuns;

  @readonly
  entity PlanningRuns as projection on db.PlanningRuns;

  @readonly
  entity WorkflowTransitions as projection on db.WorkflowTransitions;

  @readonly
  @cds.redirection.target
  entity RankedOptions as projection on db.RankedOptions actions {
    // Narracja opisuje wyłącznie tę już wybraną przez deterministyczny pipeline opcję.
    action generateNarrative() returns NarrativeRuns;
  };

  @readonly
  entity BudgetItems as projection on db.BudgetItems;

  // Agregat budżetu jest czytelny bez pobierania pozostałych pól karty wariantu.
  @readonly
  entity BudgetBreakdowns as projection on db.RankedOptions {
    key ID,
    tripRequest,
    workflowRun,
    planningRun,
    providerFixtureVersion,
    providerManifestVersion,
    providerManifestFingerprint,
    offerPricingContractVersion,
    scoringVersion,
    currency,
    budgetLimitMinor,
    confirmedAmountMinor,
    estimatedAmountMinor,
    unknownCategoryCount,
    totalAmountMinor,
    costPerPersonMinor,
    remainingBudgetMinor,
    transportMandatoryTotalMinor,
    transportMandatoryTotalPriceType,
    transportMandatoryTotalClassification,
    transportMandatoryTotalSourceKey,
    accommodationMandatoryTotalMinor,
    accommodationMandatoryTotalPriceType,
    accommodationMandatoryTotalClassification,
    accommodationMandatoryTotalSourceKey
  };

  @readonly
  entity SourceSnapshots as projection on db.SourceSnapshots;

  @readonly
  entity OfferChargeCollections as projection on db.OfferChargeCollections;

  @readonly
  entity OfferChargeDisclosures as projection on db.OfferChargeDisclosures;

  @readonly
  entity OptionNotes as projection on db.OptionNotes;

  @readonly
  entity RejectionReasons as projection on db.RejectionReasons;

  @readonly
  entity RejectionSummaries as projection on db.RejectionSummaries;

  @readonly
  entity NarrativeRuns as projection on db.NarrativeRuns {
    key ID,
    planningRun,
    rankedOption,
    aiRunId,
    status,
    contextVersion,
    contextFingerprint,
    promptVersion,
    schemaVersion,
    blockCount,
    completedAt,
    createdAt,
    modifiedAt
  };

  @readonly
  entity OptionNarratives as projection on db.OptionNarratives {
    key ID,
    narrativeRun,
    planningRun,
    rankedOption,
    sequence,
    kind,
    text,
    createdAt,
    modifiedAt
  };

  @readonly
  entity NarrativeFactReferences as projection on db.NarrativeFactReferences {
    key ID,
    narrativeRun,
    optionNarrative,
    planningRun,
    rankedOption,
    sequence,
    factId,
    createdAt,
    modifiedAt
  };
}
