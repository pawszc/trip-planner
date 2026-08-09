namespace trip.planner;

using { cuid, managed } from '@sap/cds/common';

type Pace : String(16) enum {
  RELAXED;
  BALANCED;
  INTENSIVE;
}

type TripRequestStatus : String(32) enum {
  DRAFT;
  CONSTRAINTS_CONFIRMED;
}

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
