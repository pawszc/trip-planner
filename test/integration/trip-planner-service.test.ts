import { randomUUID } from 'node:crypto';
import type { Request } from '@sap/cds';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CURRENCY_CONTRACT_VERSION, SUPPORTED_CURRENCY_CODES } from '../../srv/domain/currency.ts';
import type { HardConstraints, SoftPreferences } from '../../srv/domain/trip-request.js';
import type { CandidateEngineProviders } from '../../srv/orchestration/candidate-engine.ts';
import { MOCK_FIXTURE_VERSION } from '../../srv/providers/fixtures/fixture-source.js';
import {
  customHardConstraints,
  customSoftPreferences,
  customTripRequestODataPayload,
  referenceTripRequestODataPayload,
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
  startDate: string;
  endDate: string;
  totalBudget: number | string;
  currency: string;
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

interface PlanningRunResponse {
  ID: string;
  tripRequest_ID: string;
  workflowRun_ID: string;
  requestFingerprint: string;
  status: 'SUCCEEDED' | 'INSUFFICIENT_OPTIONS';
  currencyContractVersion: string | null;
  providerFixtureVersion: string;
  engineVersion: string;
  scoringVersion: string;
  builtCandidateCount: number;
  validCandidateCount: number;
  rejectedCandidateCount: number;
  selectedOptionCount: number;
  errorCode: string | null;
  errorMessage: string | null;
}

interface WorkflowTransitionResponse {
  planningRun_ID: string;
  sequence: number;
  fromState: string;
  toState: string;
}

interface RankedOptionResponse {
  ID: string;
  tripRequest_ID: string;
  workflowRun_ID: string;
  planningRun_ID: string;
  providerFixtureVersion: string;
  scoringVersion: string;
  rank: number;
  role: string;
  destinationCode: string;
  destinationCity: string;
  transportMode: string;
  currency: string;
  budgetLimitMinor: number | string;
  totalAmountMinor: number | string;
  costPerPersonMinor: number | string;
  confirmedAmountMinor: number | string;
  estimatedAmountMinor: number | string;
  unknownCategoryCount: number;
  remainingBudgetMinor: number | string;
  totalScore: number | string;
}

interface BudgetItemResponse {
  rankedOption_ID: string;
  planningRun_ID: string;
  sourceSnapshot_ID: string | null;
  providerFixtureVersion: string;
  scoringVersion: string;
  category: string;
  priceType: 'LIVE_PRICE' | 'FIXED_PRICE' | 'ESTIMATE' | 'UNKNOWN';
  classification: 'CONFIRMED' | 'ESTIMATED' | 'UNKNOWN';
  currency: string;
  amountMinor: number | string | null;
  confirmedAmountMinor: number | string | null;
  estimatedAmountMinor: number | string | null;
}

interface SourceSnapshotResponse {
  ID: string;
  tripRequest_ID: string;
  workflowRun_ID: string;
  planningRun_ID: string;
  rankedOption_ID: string;
  providerFixtureVersion: string;
  scoringVersion: string;
  currency: string;
  provider: string;
  sourceUrl: string;
  fixtureVersion: string;
  demonstrationData: boolean;
}

interface RejectionReasonResponse {
  candidateId: string;
  planningRun_ID: string;
  code: string;
  message: string;
}

interface RejectionSummaryResponse {
  planningRun_ID: string;
  code: string;
  candidateCount: number;
  occurrenceCount: number;
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
const observeConcurrentPlanningHeader = 'x-test-observe-concurrent-planning';
let concurrentPlanningRequestObserver: (() => void) | null = null;

function actionUrl(ID: string): string {
  return `/trip-planner/TripRequests(${ID})/TripPlannerService.confirmConstraints`;
}

function startPlanningActionUrl(ID: string): string {
  return `/trip-planner/TripRequests(${ID})/TripPlannerService.startPlanning`;
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

async function readPlanningCollection<T>(
  entity: string,
  field: 'tripRequest_ID' | 'planningRun_ID',
  ID: string,
  orderBy?: string,
): Promise<T[]> {
  const filter = encodeURIComponent(`${field} eq ${ID}`);
  const order = orderBy ? `&$orderby=${encodeURIComponent(orderBy)}` : '';
  const response = await GET(`/trip-planner/${entity}?$filter=${filter}${order}`);
  return (response.data as ODataCollection<T>).value;
}

async function createConfirmedReferenceTrip(): Promise<CreatedTripRequest> {
  const created = await POST('/trip-planner/TripRequests', referenceTripRequestODataPayload);
  const tripRequest = created.data as CreatedTripRequest;
  await POST(actionUrl(tripRequest.ID), {});
  return tripRequest;
}

async function startReferencePlanning(tripRequestID: string): Promise<PlanningRunResponse> {
  const response = await POST(startPlanningActionUrl(tripRequestID), {});
  return response.data as PlanningRunResponse;
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
  service.before('startPlanning', (request: Request) => {
    if (request.headers[observeConcurrentPlanningHeader] === 'true') {
      concurrentPlanningRequestObserver?.();
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

  it.each(SUPPORTED_CURRENCY_CODES)(
    'accepts supported currency %s through persistence and deterministic planning',
    async (currency) => {
      const created = await POST('/trip-planner/TripRequests', {
        ...referenceTripRequestODataPayload,
        currency,
      });
      const tripRequest = created.data as CreatedTripRequest;
      expect(tripRequest.currency).toBe(currency);
      await POST(actionUrl(tripRequest.ID), {});
      const planningRun = await startReferencePlanning(tripRequest.ID);
      const options = await readPlanningCollection<RankedOptionResponse>(
        'RankedOptions',
        'planningRun_ID',
        planningRun.ID,
      );
      const budgetItems = await readPlanningCollection<BudgetItemResponse>(
        'BudgetItems',
        'planningRun_ID',
        planningRun.ID,
      );

      expect(planningRun.status).toBe('SUCCEEDED');
      expect(options).toHaveLength(3);
      expect(options.every((option) => option.currency === currency)).toBe(true);
      expect(options.every((option) => Number(option.budgetLimitMinor) === 450_000)).toBe(true);
      expect(budgetItems).toHaveLength(21);
      expect(budgetItems.every((item) => item.currency === currency)).toBe(true);
    },
  );

  it.each(['JPY', 'KWD', 'USD', 'ZZZ'])(
    'rejects currency %s outside the closed contract before persistence',
    async (currency) => {
      await expect(
        POST('/trip-planner/TripRequests', { ...validTripRequest, currency }),
      ).rejects.toMatchObject({
        status: 400,
        response: { data: { error: { code: 'INVALID_CURRENCY' } } },
      });
      const persisted = await GET('/trip-planner/TripRequests');
      expect((persisted.data as ODataCollection<CreatedTripRequest>).value).toHaveLength(0);
    },
  );

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

  it.each(['2026-02-29', '2026-04-31'])(
    'rejects a non-existing date on CREATE (%s)',
    async (startDate) => {
      await expect(
        POST('/trip-planner/TripRequests', { ...validTripRequest, startDate }),
      ).rejects.toMatchObject({
        status: 400,
        response: { data: { error: { code: 'INVALID_TRAVEL_DATES' } } },
      });
    },
  );

  it('accepts a leap day on CREATE', async () => {
    const created = await POST('/trip-planner/TripRequests', {
      ...validTripRequest,
      startDate: '2028-02-29',
      endDate: '2028-03-01',
    });

    expect(created.data).toMatchObject({ startDate: '2028-02-29', endDate: '2028-03-01' });
  });

  it('rejects a non-existing date on UPDATE and preserves the saved DRAFT', async () => {
    const created = await POST('/trip-planner/TripRequests', validTripRequest);
    const tripRequest = created.data as CreatedTripRequest;
    const entityUrl = `/trip-planner/TripRequests(${tripRequest.ID})`;

    await expect(PATCH(entityUrl, { endDate: '2026-02-29' })).rejects.toMatchObject({
      status: 400,
      response: { data: { error: { code: 'INVALID_TRAVEL_DATES' } } },
    });
    const persisted = await GET(entityUrl);
    expect(persisted.data).toMatchObject({
      startDate: validTripRequest.startDate,
      endDate: validTripRequest.endDate,
      status: 'DRAFT',
    });
  });

  it('strictly revalidates persisted dates in confirmConstraints', async () => {
    const created = await POST('/trip-planner/TripRequests', validTripRequest);
    const tripRequest = created.data as CreatedTripRequest;
    await cds.db.run(
      cds.ql.UPDATE.entity('trip.planner.TripRequests')
        .set({ startDate: '2026-02-29' })
        .where({ ID: tripRequest.ID }),
    );

    await expect(POST(actionUrl(tripRequest.ID), {})).rejects.toMatchObject({
      status: 400,
      response: { data: { error: { code: 'INVALID_TRAVEL_DATES' } } },
    });
    await expect(readWorkflowRuns(tripRequest.ID)).resolves.toHaveLength(0);
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

  it('rejects startPlanning for a DRAFT without creating planning persistence', async () => {
    const created = await POST('/trip-planner/TripRequests', referenceTripRequestODataPayload);
    const tripRequest = created.data as CreatedTripRequest;

    await expect(POST(startPlanningActionUrl(tripRequest.ID), {})).rejects.toMatchObject({
      status: 409,
      response: { data: { error: { code: 'TRIP_REQUEST_NOT_CONFIRMED' } } },
    });
    await expect(
      readPlanningCollection<PlanningRunResponse>('PlanningRuns', 'tripRequest_ID', tripRequest.ID),
    ).resolves.toHaveLength(0);
  });

  it('rejects startPlanning for a missing TripRequest', async () => {
    await expect(POST(startPlanningActionUrl(randomUUID()), {})).rejects.toMatchObject({
      status: 404,
    });
  });

  it('strictly revalidates persisted dates in startPlanning', async () => {
    const tripRequest = await createConfirmedReferenceTrip();
    await cds.db.run(
      cds.ql.UPDATE.entity('trip.planner.TripRequests')
        .set({ endDate: '2026-04-31' })
        .where({ ID: tripRequest.ID }),
    );

    await expect(POST(startPlanningActionUrl(tripRequest.ID), {})).rejects.toMatchObject({
      status: 400,
      response: { data: { error: { code: 'INVALID_TRAVEL_DATES' } } },
    });
    await expect(
      readPlanningCollection<PlanningRunResponse>('PlanningRuns', 'tripRequest_ID', tripRequest.ID),
    ).resolves.toHaveLength(0);
  });

  it('rejects an unsupported persisted currency before major-to-minor conversion', async () => {
    const tripRequest = await createConfirmedReferenceTrip();
    await cds.db.run(
      cds.ql.UPDATE.entity('trip.planner.TripRequests')
        .set({ currency: 'JPY' })
        .where({ ID: tripRequest.ID }),
    );

    await expect(POST(startPlanningActionUrl(tripRequest.ID), {})).rejects.toMatchObject({
      status: 400,
      response: { data: { error: { code: 'INVALID_CURRENCY' } } },
    });
    await expect(
      readPlanningCollection<PlanningRunResponse>('PlanningRuns', 'tripRequest_ID', tripRequest.ID),
    ).resolves.toHaveLength(0);
  });

  it('runs the confirmed reference workflow in the required order and persists three roles', async () => {
    const tripRequest = await createConfirmedReferenceTrip();
    const planningRun = await startReferencePlanning(tripRequest.ID);
    const workflowRuns = await readWorkflowRuns(tripRequest.ID);
    const transitions = await readPlanningCollection<WorkflowTransitionResponse>(
      'WorkflowTransitions',
      'planningRun_ID',
      planningRun.ID,
      'sequence',
    );
    const options = await readPlanningCollection<RankedOptionResponse>(
      'RankedOptions',
      'planningRun_ID',
      planningRun.ID,
      'rank',
    );

    expect(planningRun).toMatchObject({
      status: 'SUCCEEDED',
      tripRequest_ID: tripRequest.ID,
      workflowRun_ID: workflowRuns[0]?.ID,
      currencyContractVersion: CURRENCY_CONTRACT_VERSION,
      providerFixtureVersion: MOCK_FIXTURE_VERSION,
      engineVersion: 'candidate-engine-v1',
      scoringVersion: 'candidate-score-v1:candidate-engine-v1',
      builtCandidateCount: 28,
      validCandidateCount: 6,
      rejectedCandidateCount: 22,
      selectedOptionCount: 3,
      errorCode: null,
    });
    expect(workflowRuns).toHaveLength(1);
    expect(workflowRuns[0]?.state).toBe('OPTIONS_READY');
    expect(
      transitions.map(({ sequence, fromState, toState }) => ({ sequence, fromState, toState })),
    ).toStrictEqual([
      { sequence: 1, fromState: 'CONSTRAINTS_CONFIRMED', toState: 'SEARCHING' },
      { sequence: 2, fromState: 'SEARCHING', toState: 'CANDIDATES_VALIDATED' },
      { sequence: 3, fromState: 'CANDIDATES_VALIDATED', toState: 'OPTIONS_READY' },
    ]);
    expect(options).toHaveLength(3);
    expect(
      options.map(({ rank, role, destinationCode }) => ({ rank, role, destinationCode })),
    ).toStrictEqual([
      { rank: 1, role: 'BEST_OVERALL', destinationCode: 'PRG' },
      { rank: 2, role: 'MOST_CONVENIENT', destinationCode: 'VIE' },
      { rank: 3, role: 'BEST_VALUE', destinationCode: 'BUD' },
    ]);
    expect(
      options.every(
        (option) =>
          option.tripRequest_ID === tripRequest.ID &&
          option.workflowRun_ID === workflowRuns[0]?.ID &&
          option.planningRun_ID === planningRun.ID &&
          option.providerFixtureVersion === MOCK_FIXTURE_VERSION &&
          option.scoringVersion === planningRun.scoringVersion,
      ),
    ).toBe(true);
  });

  it('persists rejection details and a grouped summary for the reference run', async () => {
    const tripRequest = await createConfirmedReferenceTrip();
    const planningRun = await startReferencePlanning(tripRequest.ID);
    const reasons = await readPlanningCollection<RejectionReasonResponse>(
      'RejectionReasons',
      'planningRun_ID',
      planningRun.ID,
    );
    const summaries = await readPlanningCollection<RejectionSummaryResponse>(
      'RejectionSummaries',
      'planningRun_ID',
      planningRun.ID,
      'code',
    );

    expect(new Set(reasons.map((reason) => reason.candidateId)).size).toBe(22);
    expect(reasons.every((reason) => reason.message.length > 0)).toBe(true);
    expect(summaries).toHaveLength(13);
    expect(new Set(summaries.map((summary) => summary.code))).toEqual(
      new Set([
        'BUDGET_EXCEEDED',
        'DEPARTURE_TOO_EARLY',
        'RETURN_TOO_LATE',
        'TOO_MANY_CONNECTIONS',
        'TRANSPORT_MODE_NOT_ALLOWED',
        'TRAVEL_TIME_EXCEEDED',
        'REQUIRED_PRICE_UNKNOWN',
        'SOURCE_MISSING',
        'CURRENCY_MISMATCH',
        'DUPLICATE_CANDIDATE',
        'INSUFFICIENT_TIME_AT_DESTINATION',
        'INVALID_DATES',
        'INCOMPLETE_DATA',
      ]),
    );
    expect(
      summaries.every(
        (summary) =>
          summary.candidateCount >= 1 && summary.occurrenceCount >= summary.candidateCount,
      ),
    ).toBe(true);
  });

  it('links normalized SourceSnapshots and seven BudgetItems to every final option', async () => {
    const tripRequest = await createConfirmedReferenceTrip();
    const planningRun = await startReferencePlanning(tripRequest.ID);
    const workflowRun = (await readWorkflowRuns(tripRequest.ID))[0];
    const options = await readPlanningCollection<RankedOptionResponse>(
      'RankedOptions',
      'planningRun_ID',
      planningRun.ID,
    );
    const sources = await readPlanningCollection<SourceSnapshotResponse>(
      'SourceSnapshots',
      'planningRun_ID',
      planningRun.ID,
    );
    const budgetItems = await readPlanningCollection<BudgetItemResponse>(
      'BudgetItems',
      'planningRun_ID',
      planningRun.ID,
    );
    const budgetBreakdowns = await readPlanningCollection<RankedOptionResponse>(
      'BudgetBreakdowns',
      'planningRun_ID',
      planningRun.ID,
    );

    expect(sources.length).toBeGreaterThan(0);
    expect(
      sources.every(
        (source) =>
          source.tripRequest_ID === tripRequest.ID &&
          source.workflowRun_ID === workflowRun?.ID &&
          source.planningRun_ID === planningRun.ID &&
          source.providerFixtureVersion === MOCK_FIXTURE_VERSION &&
          source.scoringVersion === planningRun.scoringVersion,
      ),
    ).toBe(true);
    expect(
      sources.some(
        (source) =>
          source.provider === 'MockTransportProvider' &&
          source.sourceUrl === 'INTERNAL_FIXTURE' &&
          source.demonstrationData,
      ),
    ).toBe(true);
    expect(budgetItems).toHaveLength(21);
    expect(budgetBreakdowns).toHaveLength(3);

    for (const option of options) {
      const items = budgetItems.filter((item) => item.rankedOption_ID === option.ID);
      expect(items.map((item) => item.category).sort()).toEqual(
        [
          'TRANSPORT',
          'ACCOMMODATION',
          'LOCAL_TRANSPORT',
          'FOOD',
          'ATTRACTIONS',
          'ADDITIONAL_FEES',
          'BUFFER',
        ].sort(),
      );
      expect(items.every((item) => item.sourceSnapshot_ID)).toBe(true);
      expect(items.every((item) => item.amountMinor !== null)).toBe(true);
      expect(
        items.every(
          (item) =>
            item.confirmedAmountMinor !== null &&
            item.estimatedAmountMinor !== null &&
            Number(item.confirmedAmountMinor) + Number(item.estimatedAmountMinor) ===
              Number(item.amountMinor),
        ),
      ).toBe(true);
      expect(items.every((item) => item.currency === option.currency)).toBe(true);
      expect(
        items.every((item) =>
          item.priceType === 'ESTIMATE'
            ? item.classification === 'ESTIMATED'
            : item.priceType === 'UNKNOWN'
              ? item.classification === 'UNKNOWN'
              : item.classification === 'CONFIRMED',
        ),
      ).toBe(true);
      expect(
        items.every(
          (item) =>
            item.providerFixtureVersion === planningRun.providerFixtureVersion &&
            item.scoringVersion === planningRun.scoringVersion,
        ),
      ).toBe(true);
      const confirmed = items.reduce((sum, item) => sum + Number(item.confirmedAmountMinor), 0);
      const estimated = items.reduce((sum, item) => sum + Number(item.estimatedAmountMinor), 0);
      expect(confirmed).toBe(Number(option.confirmedAmountMinor));
      expect(estimated).toBe(Number(option.estimatedAmountMinor));
      expect(confirmed + estimated).toBe(Number(option.totalAmountMinor));
      expect(Number(option.costPerPersonMinor)).toBe(
        Math.ceil(Number(option.totalAmountMinor) / 2),
      );
      expect(Number(option.remainingBudgetMinor)).toBe(
        Number(option.budgetLimitMinor) - Number(option.totalAmountMinor),
      );
      expect(option.unknownCategoryCount).toBe(0);
    }
  });

  it('returns the same successful PlanningRun without duplicate final records', async () => {
    const tripRequest = await createConfirmedReferenceTrip();
    const first = await startReferencePlanning(tripRequest.ID);
    const repeat = await startReferencePlanning(tripRequest.ID);

    expect(repeat.ID).toBe(first.ID);
    await expect(
      readPlanningCollection<PlanningRunResponse>('PlanningRuns', 'tripRequest_ID', tripRequest.ID),
    ).resolves.toHaveLength(1);
    await expect(
      readPlanningCollection<RankedOptionResponse>('RankedOptions', 'planningRun_ID', first.ID),
    ).resolves.toHaveLength(3);
    await expect(
      readPlanningCollection<WorkflowTransitionResponse>(
        'WorkflowTransitions',
        'planningRun_ID',
        first.ID,
      ),
    ).resolves.toHaveLength(3);
  });

  it('coalesces concurrent startPlanning calls into one planning execution', async () => {
    const tripRequest = await createConfirmedReferenceTrip();
    const service = cds.services.TripPlannerService as unknown as {
      createPlanningProviders(): CandidateEngineProviders;
    };
    const originalFactory = service.createPlanningProviders;
    const workingProviders = originalFactory.call(service);
    let planningExecutionCount = 0;
    let arrivedRequestCount = 0;
    let releaseProvider: () => void = () => undefined;
    let signalProviderStarted: () => void = () => undefined;
    let signalBothRequestsArrived: () => void = () => undefined;
    const providerGate = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    const providerStarted = new Promise<void>((resolve) => {
      signalProviderStarted = resolve;
    });
    const bothRequestsArrived = new Promise<void>((resolve) => {
      signalBothRequestsArrived = resolve;
    });
    concurrentPlanningRequestObserver = () => {
      arrivedRequestCount += 1;
      if (arrivedRequestCount === 2) signalBothRequestsArrived();
    };
    service.createPlanningProviders = () => {
      planningExecutionCount += 1;
      return {
        ...workingProviders,
        transport: {
          search: async (providerRequest) => {
            signalProviderStarted();
            await providerGate;
            return workingProviders.transport.search(providerRequest);
          },
        },
      };
    };

    const startObservedPlanning = async (): Promise<PlanningRunResponse> => {
      const response = await POST(
        startPlanningActionUrl(tripRequest.ID),
        {},
        { headers: { [observeConcurrentPlanningHeader]: 'true' } },
      );
      return response.data as PlanningRunResponse;
    };

    try {
      const firstPromise = startObservedPlanning();
      await providerStarted;
      const secondPromise = startObservedPlanning();
      await bothRequestsArrived;
      await new Promise<void>((resolve) => setImmediate(resolve));
      releaseProvider();

      const [first, second] = await Promise.all([firstPromise, secondPromise]);
      expect(planningExecutionCount).toBe(1);
      expect(second.ID).toBe(first.ID);
      await expect(
        readPlanningCollection<PlanningRunResponse>(
          'PlanningRuns',
          'tripRequest_ID',
          tripRequest.ID,
        ),
      ).resolves.toHaveLength(1);
      await expect(
        readPlanningCollection<RankedOptionResponse>('RankedOptions', 'planningRun_ID', first.ID),
      ).resolves.toHaveLength(3);
    } finally {
      releaseProvider();
      concurrentPlanningRequestObserver = null;
      service.createPlanningProviders = originalFactory;
    }
  });

  it('persists a controlled shortage with reasons and no partial final options', async () => {
    const created = await POST('/trip-planner/TripRequests', {
      ...referenceTripRequestODataPayload,
      hardConstraints_maxTravelMinutes: 1,
    });
    const tripRequest = created.data as CreatedTripRequest;
    await POST(actionUrl(tripRequest.ID), {});

    const first = await startReferencePlanning(tripRequest.ID);
    const repeat = await startReferencePlanning(tripRequest.ID);
    const workflowRun = (await readWorkflowRuns(tripRequest.ID))[0];
    const reasons = await readPlanningCollection<RejectionReasonResponse>(
      'RejectionReasons',
      'planningRun_ID',
      first.ID,
    );

    expect(first).toMatchObject({
      status: 'INSUFFICIENT_OPTIONS',
      selectedOptionCount: 0,
      errorCode: 'INSUFFICIENT_VALID_CANDIDATES',
    });
    expect(first.errorMessage).toContain('ograniczenia nie zostały poluzowane');
    expect(repeat.ID).toBe(first.ID);
    expect(workflowRun?.state).toBe('CONSTRAINTS_CONFIRMED');
    expect(reasons.length).toBeGreaterThan(0);
    await expect(
      readPlanningCollection<RankedOptionResponse>('RankedOptions', 'planningRun_ID', first.ID),
    ).resolves.toHaveLength(0);
    await expect(
      readPlanningCollection<PlanningRunResponse>('PlanningRuns', 'tripRequest_ID', tripRequest.ID),
    ).resolves.toHaveLength(1);
  });

  it('rolls back every planning write after a provider error and returns a controlled code', async () => {
    const tripRequest = await createConfirmedReferenceTrip();
    const service = cds.services.TripPlannerService as unknown as {
      createPlanningProviders(): CandidateEngineProviders;
    };
    const originalFactory = service.createPlanningProviders;
    const workingProviders = originalFactory.call(service);
    service.createPlanningProviders = () => ({
      ...workingProviders,
      transport: {
        search: async () => Promise.reject(new Error('provider stack must not leak')),
      },
    });

    try {
      await expect(POST(startPlanningActionUrl(tripRequest.ID), {})).rejects.toMatchObject({
        status: 502,
        response: { data: { error: { code: 'PROVIDER_SEARCH_FAILED' } } },
      });
    } finally {
      service.createPlanningProviders = originalFactory;
    }

    const workflowRuns = await readWorkflowRuns(tripRequest.ID);
    expect(workflowRuns[0]?.state).toBe('CONSTRAINTS_CONFIRMED');
    await expect(
      readPlanningCollection<PlanningRunResponse>('PlanningRuns', 'tripRequest_ID', tripRequest.ID),
    ).resolves.toHaveLength(0);
    await expect(
      readPlanningCollection<RankedOptionResponse>(
        'RankedOptions',
        'tripRequest_ID',
        tripRequest.ID,
      ),
    ).resolves.toHaveLength(0);
    await expect(
      readPlanningCollection<RejectionReasonResponse>(
        'RejectionReasons',
        'tripRequest_ID',
        tripRequest.ID,
      ),
    ).resolves.toHaveLength(0);
  });
});
