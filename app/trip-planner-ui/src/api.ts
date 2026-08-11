export const PACE_VALUES = ['RELAXED', 'BALANCED', 'INTENSIVE'] as const;
export type Pace = (typeof PACE_VALUES)[number];
export type TripRequestStatus = 'DRAFT' | 'CONSTRAINTS_CONFIRMED';

export interface HardConstraints {
  hardBudgetLimit: boolean;
  earliestDepartureTime: string;
  latestReturnTime: string;
  maxConnections: number;
  maxTravelMinutes: number;
  allowFlight: boolean;
  allowTrain: boolean;
  allowBus: boolean;
}

export interface SoftPreferences {
  food: number;
  nature: number;
  history: number;
  museums: number;
  nightlife: number;
  centralAccommodation: number;
  travelComfort: number;
  priceSensitivity: number;
}

export interface TripRequestDraft {
  originCity: string;
  startDate: string;
  endDate: string;
  adults: number;
  totalBudget: number;
  currency: string;
  pace: Pace;
  hardConstraints: HardConstraints;
  softPreferences: SoftPreferences;
}

export interface TripRequest extends TripRequestDraft {
  ID: string;
  status: TripRequestStatus;
  createdAt: string;
  modifiedAt: string;
}

interface TripRequestWire extends Omit<TripRequest, 'hardConstraints' | 'softPreferences'> {
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

export interface WorkflowRun {
  ID: string;
  tripRequest_ID: string;
  state: string;
  errorCode: string | null;
  errorMessage: string | null;
}

export interface PlanningRun {
  ID: string;
  tripRequest_ID: string;
  workflowRun_ID: string;
  status: 'SUCCEEDED' | 'INSUFFICIENT_OPTIONS';
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

export interface RankedOption {
  ID: string;
  tripRequest_ID: string;
  workflowRun_ID: string;
  planningRun_ID: string;
  providerFixtureVersion: string;
  scoringVersion: string;
  rank: number;
  role: 'BEST_OVERALL' | 'MOST_CONVENIENT' | 'BEST_VALUE';
  candidateId: string;
  destinationCode: string;
  destinationCity: string;
  destinationCountryCode: string;
  transportId: string;
  transportMode: 'FLIGHT' | 'TRAIN' | 'BUS';
  outboundDepartureAt: string;
  outboundArrivalAt: string;
  returnDepartureAt: string;
  returnArrivalAt: string;
  outboundTravelMinutes: number;
  returnTravelMinutes: number;
  maximumConnections: number;
  effectiveTimeAtDestinationMinutes: number;
  stayId: string;
  stayName: string;
  checkInDate: string;
  checkOutDate: string;
  nights: number;
  accommodationCentralityScore: number | string;
  currency: string;
  budgetLimitMinor: number | string;
  confirmedAmountMinor: number | string;
  estimatedAmountMinor: number | string;
  unknownCategoryCount: number;
  totalAmountMinor: number | string;
  costPerPersonMinor: number | string;
  remainingBudgetMinor: number | string;
  totalScore: number | string;
  budgetFitScore: number | string;
  travelTimeScore: number | string;
  effectiveTimeScore: number | string;
  accommodationLocationScore: number | string;
  dataCompletenessScore: number | string;
  priceConfidenceScore: number | string;
  preferenceFitScore: number | string;
}

export interface BudgetItem {
  ID: string;
  planningRun_ID: string;
  rankedOption_ID: string;
  sourceSnapshot_ID: string | null;
  category: string;
  priceType: string;
  classification: 'CONFIRMED' | 'ESTIMATED' | 'UNKNOWN';
  currency: string;
  amountMinor: number | string | null;
}

export interface SourceSnapshot {
  ID: string;
  planningRun_ID: string;
  rankedOption_ID: string;
  provider: string;
  externalItemId: string;
  fetchedAt: string;
  sourceUrl: string;
  freshnessType: string;
  currency: string;
  fixtureVersion: string;
  contexts: string;
  demonstrationData: boolean;
}

export interface OptionNote {
  ID: string;
  planningRun_ID: string;
  rankedOption_ID: string;
  kind: 'ADVANTAGE' | 'TRADEOFF' | 'RISK';
  sequence: number;
  code: string;
  text: string;
}

export interface RejectionReason {
  ID: string;
  planningRun_ID: string;
  candidateId: string;
  code: string;
  message: string;
  expectedValue: string;
  actualValue: string;
  detailsJson: string;
}

export interface RejectionSummary {
  ID: string;
  planningRun_ID: string;
  code: string;
  candidateCount: number;
  occurrenceCount: number;
}

export interface PlanningView {
  workflowRun: WorkflowRun;
  planningRun: PlanningRun;
  rankedOptions: RankedOption[];
  budgetItems: BudgetItem[];
  sourceSnapshots: SourceSnapshot[];
  optionNotes: OptionNote[];
  rejectionReasons: RejectionReason[];
  rejectionSummaries: RejectionSummary[];
}

interface ODataErrorBody {
  error?: {
    code?: string;
    message?: string | { value?: string };
  };
}

interface ODataCollection<T> {
  value: T[];
}

export class ApiError extends Error {
  public readonly code: string | null;
  public readonly status: number;

