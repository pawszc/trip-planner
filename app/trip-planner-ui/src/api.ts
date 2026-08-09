export const PACE_VALUES = ['RELAXED', 'BALANCED', 'INTENSIVE'] as const;
export type Pace = (typeof PACE_VALUES)[number];
export type TripRequestStatus = 'DRAFT' | 'CONSTRAINTS_CONFIRMED';

export interface TripRequestDraft {
  originCity: string;
  startDate: string;
  endDate: string;
  adults: number;
  totalBudget: number;
  currency: string;
  pace: Pace;
}

export interface TripRequest extends TripRequestDraft {
  ID: string;
  status: TripRequestStatus;
  createdAt: string;
  modifiedAt: string;
}

interface ODataErrorBody {
  error?: {
    message?: string | { value?: string };
  };
}

const serviceUrl = '/trip-planner';

async function request<T>(path: string, init: RequestInit): Promise<T> {
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
    throw new Error(message);
  }

  return (await response.json()) as T;
}

export function createTripRequest(draft: TripRequestDraft): Promise<TripRequest> {
  return request<TripRequest>('/TripRequests', {
    method: 'POST',
    body: JSON.stringify(draft),
  });
}

export function confirmConstraints(ID: string): Promise<TripRequest> {
  return request<TripRequest>(
    `/TripRequests(${encodeURIComponent(ID)})/TripPlannerService.confirmConstraints`,
    {
      method: 'POST',
      body: '{}',
    },
  );
}
