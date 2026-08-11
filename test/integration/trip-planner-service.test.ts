import { randomUUID } from 'node:crypto';
import type { Request } from '@sap/cds';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { HardConstraints, SoftPreferences } from '../../srv/domain/trip-request.js';
import {
  customHardConstraints,
  customSoftPreferences,
  customTripRequestODataPayload,
  validTripRequest,
} from '../fixtures/trip-request.js';

// CAP uruchamia rzeczywisty serwis OData na bazie SQLite przechowywanej w pamięci.
process.env.CDS_TYPESCRIPT = 'true';
const { default: cds } = await import('@sap/cds');
const test = cds.test('serve', 'all', '--in-memory').in(process.cwd());
const { DELETE: DELETE_REQUEST, GET, PATCH, POST } = test;

interface CreatedTripRequest {
  ID: string;
  originCity: string;
  status: string;
  hardConstraints_hardBudgetLimit: boolean;
  hardConstraints_earliestDepartureTime: string | null;
  hardConstraints_latestReturnTime: string | null;
  hardConstraints_maxConnections: number;
  hardConstraints_maxTravelMinutes: number | null;
  hardConstraints_allowFlight: boolean;
  hardConstraints_allowTrain: boolean;
  hardConstraints_allowBus: boolean;
  softPreferences_food: number;
  softPreferences_nature: number;
  softPreferences_history: number;
  softPreferences_museums: number;
  softPreferences_nightlife: number;
  softPreferences_centralAccommodation: number;
  softPreferences_travelComfort: number;
  softPreferences_priceSensitivity: number;
}

interface WorkflowRunResponse {
  ID: string;
  tripRequest_ID: string;
  state: string;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  modifiedAt: string;
}

interface ODataCollection<T> {
  value: T[];
}

const defaultHardConstraints: HardConstraints = {
  hardBudgetLimit: true,
  earliestDepartureTime: null,
  latestReturnTime: null,
  maxConnections: 1,
  maxTravelMinutes: null,
  allowFlight: true,
  allowTrain: true,
  allowBus: true,
};

const defaultSoftPreferences: SoftPreferences = {
  food: 3,
  nature: 3,
  history: 3,
  museums: 3,
  nightlife: 3,
  centralAccommodation: 3,
  travelComfort: 3,
  priceSensitivity: 3,
};

const forceRollbackHeader = 'x-test-force-confirm-rollback';

function actionUrl(ID: string): string {
  return `/trip-planner/TripRequests(${ID})/TripPlannerService.confirmConstraints`;
}

function hardConstraintsFromOData(tripRequest: CreatedTripRequest): HardConstraints {
  return {
    hardBudgetLimit: tripRequest.hardConstraints_hardBudgetLimit,
    earliestDepartureTime: tripRequest.hardConstraints_earliestDepartureTime,
    latestReturnTime: tripRequest.hardConstraints_latestReturnTime,
    maxConnections: tripRequest.hardConstraints_maxConnections,
    maxTravelMinutes: tripRequest.hardConstraints_maxTravelMinutes,
    allowFlight: tripRequest.hardConstraints_allowFlight,
    allowTrain: tripRequest.hardConstraints_allowTrain,
    allowBus: tripRequest.hardConstraints_allowBus,
  };
}

function softPreferencesFromOData(tripRequest: CreatedTripRequest): SoftPreferences {
  return {
    food: tripRequest.softPreferences_food,
    nature: tripRequest.softPreferences_nature,
    history: tripRequest.softPreferences_history,
    museums: tripRequest.softPreferences_museums,
    nightlife: tripRequest.softPreferences_nightlife,
    centralAccommodation: tripRequest.softPreferences_centralAccommodation,
    travelComfort: tripRequest.softPreferences_travelComfort,
    priceSensitivity: tripRequest.softPreferences_priceSensitivity,
  };
}

async function readWorkflowRuns(tripRequestID: string): Promise<WorkflowRunResponse[]> {
  const filter = encodeURIComponent(`tripRequest_ID eq ${tripRequestID}`);
  const response = await GET(`/trip-planner/WorkflowRuns?$filter=${filter}`);
  return (response.data as ODataCollection<WorkflowRunResponse>).value;
}

// Błąd testowy jest rzucany po handlerze akcji, ale przed commitem requestu CAP.
// Pozwala to sprawdzić rollback obu zapisów bez dodawania hooka testowego do kodu produkcyjnego.
beforeAll(async () => {
  await test;
  const service = cds.services.TripPlannerService;
  if (!service) throw new Error('TripPlannerService nie został uruchomiony.');

  service.after('confirmConstraints', (_result: unknown, request: Request) => {
    if (request.headers[forceRollbackHeader] === 'true') {
      throw new Error('Wymuszony błąd testowy przed commitem.');
    }
  });
});

// Każdy test dostaje pustą bazę, więc przypadki nie zależą od kolejności wykonania.
beforeEach(test.data.reset);

