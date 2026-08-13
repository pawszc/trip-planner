import { randomUUID } from 'node:crypto';
import cds from '@sap/cds';
import type { Request } from '@sap/cds';
import type { AiGateway } from './ai/ai-gateway.ts';
import { loadAiConfig } from './ai/config.ts';
import { createPersistentAiGateway } from './ai/create-persistent-ai-gateway.ts';
import { AI_ERROR_CODE_VALUES, AiError, type AiErrorCode } from './ai/errors.ts';
import { confirmTripRequestStatus, DomainError } from './domain/trip-request.ts';
import { transitionWorkflowState } from './domain/workflow-run.ts';
import {
  materializeProfiles,
  mergeTripRequest,
  normalizeTripRequest,
  type MutableTripRequest,
  type PersistedTripRequest,
} from './mapping/trip-request-mapper.ts';
import {
  runCandidateEngine,
  type CandidateEngineProviders,
} from './orchestration/candidate-engine.ts';
import {
  createPlanningContext,
  createPlanningFingerprint,
} from './orchestration/planning-request.ts';
import { buildPlanningPersistenceBundle } from './persistence/planning-result-records.ts';
import { CapGroundedOptionReader } from './narratives/cap-grounded-option-reader.ts';
import { CapNarrativeWriter } from './narratives/cap-narrative-writer.ts';
import { buildNarrativePersistenceBundle } from './narratives/narrative-persistence.ts';
import { createOptionNarrativeRequest } from './narratives/option-narrative.ts';
import { REFERENCE_DESTINATIONS } from './providers/fixtures/europe-reference-fixtures.ts';
import { MOCK_FIXTURE_VERSION } from './providers/fixtures/fixture-source.ts';
import { MockAccommodationProvider } from './providers/mock-accommodation-provider.ts';
import { MockPlacesProvider } from './providers/mock-places-provider.ts';
import { MockTransportProvider } from './providers/mock-transport-provider.ts';
import { SCORE_VERSION } from './ranking/candidate-scoring.ts';
import { DEFAULT_CANDIDATE_ENGINE_CONFIG } from './ranking/config.ts';
import { validateTripRequest } from './validation/trip-request-validation.ts';

interface PersistedWorkflowRun {
  ID: string;
  tripRequest_ID: string;
  state: string;
  errorCode: string | null;
  errorMessage: string | null;
}

interface PersistedPlanningRun {
  ID: string;
  tripRequest_ID: string;
  workflowRun_ID: string;
  requestFingerprint: string;
  status: 'SUCCEEDED' | 'INSUFFICIENT_OPTIONS';
  selectedOptionCount: number;
  errorCode: string | null;
  errorMessage: string | null;
}

/** Tłumaczy błąd domenowy na kontrolowaną odpowiedź HTTP 400 bez gubienia jego kodu. */
function rejectDomainError(request: Request, error: unknown): never {
  if (error instanceof DomainError) {
    const status =
      error.code === 'PROVIDER_SEARCH_FAILED'
        ? 502
        : [
              'TRIP_REQUEST_NOT_CONFIRMED',
              'WORKFLOW_RUN_NOT_FOUND',
              'PLANNING_ALREADY_IN_PROGRESS',
              'PLANNING_STATE_INCONSISTENT',
            ].includes(error.code)
          ? 409
          : 400;
    return request.reject({ status, code: error.code, message: error.message });
  }

  throw error;
}

/** Zwraca wyłącznie zamknięty kod AI/domeny; raw provider error nie trafia do klienta. */
function rejectNarrativeError(request: Request, error: unknown): never {
  if (error instanceof DomainError) {
    const status = ['RANKED_OPTION_NOT_FOUND', 'PLANNING_RUN_NOT_FOUND'].includes(error.code)
      ? 404
      : error.code === 'INVALID_NARRATIVE_AUDIT_LINK'
        ? 500
        : 409;
    return request.reject({ status, code: error.code, message: error.message });
  }
  const aiError = normalizeAiError(error);
  if (aiError !== null) {
    const status = [
      'AI_DISABLED',
      'LIVE_AI_NOT_ENABLED',
      'MISSING_CREDENTIALS',
      'INVALID_AI_CONFIGURATION',
      'UNSUPPORTED_AI_PROVIDER',
    ].includes(aiError.code)
      ? 503
      : aiError.code === 'AI_AUDIT_FAILED'
        ? 500
        : 502;
    return request.reject({ status, code: aiError.code, message: aiError.message });
  }
  throw error;
}

