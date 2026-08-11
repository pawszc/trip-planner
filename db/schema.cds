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
