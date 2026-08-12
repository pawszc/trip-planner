namespace trip.planner.test;

using { cuid } from '@sap/cds/common';

// This entity and service exist only in the integration-test model. They are never loaded by
// the production `cds serve all` model and do not extend TripPlannerService's public contract.
entity TransactionProbeWrites : cuid {
  marker : String(120) not null;
}

@path: '/test-ai-transaction'
service AiTransactionTestService {
  action executeGateway(
    aiRunId : UUID,
    mode : String(40)
  ) returns String;
}