function normalizeAiError(error: unknown): { code: AiErrorCode; message: string } | null {
  if (error instanceof AiError) return error;
  if (typeof error !== 'object' || error === null) return null;
  const candidate = error as Readonly<Record<string, unknown>>;
  if (
    candidate.name !== 'AiError' ||
    typeof candidate.code !== 'string' ||
    typeof candidate.message !== 'string' ||
    !AI_ERROR_CODE_VALUES.includes(candidate.code as AiErrorCode)
  ) {
    return null;
  }
  return { code: candidate.code as AiErrorCode, message: candidate.message };
}

export default class TripPlannerService extends cds.ApplicationService {
  private readonly activePlanningRequests = new Map<string, Promise<unknown>>();
  private readonly groundedOptionReader = new CapGroundedOptionReader();
  private readonly narrativeWriter = new CapNarrativeWriter();

  /** Jawny seam zależności pozwala testować awarię providera bez flag w publicznym API. */
  public createPlanningProviders(): CandidateEngineProviders {
    return {
      transport: new MockTransportProvider(),
      accommodation: new MockAccommodationProvider(),
      places: new MockPlacesProvider(),
    };
  }

  /** Jawny seam testowy; produkcja nadal używa profilu GENERATE i fail-closed AiRuns. */
  public createNarrativeGateway(): AiGateway {
    return createPersistentAiGateway(loadAiConfig(process.env));
  }

  /**
   * Równoległe requesty tego samego nieedytowalnego briefu współdzielą jedno wykonanie.
   * Obserwatorzy otrzymują wynik dopiero po commicie requestu-właściciela.
   */
  private runPlanningOnce(
    tripRequestId: string,
    request: Request,
    execute: () => Promise<unknown>,
  ): Promise<unknown> {
    const active = this.activePlanningRequests.get(tripRequestId);
    if (active) return active;

    let committedResult: unknown;
    let executionError: unknown;
    let resolveCommitted!: (value: unknown) => void;
    let rejectCommitted!: (reason: unknown) => void;
    const committed = new Promise<unknown>((resolve, reject) => {
      resolveCommitted = resolve;
      rejectCommitted = reject;
    });

    // Właściciel requestu zwraca własny błąd HTTP. Ten handler zapobiega nieobsłużonemu
    // rejection odroczonego Promise, gdy nie było żadnego równoległego obserwatora.
    void committed.catch(() => undefined);
    this.activePlanningRequests.set(tripRequestId, committed);

    request.on('succeeded', () => resolveCommitted(committedResult));
    request.on('failed', () =>
      rejectCommitted(executionError ?? new Error('Nie udało się zatwierdzić wyniku planowania.')),
    );
    request.on('done', () => {
      if (this.activePlanningRequests.get(tripRequestId) === committed) {
        this.activePlanningRequests.delete(tripRequestId);
      }
    });

    return execute().then(
      (result) => {
        committedResult = result;
        return result;
      },
      (error: unknown) => {
        executionError = error;
        throw error;
      },
    );
  }

