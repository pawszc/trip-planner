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
}
