import { randomUUID } from 'node:crypto';
import cds from '@sap/cds';
import type { Request } from '@sap/cds';
import { confirmTripRequestStatus, DomainError } from './domain/trip-request.ts';
import { transitionWorkflowState } from './domain/workflow-run.ts';
import {
  materializeProfiles,
  mergeTripRequest,
  normalizeTripRequest,
  type MutableTripRequest,
  type PersistedTripRequest,
} from './mapping/trip-request-mapper.ts';
import { validateTripRequest } from './validation/trip-request-validation.ts';

interface PersistedWorkflowRun {
  ID: string;
  tripRequest_ID: string;
  state: string;
  errorCode: string | null;
  errorMessage: string | null;
}

/** Tłumaczy błąd domenowy na kontrolowaną odpowiedź HTTP 400 bez gubienia jego kodu. */
function rejectDomainError(request: Request, error: unknown): never {
  if (error instanceof DomainError) {
    return request.reject({ status: 400, code: error.code, message: error.message });
  }

  throw error;
}

export default class TripPlannerService extends cds.ApplicationService {
  override async init(): Promise<void> {
    const { TripRequests } = this.entities;
    const { WorkflowRuns: PersistedWorkflowRuns } = cds.entities('trip.planner');
    const { DELETE, INSERT, SELECT, UPDATE } = cds.ql;
    if (!TripRequests || !PersistedWorkflowRuns) {
      throw new Error('Brak wymaganych encji TripRequests lub WorkflowRuns w modelu.');
    }

    // Obecny formularz nie wysyła jeszcze profili, dlatego backend materializuje ich defaults.
    this.before('CREATE', TripRequests, (request: Request) => {
      const data = request.data as MutableTripRequest;
      data.status = 'DRAFT';

      try {
        const normalized = normalizeTripRequest(data);
        validateTripRequest(normalized);
        materializeProfiles(data, normalized);
      } catch (error) {
        rejectDomainError(request, error);
      }
    });

    // Płaski PATCH profilu łączymy z pełnym rekordem przed walidacją domenową.
    this.before('UPDATE', TripRequests, async (request: Request) => {
      const ID = String(request.data.ID ?? request.params[0]?.ID ?? '');
      const current = (await SELECT.one.from(TripRequests).where({ ID })) as
        PersistedTripRequest | undefined;
      if (!current) {
        request.reject(404, 'Nie znaleziono briefu podróży.');
      }
      if (current.status !== 'DRAFT') {
        request.reject(409, 'Potwierdzonego briefu nie można edytować.');
      }
      if (request.data.status !== undefined && request.data.status !== current.status) {
        request.reject(400, 'Status briefu można zmienić wyłącznie przez dedykowaną akcję.');
      }

      try {
        const data = request.data as MutableTripRequest;
        const normalized = normalizeTripRequest(mergeTripRequest(current, data));
        validateTripRequest(normalized);
        materializeProfiles(data, normalized);
      } catch (error) {
        rejectDomainError(request, error);
      }
    });

    // Usunięcie jest dozwolone wyłącznie dla roboczego, jeszcze niepotwierdzonego briefu.
    this.before('DELETE', TripRequests, async (request: Request) => {
      const ID = String(request.data.ID ?? request.params[0]?.ID ?? '');
      const transaction = cds.tx(request);
      const current = (await transaction.run(SELECT.one.from(TripRequests).where({ ID }))) as
        PersistedTripRequest | undefined;
      if (!current) {
        request.reject(404, 'Nie znaleziono briefu podróży.');
      }
      if (current.status !== 'DRAFT') {
        request.reject(409, 'Można usunąć wyłącznie wersję roboczą briefu.');
      }

      // Generic DELETE briefu wykona się później w tej samej transakcji requestu.
      await transaction.run(DELETE.from(PersistedWorkflowRuns).where({ tripRequest_ID: ID }));
    });

    // Oba zapisy należą do transakcji bieżącego requestu; błąd wycofuje je razem.
    this.on('confirmConstraints', async (request: Request) => {
      const ID = String(request.params[0]?.ID ?? '');
      const transaction = cds.tx(request);

      try {
        const current = (await transaction.run(SELECT.one.from(TripRequests).where({ ID }))) as
          PersistedTripRequest | undefined;
        if (!current) {
          return request.reject(404, 'Nie znaleziono briefu podróży.');
        }

        const normalized = normalizeTripRequest(current);
        validateTripRequest(normalized);
        const status = confirmTripRequestStatus(current.status);

        const workflowRun = (await transaction.run(
          SELECT.one.from(PersistedWorkflowRuns).where({ tripRequest_ID: ID }),
        )) as PersistedWorkflowRun | undefined;
        const workflowState = transitionWorkflowState(
          workflowRun?.state ?? 'COLLECTING',
          'CONSTRAINTS_CONFIRMED',
        );

        const updatedRows = (await transaction.run(
          UPDATE.entity(TripRequests).set({ status }).where({ ID, status: 'DRAFT' }),
        )) as number;
        if (updatedRows !== 1) {
          throw new DomainError(
            'TRIP_REQUEST_ALREADY_CONFIRMED',
            'Ograniczenia dla tego briefu zostały już potwierdzone.',
          );
        }

        if (workflowRun) {
          await transaction.run(
            UPDATE.entity(PersistedWorkflowRuns)
              .set({ state: workflowState, errorCode: null, errorMessage: null })
              .where({ ID: workflowRun.ID }),
          );
        } else {
          await transaction.run(
            INSERT.into(PersistedWorkflowRuns).entries({
              ID: randomUUID(),
              tripRequest_ID: ID,
              state: workflowState,
              errorCode: null,
              errorMessage: null,
            }),
          );
        }

        return transaction.run(SELECT.one.from(TripRequests).where({ ID }));
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