  override async init(): Promise<void> {
    const { NarrativeRuns, TripRequests } = this.entities;
    const {
      BudgetItems: PersistedBudgetItems,
      OptionNotes: PersistedOptionNotes,
      PlanningRuns: PersistedPlanningRuns,
      RankedOptions: PersistedRankedOptions,
      RejectionReasons: PersistedRejectionReasons,
      RejectionSummaries: PersistedRejectionSummaries,
      SourceSnapshots: PersistedSourceSnapshots,
      WorkflowRuns: PersistedWorkflowRuns,
      WorkflowTransitions: PersistedWorkflowTransitions,
    } = cds.entities('trip.planner');
    const { DELETE, INSERT, SELECT, UPDATE } = cds.ql;
    if (
      !TripRequests ||
      !NarrativeRuns ||
      !PersistedWorkflowRuns ||
      !PersistedPlanningRuns ||
      !PersistedWorkflowTransitions ||
      !PersistedRankedOptions ||
      !PersistedBudgetItems ||
      !PersistedSourceSnapshots ||
      !PersistedOptionNotes ||
      !PersistedRejectionReasons ||
      !PersistedRejectionSummaries
    ) {
      throw new Error('Brak wymaganych encji planowania w modelu persistence.');
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

    // Pipeline działa na niezmiennym, potwierdzonym briefie. Providerzy są wywoływani
    // przed pierwszym zapisem, a cały trwały wynik powstaje w jednej transakcji requestu.
    const executeStartPlanning = async (request: Request, ID: string): Promise<unknown> => {
      const transaction = cds.tx(request);

      try {
        const current = (await transaction.run(SELECT.one.from(TripRequests).where({ ID }))) as
          PersistedTripRequest | undefined;
        if (!current) {
          return request.reject(404, 'Nie znaleziono briefu podróży.');
        }
        if (current.status !== 'CONSTRAINTS_CONFIRMED') {
          throw new DomainError(
            'TRIP_REQUEST_NOT_CONFIRMED',
            'Planowanie można uruchomić dopiero po potwierdzeniu ograniczeń.',
          );
        }

        const normalized = normalizeTripRequest(current);
        validateTripRequest(normalized);
        const workflowRun = (await transaction.run(
          SELECT.one.from(PersistedWorkflowRuns).where({ tripRequest_ID: ID }),
        )) as PersistedWorkflowRun | undefined;
        if (!workflowRun) {
          throw new DomainError(
            'WORKFLOW_RUN_NOT_FOUND',
            'Potwierdzony brief nie ma powiązanego WorkflowRun.',
          );
        }

        const context = createPlanningContext(current);
        const versions = {
          providerFixtureVersion: MOCK_FIXTURE_VERSION,
          engineVersion: DEFAULT_CANDIDATE_ENGINE_CONFIG.version,
          scoringVersion: SCORE_VERSION,
        };
        const requestFingerprint = createPlanningFingerprint(context, versions);
        const existingRun = (await transaction.run(
          SELECT.one.from(PersistedPlanningRuns).where({
            tripRequest_ID: ID,
            requestFingerprint,
          }),
        )) as PersistedPlanningRun | undefined;

        // Potwierdzony brief jest nieedytowalny, dlatego identyczny fingerprint oznacza
        // identyczny wynik. Zwracamy istniejący run zamiast duplikować opcje i diagnostyki.
        if (existingRun) {
          if (existingRun.status === 'SUCCEEDED') {
            const existingOptions = (await transaction.run(
              SELECT.from(PersistedRankedOptions).where({ planningRun_ID: existingRun.ID }),
            )) as unknown[];
            if (workflowRun.state !== 'OPTIONS_READY' || existingOptions.length !== 3) {
              throw new DomainError(
                'PLANNING_STATE_INCONSISTENT',
                'Zapisany wynik planowania nie zawiera dokładnie trzech spójnych opcji.',
              );
            }
          }
          return transaction.run(
            SELECT.one.from(PersistedPlanningRuns).where({ ID: existingRun.ID }),
          );
        }

        if (workflowRun.state !== 'CONSTRAINTS_CONFIRMED') {
          throw new DomainError(
            workflowRun.state === 'SEARCHING'
              ? 'PLANNING_ALREADY_IN_PROGRESS'
              : 'PLANNING_STATE_INCONSISTENT',
            `Planowania nie można rozpocząć ze stanu ${workflowRun.state}.`,
          );
        }

        const startedAt = new Date().toISOString();
        const result = await runCandidateEngine({
          context,
          destinations: REFERENCE_DESTINATIONS,
          providers: this.createPlanningProviders(),
        });
        const bundle = buildPlanningPersistenceBundle({
          tripRequestId: ID,
          workflowRunId: workflowRun.ID,
          requestFingerprint,
          providerFixtureVersion: MOCK_FIXTURE_VERSION,
          startedAt,
          completedAt: new Date().toISOString(),
          context,
          result,
        });

        await transaction.run(INSERT.into(PersistedPlanningRuns).entries(bundle.planningRun));
        if (bundle.rejectionReasons.length > 0) {
          await transaction.run(
            INSERT.into(PersistedRejectionReasons).entries(...bundle.rejectionReasons),
          );
        }
        if (bundle.rejectionSummaries.length > 0) {
          await transaction.run(
            INSERT.into(PersistedRejectionSummaries).entries(...bundle.rejectionSummaries),
          );
        }

        // Niedobór jest trwałym, kontrolowanym wynikiem. Nie zapisujemy nawet dwóch
        // częściowych kart i pozostawiamy WorkflowRun gotowy do świadomej zmiany briefu.
        if (bundle.planningRun.status === 'INSUFFICIENT_OPTIONS') {
          return transaction.run(
            SELECT.one.from(PersistedPlanningRuns).where({ ID: bundle.planningRun.ID }),
          );
        }

        if (bundle.rankedOptions.length !== 3 || bundle.workflowTransitions.length !== 3) {
          throw new DomainError(
            'INVALID_PLANNING_RESULT',
            'Udany wynik musi zawierać dokładnie trzy opcje i trzy przejścia workflow.',
          );
        }

        let workflowState = workflowRun.state;
        for (const targetState of ['SEARCHING', 'CANDIDATES_VALIDATED', 'OPTIONS_READY'] as const) {
          const nextState = transitionWorkflowState(workflowState, targetState);
          const updatedRows = (await transaction.run(
            UPDATE.entity(PersistedWorkflowRuns)
              .set({ state: nextState, errorCode: null, errorMessage: null })
              .where({ ID: workflowRun.ID, state: workflowState }),
          )) as number;
          if (updatedRows !== 1) {
            throw new DomainError(
              'PLANNING_STATE_INCONSISTENT',
              'WorkflowRun zmienił się podczas atomowego zapisu planowania.',
            );
          }
          workflowState = nextState;
        }
        await transaction.run(
          INSERT.into(PersistedWorkflowTransitions).entries(...bundle.workflowTransitions),
        );
        await transaction.run(INSERT.into(PersistedRankedOptions).entries(...bundle.rankedOptions));
        await transaction.run(
          INSERT.into(PersistedSourceSnapshots).entries(...bundle.sourceSnapshots),
        );
        await transaction.run(INSERT.into(PersistedBudgetItems).entries(...bundle.budgetItems));
        await transaction.run(INSERT.into(PersistedOptionNotes).entries(...bundle.optionNotes));

        return transaction.run(
          SELECT.one.from(PersistedPlanningRuns).where({ ID: bundle.planningRun.ID }),
        );
      } catch (error) {
        return rejectDomainError(request, error);
      }
    };

    this.on('startPlanning', (request: Request) => {
      const ID = String(request.params[0]?.ID ?? '');
      return this.runPlanningOnce(ID, request, () => executeStartPlanning(request, ID));
    });

    this.on('generateNarrative', async (request: Request) => {
      const rankedOptionId = String(request.params[0]?.ID ?? '');

      try {
        // Ta jawna transakcja tylko odczytu kończy się przed STARTED i provider call.
        const context = await this.groundedOptionReader.read(rankedOptionId);
        const result = await this.createNarrativeGateway().call(
          createOptionNarrativeRequest(context),
        );

        // Builder ponownie waliduje cały output i wszystkie referencje przed pierwszym
        // zapisem produktu. Durable SUCCEEDED istnieje już w osobnej transakcji AiRuns.
        const bundle = buildNarrativePersistenceBundle({
          context,
          output: result.output,
          aiRunId: result.aiRunId,
          completedAt: new Date().toISOString(),
        });
        const productTransaction = cds.tx(request);
        await this.narrativeWriter.write(productTransaction, bundle);
        return productTransaction.run(
          SELECT.one.from(NarrativeRuns).where({ ID: bundle.narrativeRun.ID }),
        );
      } catch (error) {
        return rejectNarrativeError(request, error);
      }
    });

    await super.init();
  }
}
