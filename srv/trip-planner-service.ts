import cds from '@sap/cds';
import type { Request } from '@sap/cds';
import {
  confirmTripRequestStatus,
  DomainError,
  type TripRequestStatus,
} from './domain/trip-request.ts';
import {
  validateTripRequest,
  type TripRequestValidationInput,
} from './validation/trip-request-validation.ts';

interface PersistedTripRequest extends TripRequestValidationInput {
  ID: string;
  status: TripRequestStatus;
}

type MutableTripRequest = Partial<PersistedTripRequest>;

function normalizeTripRequest(data: MutableTripRequest): TripRequestValidationInput {
  return {
    originCity: String(data.originCity ?? ''),
    startDate: String(data.startDate ?? ''),
    endDate: String(data.endDate ?? ''),
    adults: Number(data.adults),
    totalBudget: Number(data.totalBudget),
    currency: String(data.currency ?? ''),
    pace: String(data.pace ?? ''),
  };
}

function rejectDomainError(request: Request, error: unknown): never {
  if (error instanceof DomainError) {
    return request.reject({ status: 400, code: error.code, message: error.message });
  }

  throw error;
}

export default class TripPlannerService extends cds.ApplicationService {
  override async init(): Promise<void> {
    const { TripRequests } = this.entities;
    const { SELECT, UPDATE } = cds.ql;
    if (!TripRequests) {
      throw new Error('Brak encji TripRequests w modelu usługi.');
    }

    this.before('CREATE', TripRequests, (request: Request) => {
      const data = request.data as MutableTripRequest;
      data.status = 'DRAFT';
      try {
        validateTripRequest(normalizeTripRequest(data));
      } catch (error) {
        rejectDomainError(request, error);
      }
    });

    this.before('UPDATE', TripRequests, async (request: Request) => {
      const ID = String(request.data.ID ?? request.params[0]?.ID ?? '');
      const current = await SELECT.one.from(TripRequests).where({ ID });
      if (!current) {
        request.reject(404, 'Nie znaleziono briefu podróży.');
      }
      if ((current as PersistedTripRequest).status !== 'DRAFT') {
        request.reject(409, 'Potwierdzonego briefu nie można edytować.');
      }
      if (request.data.status !== undefined && request.data.status !== current.status) {
        request.reject(400, 'Status briefu można zmienić wyłącznie przez dedykowaną akcję.');
      }

      try {
        validateTripRequest(normalizeTripRequest({ ...current, ...request.data }));
      } catch (error) {
        rejectDomainError(request, error);
      }
    });

    this.before('DELETE', TripRequests, async (request: Request) => {
      const ID = String(request.data.ID ?? request.params[0]?.ID ?? '');
      const current = await SELECT.one.from(TripRequests).where({ ID });
      if (!current) {
        request.reject(404, 'Nie znaleziono briefu podróży.');
      }
      if ((current as PersistedTripRequest).status !== 'DRAFT') {
        request.reject(409, 'Można usunąć wyłącznie wersję roboczą briefu.');
      }
    });

    this.on('confirmConstraints', async (request: Request) => {
      const ID = String(request.params[0]?.ID ?? '');
      const current = (await SELECT.one.from(TripRequests).where({ ID })) as
        PersistedTripRequest | undefined;
      if (!current) {
        return request.reject(404, 'Nie znaleziono briefu podróży.');
      }

      try {
        validateTripRequest(normalizeTripRequest(current));
        const status = confirmTripRequestStatus(current.status);
        await UPDATE.entity(TripRequests).set({ status }).where({ ID });
        return SELECT.one.from(TripRequests).where({ ID });
      } catch (error) {
        if (error instanceof DomainError && error.code === 'TRIP_REQUEST_ALREADY_CONFIRMED') {
          return request.reject({ status: 409, code: error.code, message: error.message });
        }
        return rejectDomainError(request, error);
      }
    });

    await super.init();
  }
}