  constructor(message: string, status: number, code: string | null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

const serviceUrl = '/trip-planner';

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${serviceUrl}${path}`, {
    ...init,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...init.headers,
    },
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as ODataErrorBody;
    const rawMessage = body.error?.message;
    const message =
      typeof rawMessage === 'string'
        ? rawMessage
        : (rawMessage?.value ?? `Backend zwrócił błąd ${response.status}.`);
    throw new ApiError(message, response.status, body.error?.code ?? null);
  }

  return (await response.json()) as T;
}

function normalizeTripRequest(wire: TripRequestWire): TripRequest {
  return {
    ID: wire.ID,
    originCity: wire.originCity,
    startDate: wire.startDate,
    endDate: wire.endDate,
    adults: wire.adults,
    totalBudget: wire.totalBudget,
    currency: wire.currency,
    pace: wire.pace,
    status: wire.status,
    createdAt: wire.createdAt,
    modifiedAt: wire.modifiedAt,
    hardConstraints: {
      hardBudgetLimit: wire.hardConstraints_hardBudgetLimit,
      earliestDepartureTime: wire.hardConstraints_earliestDepartureTime ?? '',
      latestReturnTime: wire.hardConstraints_latestReturnTime ?? '',
      maxConnections: wire.hardConstraints_maxConnections,
      maxTravelMinutes: wire.hardConstraints_maxTravelMinutes ?? 0,
      allowFlight: wire.hardConstraints_allowFlight,
      allowTrain: wire.hardConstraints_allowTrain,
      allowBus: wire.hardConstraints_allowBus,
    },
    softPreferences: {
      food: wire.softPreferences_food,
      nature: wire.softPreferences_nature,
      history: wire.softPreferences_history,
      museums: wire.softPreferences_museums,
      nightlife: wire.softPreferences_nightlife,
      centralAccommodation: wire.softPreferences_centralAccommodation,
      travelComfort: wire.softPreferences_travelComfort,
      priceSensitivity: wire.softPreferences_priceSensitivity,
    },
  };
}

function tripRequestPayload(draft: TripRequestDraft): Record<string, unknown> {
  return {
    originCity: draft.originCity,
    startDate: draft.startDate,
    endDate: draft.endDate,
    adults: draft.adults,
    totalBudget: draft.totalBudget,
    currency: draft.currency,
    pace: draft.pace,
    hardConstraints_hardBudgetLimit: draft.hardConstraints.hardBudgetLimit,
    hardConstraints_earliestDepartureTime: draft.hardConstraints.earliestDepartureTime || null,
    hardConstraints_latestReturnTime: draft.hardConstraints.latestReturnTime || null,
    hardConstraints_maxConnections: draft.hardConstraints.maxConnections,
    hardConstraints_maxTravelMinutes: draft.hardConstraints.maxTravelMinutes || null,
    hardConstraints_allowFlight: draft.hardConstraints.allowFlight,
    hardConstraints_allowTrain: draft.hardConstraints.allowTrain,
    hardConstraints_allowBus: draft.hardConstraints.allowBus,
    softPreferences_food: draft.softPreferences.food,
    softPreferences_nature: draft.softPreferences.nature,
    softPreferences_history: draft.softPreferences.history,
    softPreferences_museums: draft.softPreferences.museums,
    softPreferences_nightlife: draft.softPreferences.nightlife,
    softPreferences_centralAccommodation: draft.softPreferences.centralAccommodation,
    softPreferences_travelComfort: draft.softPreferences.travelComfort,
    softPreferences_priceSensitivity: draft.softPreferences.priceSensitivity,
  };
}

export async function createTripRequest(draft: TripRequestDraft): Promise<TripRequest> {
  const wire = await request<TripRequestWire>('/TripRequests', {
    method: 'POST',
    body: JSON.stringify(tripRequestPayload(draft)),
  });
  return normalizeTripRequest(wire);
}

export async function confirmConstraints(ID: string): Promise<TripRequest> {
  const wire = await request<TripRequestWire>(
    `/TripRequests(${encodeURIComponent(ID)})/TripPlannerService.confirmConstraints`,
    { method: 'POST', body: '{}' },
  );
  return normalizeTripRequest(wire);
}

export function startPlanning(ID: string): Promise<PlanningRun> {
  return request<PlanningRun>(
    `/TripRequests(${encodeURIComponent(ID)})/TripPlannerService.startPlanning`,
    { method: 'POST', body: '{}' },
  );
}

async function readCollection<T>(
  entity: string,
  field: 'tripRequest_ID' | 'planningRun_ID',
  ID: string,
  orderBy?: string,
): Promise<T[]> {
  const filter = encodeURIComponent(`${field} eq ${ID}`);
  const ordering = orderBy ? `&$orderby=${encodeURIComponent(orderBy)}` : '';
  const result = await request<ODataCollection<T>>(`/${entity}?$filter=${filter}${ordering}`);
  return result.value;
}

export async function readPlanningView(
  tripRequestID: string,
  planningRun: PlanningRun,
): Promise<PlanningView> {
  const [
    workflowRuns,
    rankedOptions,
    budgetItems,
    sourceSnapshots,
    optionNotes,
    rejectionReasons,
    rejectionSummaries,
  ] = await Promise.all([
    readCollection<WorkflowRun>('WorkflowRuns', 'tripRequest_ID', tripRequestID),
    readCollection<RankedOption>('RankedOptions', 'planningRun_ID', planningRun.ID, 'rank'),
    readCollection<BudgetItem>('BudgetItems', 'planningRun_ID', planningRun.ID, 'category'),
    readCollection<SourceSnapshot>('SourceSnapshots', 'planningRun_ID', planningRun.ID, 'provider'),
    readCollection<OptionNote>('OptionNotes', 'planningRun_ID', planningRun.ID, 'sequence'),
    readCollection<RejectionReason>('RejectionReasons', 'planningRun_ID', planningRun.ID, 'code'),
    readCollection<RejectionSummary>(
      'RejectionSummaries',
      'planningRun_ID',
      planningRun.ID,
      'code',
    ),
  ]);
  const workflowRun = workflowRuns[0];
  if (!workflowRun) throw new Error('Brak WorkflowRun dla zapisanego wyniku planowania.');
  if (planningRun.status === 'SUCCEEDED' && rankedOptions.length !== 3) {
    throw new Error('Udane planowanie nie zwróciło dokładnie trzech wariantów.');
  }
  if (planningRun.status !== 'SUCCEEDED' && rankedOptions.length !== 0) {
    throw new Error('Nieudane planowanie zawiera częściowo zapisane warianty.');
  }

  return {
    workflowRun,
    planningRun,
    rankedOptions,
    budgetItems,
    sourceSnapshots,
    optionNotes,
    rejectionReasons,
    rejectionSummaries,
  };
}
