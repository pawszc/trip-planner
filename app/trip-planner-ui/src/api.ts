/**
 * Dozwolone tempa zwiedzania. W przyszłości wpłyną na liczbę aktywności
 * proponowanych w ciągu dnia, ale nie zmieniają twardych ograniczeń briefu.
 */
export const PACE_VALUES = ['RELAXED', 'BALANCED', 'INTENSIVE'] as const;
export type Pace = (typeof PACE_VALUES)[number];

/** DRAFT oznacza edytowalny brief, a CONSTRAINTS_CONFIRMED — zatwierdzone ograniczenia. */
export type TripRequestStatus = 'DRAFT' | 'CONSTRAINTS_CONFIRMED';

/** Dane wpisywane w formularzu przed zapisaniem briefu w backendzie. */
export interface TripRequestDraft {
  originCity: string;
  startDate: string;
  endDate: string;
  adults: number;
  totalBudget: number;
  currency: string;
  /**
   * Intensywność zwiedzania: spokojna, zrównoważona albo intensywna.
   * Nie jest to prędkość aplikacji, tylko preferowana gęstość przyszłego planu dnia.
   */
  pace: Pace;
}

/** Pełna postać briefu zwrócona przez CAP po zapisie w bazie. */
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

/**
 * Wspólna obsługa wywołań OData. Zamienia kontrolowany błąd CAP na zwykły Error,
 * dzięki czemu komponent React może pokazać użytkownikowi czytelny komunikat.
 */
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

/** Zapisuje nowy, edytowalny brief ze statusem DRAFT. */
export function createTripRequest(draft: TripRequestDraft): Promise<TripRequest> {
  return request<TripRequest>('/TripRequests', {
    method: 'POST',
    body: JSON.stringify(draft),
  });
}

/** Wywołuje akcję domenową, która ponownie waliduje i zatwierdza ograniczenia. */
export function confirmConstraints(ID: string): Promise<TripRequest> {
  return request<TripRequest>(
    `/TripRequests(${encodeURIComponent(ID)})/TripPlannerService.confirmConstraints`,
    {
      method: 'POST',
      body: '{}',
    },
  );
}
