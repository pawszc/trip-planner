using { trip.planner as db } from '../db/schema';

@path: '/trip-planner'
service TripPlannerService {
  entity TripRequests as projection on db.TripRequests actions {
    action confirmConstraints() returns TripRequests;
  };
}