describe('TripPlannerService', () => {
  // Ten przypadek zachowuje stary, płaski payload i obejmuje pełną drogę POST -> SQLite -> GET.
  it('creates and reads a valid TripRequest with default profiles', async () => {
    const created = await POST('/trip-planner/TripRequests', validTripRequest);
    const tripRequest = created.data as CreatedTripRequest;

    expect(tripRequest.ID).toBeTruthy();
    expect(tripRequest.status).toBe('DRAFT');
    expect(hardConstraintsFromOData(tripRequest)).toEqual(defaultHardConstraints);
    expect(softPreferencesFromOData(tripRequest)).toEqual(defaultSoftPreferences);

    const read = await GET(`/trip-planner/TripRequests(${tripRequest.ID})`);
    const persisted = read.data as CreatedTripRequest;
    expect(persisted.originCity).toBe('Warszawa');
    expect(hardConstraintsFromOData(persisted)).toEqual(defaultHardConstraints);
    expect(softPreferencesFromOData(persisted)).toEqual(defaultSoftPreferences);
  });

  it('creates a TripRequest with custom constraint and preference profiles', async () => {
    const created = await POST('/trip-planner/TripRequests', customTripRequestODataPayload);
    const tripRequest = created.data as CreatedTripRequest;

    expect(hardConstraintsFromOData(tripRequest)).toEqual(customHardConstraints);
    expect(softPreferencesFromOData(tripRequest)).toEqual(customSoftPreferences);
  });

  it('deep-merges a partial profile PATCH without resetting custom values', async () => {
    const created = await POST('/trip-planner/TripRequests', customTripRequestODataPayload);
    const tripRequest = created.data as CreatedTripRequest;
    const entityUrl = `/trip-planner/TripRequests(${tripRequest.ID})`;

    await PATCH(entityUrl, { hardConstraints_allowBus: true });

    const read = await GET(entityUrl);
    const persisted = read.data as CreatedTripRequest;
    expect(hardConstraintsFromOData(persisted)).toEqual({
      ...customHardConstraints,
      allowBus: true,
    });
    expect(softPreferencesFromOData(persisted)).toEqual(customSoftPreferences);
  });

  it('accepts null for optional flat constraints without resetting custom values', async () => {
    const created = await POST('/trip-planner/TripRequests', customTripRequestODataPayload);
    const tripRequest = created.data as CreatedTripRequest;
    const entityUrl = `/trip-planner/TripRequests(${tripRequest.ID})`;

    await PATCH(entityUrl, {
      hardConstraints_earliestDepartureTime: null,
      hardConstraints_latestReturnTime: null,
      hardConstraints_maxTravelMinutes: null,
    });

    const read = await GET(entityUrl);
    const persisted = read.data as CreatedTripRequest;
    expect(hardConstraintsFromOData(persisted)).toEqual({
      ...customHardConstraints,
      earliestDepartureTime: null,
      latestReturnTime: null,
      maxTravelMinutes: null,
    });
    expect(softPreferencesFromOData(persisted)).toEqual(customSoftPreferences);
  });

  it('rejects an invalid TripRequest', async () => {
    await expect(
      POST('/trip-planner/TripRequests', { ...validTripRequest, adults: 0 }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('rejects a profile without any allowed transport mode', async () => {
    await expect(
      POST('/trip-planner/TripRequests', {
        ...validTripRequest,
        hardConstraints_allowFlight: false,
        hardConstraints_allowTrain: false,
        hardConstraints_allowBus: false,
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('rejects an out-of-range soft preference', async () => {
    await expect(
      POST('/trip-planner/TripRequests', {
        ...validTripRequest,
        softPreferences_food: 6,
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it.each([
    ['null required boolean', { hardConstraints_allowFlight: null }],
    ['null required constraint', { hardConstraints_maxConnections: null }],
    ['null preference weight', { softPreferences_food: null }],
  ])('rejects a malformed %s', async (_case, invalidProfile) => {
    await expect(
      POST('/trip-planner/TripRequests', { ...validTripRequest, ...invalidProfile }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('rejects bypassing the confirmation action through PATCH', async () => {
    const created = await POST('/trip-planner/TripRequests', validTripRequest);
    const tripRequest = created.data as CreatedTripRequest;
    const entityUrl = `/trip-planner/TripRequests(${tripRequest.ID})`;

    await expect(PATCH(entityUrl, { status: 'CONSTRAINTS_CONFIRMED' })).rejects.toMatchObject({
      status: 400,
    });

    const read = await GET(entityUrl);
    expect((read.data as CreatedTripRequest).status).toBe('DRAFT');
  });

  // Akcja synchronizuje status briefu z dokładnie jednym runem i nadal może być wykonana tylko raz.
  it('confirms constraints, creates one WorkflowRun and rejects repeated confirmation', async () => {
    const created = await POST('/trip-planner/TripRequests', validTripRequest);
    const tripRequest = created.data as CreatedTripRequest;
    const confirmUrl = actionUrl(tripRequest.ID);

    const confirmed = await POST(confirmUrl, {});
    expect((confirmed.data as CreatedTripRequest).status).toBe('CONSTRAINTS_CONFIRMED');

    const read = await GET(`/trip-planner/TripRequests(${tripRequest.ID})`);
    expect((read.data as CreatedTripRequest).status).toBe('CONSTRAINTS_CONFIRMED');

    const workflowRuns = await readWorkflowRuns(tripRequest.ID);
    expect(workflowRuns).toHaveLength(1);
    expect(workflowRuns[0]).toMatchObject({
      tripRequest_ID: tripRequest.ID,
      state: 'CONSTRAINTS_CONFIRMED',
      errorCode: null,
      errorMessage: null,
    });
    expect(workflowRuns[0]?.createdAt).toBeTruthy();
    expect(workflowRuns[0]?.modifiedAt).toBeTruthy();

    await expect(POST(confirmUrl, {})).rejects.toMatchObject({ status: 409 });
    await expect(readWorkflowRuns(tripRequest.ID)).resolves.toHaveLength(1);
  });

  it('updates an existing WorkflowRun through a valid domain transition', async () => {
    const created = await POST('/trip-planner/TripRequests', validTripRequest);
    const tripRequest = created.data as CreatedTripRequest;
    const workflowRunID = randomUUID();
    await cds.db.run(
      cds.ql.INSERT.into('trip.planner.WorkflowRuns').entries({
        ID: workflowRunID,
        tripRequest_ID: tripRequest.ID,
        state: 'NEEDS_CLARIFICATION',
        errorCode: 'CLARIFICATION_REQUIRED',
        errorMessage: 'Brakujące dane.',
      }),
    );

    await POST(actionUrl(tripRequest.ID), {});

    const workflowRuns = await readWorkflowRuns(tripRequest.ID);
    expect(workflowRuns).toHaveLength(1);
    expect(workflowRuns[0]).toMatchObject({
      ID: workflowRunID,
      state: 'CONSTRAINTS_CONFIRMED',
      errorCode: null,
      errorMessage: null,
    });
  });

  it('rejects a corrupt persisted workflow state without changing either record', async () => {
    const created = await POST('/trip-planner/TripRequests', validTripRequest);
    const tripRequest = created.data as CreatedTripRequest;
    await cds.db.run(
      cds.ql.INSERT.into('trip.planner.WorkflowRuns').entries({
        ID: randomUUID(),
        tripRequest_ID: tripRequest.ID,
        state: 'BROKEN',
        errorCode: null,
        errorMessage: null,
      }),
    );

    await expect(POST(actionUrl(tripRequest.ID), {})).rejects.toMatchObject({
      status: 400,
      response: { data: { error: { code: 'INVALID_WORKFLOW_TRANSITION' } } },
    });

    const read = await GET(`/trip-planner/TripRequests(${tripRequest.ID})`);
    expect((read.data as CreatedTripRequest).status).toBe('DRAFT');
    const workflowRuns = await readWorkflowRuns(tripRequest.ID);
    expect(workflowRuns).toHaveLength(1);
    expect(workflowRuns[0]?.state).toBe('BROKEN');
  });

  it('deletes a WorkflowRun together with its draft TripRequest', async () => {
    const created = await POST('/trip-planner/TripRequests', validTripRequest);
    const tripRequest = created.data as CreatedTripRequest;
    const entityUrl = `/trip-planner/TripRequests(${tripRequest.ID})`;
    await cds.db.run(
      cds.ql.INSERT.into('trip.planner.WorkflowRuns').entries({
        ID: randomUUID(),
        tripRequest_ID: tripRequest.ID,
        state: 'NEEDS_CLARIFICATION',
        errorCode: 'CLARIFICATION_REQUIRED',
        errorMessage: 'Brakujące dane.',
      }),
    );

    await DELETE_REQUEST(entityUrl);

    await expect(GET(entityUrl)).rejects.toMatchObject({ status: 404 });
    await expect(readWorkflowRuns(tripRequest.ID)).resolves.toHaveLength(0);
  });

  it('keeps WorkflowRuns read-only through the public service', async () => {
    await expect(
      POST('/trip-planner/WorkflowRuns', {
        ID: randomUUID(),
        tripRequest_ID: randomUUID(),
        state: 'COLLECTING',
      }),
    ).rejects.toMatchObject({ status: 405 });
  });

  it('rolls back TripRequest and WorkflowRun when the action fails before commit', async () => {
    const created = await POST('/trip-planner/TripRequests', validTripRequest);
    const tripRequest = created.data as CreatedTripRequest;

    await expect(
      POST(actionUrl(tripRequest.ID), {}, { headers: { [forceRollbackHeader]: 'true' } }),
    ).rejects.toMatchObject({ status: 500 });

    const read = await GET(`/trip-planner/TripRequests(${tripRequest.ID})`);
    expect((read.data as CreatedTripRequest).status).toBe('DRAFT');
    await expect(readWorkflowRuns(tripRequest.ID)).resolves.toHaveLength(0);
  });
});
