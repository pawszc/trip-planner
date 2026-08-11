using { trip.planner as db } from '../db/schema';

// Publiczny kontrakt OData jest oddzielony od fizycznego modelu bazy przez projekcję.
@path: '/trip-planner'
service TripPlannerService {
  entity TripRequests as projection on db.TripRequests actions {
    // Akcja związana z konkretnym briefem wymusza kontrolowaną zmianę statusu.
    action confirmConstraints() returns TripRequests;
  };

  // Stan workflow jest publicznie widoczny, ale nie może omijać domenowej maszyny stanów.
  @readonly
  entity WorkflowRuns as projection on db.WorkflowRuns;
}
