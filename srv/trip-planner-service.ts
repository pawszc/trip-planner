import { randomUUID } from 'node:crypto';
import cds from '@sap/cds';
import type { Request } from '@sap/cds';
import type { AiGateway } from './ai/ai-gateway.ts';
import { loadAiConfig } from './ai/config.ts';
import { createPersistentAiGateway } from './ai/create-persistent-ai-gateway.ts';
import { createInputFingerprint, isValidAiRunId } from './ai/contracts.ts';
import { AI_ERROR_CODE_VALUES, AiError, type AiErrorCode } from './ai/errors.ts';
import { CURRENCY_CONTRACT_VERSION } from './domain/currency.ts';
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
  createLegacyPlanningFingerprintV0,
  createPlanningContext,
  createPlanningFingerprint,
  LEGACY_PLANNING_RUN_V0_LINEAGE,
} from './orchestration/planning-request.ts';
import { buildPlanningPersistenceBundle } from './persistence/planning-result-records.ts';
import { CapNarrativeQualityReader } from './narratives/cap-narrative-quality-reader.ts';
import { CapNarrativeReviewStore } from './narratives/cap-narrative-review-store.ts';
import { CapNarrativeReviewWriter } from './narratives/cap-narrative-review-writer.ts';
import {
  createNarrativeJudgeRequest,
  parseNarrativeJudgeOutput,
  type NarrativeJudgeOutput,
} from './narratives/narrative-judge.ts';
import {
  buildNarrativeModelView,
  NARRATIVE_MODEL_VIEW_VERSION,
} from './narratives/narrative-model-view.ts';
import { buildNarrativePersistenceBundle } from './narratives/narrative-persistence.ts';
import { decideNarrativePublication } from './narratives/narrative-publication-policy.ts';
import {
  buildNarrativeQualityContext,
  createNarrativeFingerprint,
  NARRATIVE_CONSTRAINT_SNAPSHOT_VERSION,
  NARRATIVE_QUALITY_CONTEXT_VERSION,
  type NarrativeQualityContractVersions,
} from './narratives/narrative-quality-context.ts';
import {
  NARRATIVE_JUDGE_PROMPT_VERSION,
  NARRATIVE_JUDGE_SCHEMA_VERSION,
  NARRATIVE_MODEL_PROFILE_VERSION,
  NARRATIVE_PRICE_CATALOG_VERSION,
  NARRATIVE_PUBLICATION_POLICY_VERSION,
  NARRATIVE_QUALITY_DATASET_VERSION,
  NARRATIVE_QUALITY_RUBRIC_VERSION,
  NARRATIVE_SAFETY_PRECHECK_VERSION,
} from './narratives/narrative-quality-versions.ts';
import {
  buildNarrativeReviewPublicationBundle,
  buildNarrativeReviewRejectionBundle,
  NARRATIVE_REVIEW_FAILURE_CODE_VALUES,
  type NarrativeReviewAiRunExpectation,
  type NarrativeReviewDimensionResults,
  type NarrativeReviewFailureCode,
  type NarrativeReviewPersistenceVersions,
} from './narratives/narrative-review-persistence.ts';
import { runNarrativeSafetyPrecheck } from './narratives/narrative-safety-precheck.ts';
import {
  createOptionNarrativeRequest,
  OPTION_NARRATIVE_PROMPT_VERSION,
  OPTION_NARRATIVE_SCHEMA_VERSION,
  parseOptionNarrativeOutput,
} from './narratives/option-narrative.ts';
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
  currencyContractVersion: string | null;
  providerFixtureVersion: string;
  engineVersion: string;
  scoringVersion: string;
  selectedOptionCount: number;
  errorCode: string | null;
  errorMessage: string | null;
}

interface PersistedRankedOptionLineage {
  ID: string;
  tripRequest_ID: string;
  workflowRun_ID: string;
  planningRun_ID: string;
  providerFixtureVersion: string;
  scoringVersion: string;
}

function assertLegacyPlanningReplay(
  tripRequestId: string,
  workflowRun: PersistedWorkflowRun,
  planningRun: PersistedPlanningRun,
  expectedFingerprint: string,
  rankedOptions: readonly PersistedRankedOptionLineage[],
): void {
  const optionsHaveExactHistoricalLineage =
    rankedOptions.length === 3 &&
    rankedOptions.every(
      (option) =>
        option.tripRequest_ID === tripRequestId &&
        option.workflowRun_ID === workflowRun.ID &&
        option.planningRun_ID === planningRun.ID &&
        option.providerFixtureVersion === LEGACY_PLANNING_RUN_V0_LINEAGE.providerFixtureVersion &&
        option.scoringVersion === LEGACY_PLANNING_RUN_V0_LINEAGE.scoringVersion,
    );
  const runHasExactHistoricalLineage =
    planningRun.tripRequest_ID === tripRequestId &&
    planningRun.workflowRun_ID === workflowRun.ID &&
    planningRun.requestFingerprint === expectedFingerprint &&
    planningRun.currencyContractVersion === null &&
    planningRun.status === 'SUCCEEDED' &&
    planningRun.providerFixtureVersion === LEGACY_PLANNING_RUN_V0_LINEAGE.providerFixtureVersion &&
    planningRun.engineVersion === LEGACY_PLANNING_RUN_V0_LINEAGE.engineVersion &&
    planningRun.scoringVersion === LEGACY_PLANNING_RUN_V0_LINEAGE.scoringVersion &&
    planningRun.selectedOptionCount === 3;

  if (
    workflowRun.tripRequest_ID !== tripRequestId ||
    workflowRun.state !== 'OPTIONS_READY' ||
    !runHasExactHistoricalLineage ||
    !optionsHaveExactHistoricalLineage
  ) {
    throw new DomainError(
      'PLANNING_STATE_INCONSISTENT',
      'Historyczny wynik planowania v0 nie spełnia zamrożonego kontraktu replay.',
    );
  }
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
      : [
            'INVALID_NARRATIVE_AUDIT_LINK',
            'INVALID_GROUNDED_OPTION_CONTEXT',
            'INVALID_NARRATIVE_PERSISTENCE',
            'INVALID_NARRATIVE_MODEL_VIEW',
            'INVALID_NARRATIVE_QUALITY_CONTEXT',
            'INVALID_NARRATIVE_JUDGE_OUTPUT',
            'INVALID_NARRATIVE_REVIEW_PERSISTENCE',
            'PRODUCT_WRITE_FAILED',
          ].includes(error.code)
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

interface NormalizedNarrativeAiError {
  readonly code: AiErrorCode;
  readonly message: string;
  readonly aiRunId?: string;
}

function normalizeAiError(error: unknown): NormalizedNarrativeAiError | null {
  if (error instanceof AiError) {
    const aiRunId = error.details.aiRunId;
    return {
      code: error.code,
      message: error.message,
      ...(typeof aiRunId === 'string' ? { aiRunId } : {}),
    };
  }
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
  const details =
    typeof candidate.details === 'object' && candidate.details !== null
      ? (candidate.details as Readonly<Record<string, unknown>>)
      : undefined;
  const aiRunId = details?.aiRunId;
  return {
    code: candidate.code as AiErrorCode,
    message: candidate.message,
    ...(typeof aiRunId === 'string' ? { aiRunId } : {}),
  };
}

const NARRATIVE_REVIEW_FAILURE_CODES = new Set<string>(NARRATIVE_REVIEW_FAILURE_CODE_VALUES);

function createNarrativeVersions(
  groundedContextVersion: string,
): NarrativeReviewPersistenceVersions {
  const qualityVersions: NarrativeQualityContractVersions = {
    groundedContextVersion,
    modelViewVersion: NARRATIVE_MODEL_VIEW_VERSION,
    qualityContextVersion: NARRATIVE_QUALITY_CONTEXT_VERSION,
    constraintSnapshotVersion: NARRATIVE_CONSTRAINT_SNAPSHOT_VERSION,
    generatePromptVersion: OPTION_NARRATIVE_PROMPT_VERSION,
    generateSchemaVersion: OPTION_NARRATIVE_SCHEMA_VERSION,
    judgePromptVersion: NARRATIVE_JUDGE_PROMPT_VERSION,
    judgeSchemaVersion: NARRATIVE_JUDGE_SCHEMA_VERSION,
    rubricVersion: NARRATIVE_QUALITY_RUBRIC_VERSION,
    datasetVersion: NARRATIVE_QUALITY_DATASET_VERSION,
    publicationPolicyVersion: NARRATIVE_PUBLICATION_POLICY_VERSION,
    modelProfileVersion: NARRATIVE_MODEL_PROFILE_VERSION,
    priceCatalogVersion: NARRATIVE_PRICE_CATALOG_VERSION,
    safetyPrecheckVersion: NARRATIVE_SAFETY_PRECHECK_VERSION,
  };
  return qualityVersions;
}

function createSucceededReviewAudit(input: {
  readonly ID: string;
  readonly planningRunId: string;
  readonly taskType: 'GENERATE' | 'JUDGE';
  readonly promptVersion: string;
  readonly schemaVersion: string;
  readonly inputFingerprint: string;
}): NarrativeReviewAiRunExpectation {
  if (!isValidAiRunId(input.ID)) {
    throw new DomainError(
      'INVALID_NARRATIVE_AUDIT_LINK',
      'Narrative quality gate requires an audited AI run UUID.',
    );
  }
  return {
    ID: input.ID,
    planningRun_ID: input.planningRunId,
    status: 'SUCCEEDED',
    taskType: input.taskType,
    promptVersion: input.promptVersion,
    schemaVersion: input.schemaVersion,
    inputFingerprint: input.inputFingerprint,
  };
}

function createFailedReviewAudit(
  error: unknown,
  input: Omit<NarrativeReviewAiRunExpectation, 'ID' | 'status'>,
): NarrativeReviewAiRunExpectation | undefined {
  const normalized = normalizeAiError(error);
  const aiRunId = normalized?.aiRunId;
  if (normalized === null || aiRunId === undefined || !isValidAiRunId(aiRunId)) {
    return undefined;
  }
  return {
    ...input,
    ID: aiRunId,
    // A terminal recorder failure leaves the already durable STARTED row unchanged.
    status: normalized.code === 'AI_AUDIT_FAILED' ? 'STARTED' : 'FAILED',
  };
}

function narrativeReviewFailureCode(
  error: unknown,
  fallback: NarrativeReviewFailureCode,
): NarrativeReviewFailureCode {
  const normalizedAiError = normalizeAiError(error);
  const code =
    normalizedAiError?.code ??
    (typeof error === 'object' &&
    error !== null &&
    typeof (error as { code?: unknown }).code === 'string'
      ? (error as { code: string }).code
      : undefined);
  return code !== undefined && NARRATIVE_REVIEW_FAILURE_CODES.has(code)
    ? (code as NarrativeReviewFailureCode)
    : fallback;
}

function toNarrativeReviewDimensions(
  output: NarrativeJudgeOutput,
): NarrativeReviewDimensionResults {
  return Object.fromEntries(
    output.dimensions.map(({ dimension, status }) => [dimension, status]),
  ) as unknown as NarrativeReviewDimensionResults;
}

function narrativeQualityRejected(): DomainError {
  return new DomainError(
    'NARRATIVE_QUALITY_REJECTED',
    'Narrative candidate did not pass the deterministic quality gate.',
  );
}

export default class TripPlannerService extends cds.ApplicationService {
  private readonly activePlanningRequests = new Map<string, Promise<unknown>>();
  private readonly narrativeQualityReader = new CapNarrativeQualityReader();
  private readonly narrativeReviewStore = new CapNarrativeReviewStore();
  private readonly narrativeReviewWriter = new CapNarrativeReviewWriter();

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
          currencyContractVersion: CURRENCY_CONTRACT_VERSION,
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

        // Dual-read jest ograniczony do dokładnego, udanego v0 z main@1b8a852. Nowe zapisy
        // nadal używają wyłącznie v1. Replay nie aktualizuje ani nie backfilluje legacy row.
        if (workflowRun.state === 'OPTIONS_READY') {
          const legacyFingerprint = createLegacyPlanningFingerprintV0(context);
          const legacyRun = (await transaction.run(
            SELECT.one.from(PersistedPlanningRuns).where({
              tripRequest_ID: ID,
              requestFingerprint: legacyFingerprint,
            }),
          )) as PersistedPlanningRun | undefined;
          if (legacyRun) {
            const legacyOptions = (await transaction.run(
              SELECT.from(PersistedRankedOptions).where({ planningRun_ID: legacyRun.ID }),
            )) as PersistedRankedOptionLineage[];
            assertLegacyPlanningReplay(
              ID,
              workflowRun,
              legacyRun,
              legacyFingerprint,
              legacyOptions,
            );
            return transaction.run(
              SELECT.one.from(PersistedPlanningRuns).where({ ID: legacyRun.ID }),
            );
          }
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
          currencyContractVersion: versions.currencyContractVersion,
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
        // The short read commits before either audited provider call. Confirmed constraints
        // remain in a separate envelope and do not mutate the frozen 3B2 grounded context.
        const { context, constraints } = await this.narrativeQualityReader.read(rankedOptionId);
        const modelView = buildNarrativeModelView(context);
        const versions = createNarrativeVersions(context.version);
        const gateway = this.createNarrativeGateway();
        const generateRequest = createOptionNarrativeRequest(context, modelView);
        const generateInputFingerprint = createInputFingerprint(generateRequest.input);

        let generateResult;
        try {
          generateResult = await gateway.call(generateRequest);
        } catch (error) {
          const generateAudit = createFailedReviewAudit(error, {
            planningRun_ID: context.planningRun.id,
            taskType: 'GENERATE',
            promptVersion: generateRequest.promptVersion,
            schemaVersion: generateRequest.schemaVersion,
            inputFingerprint: generateInputFingerprint,
          });
          // A STARTED write failure has no durable UUID to link. Every failure after durable
          // STARTED is recorded without prompt, context, candidate, provider payload or text.
          if (generateAudit !== undefined) {
            await this.narrativeReviewStore.persistRejection(
              buildNarrativeReviewRejectionBundle({
                planningRunId: context.planningRun.id,
                rankedOptionId: context.rankedOption.id,
                generateAudit,
                contextFingerprint: context.fingerprint,
                modelViewFingerprint: modelView.fingerprint,
                versions,
                stage: 'GENERATE',
                failureCode: narrativeReviewFailureCode(error, 'PROVIDER_ERROR'),
                completedAt: new Date().toISOString(),
              }),
            );
          }
          throw error;
        }

        const generateAudit = createSucceededReviewAudit({
          ID: generateResult.aiRunId,
          planningRunId: context.planningRun.id,
          taskType: 'GENERATE',
          promptVersion: generateRequest.promptVersion,
          schemaVersion: generateRequest.schemaVersion,
          inputFingerprint: generateResult.inputFingerprint,
        });
        const narrativeOutput = parseOptionNarrativeOutput(generateResult.output, context);
        const narrativeFingerprint = createNarrativeFingerprint(narrativeOutput);
        const precheck = runNarrativeSafetyPrecheck({
          context,
          modelView,
          narrativeOutput,
        });
        if (!precheck.passed) {
          await this.narrativeReviewStore.persistRejection(
            buildNarrativeReviewRejectionBundle({
              planningRunId: context.planningRun.id,
              rankedOptionId: context.rankedOption.id,
              generateAudit,
              contextFingerprint: context.fingerprint,
              modelViewFingerprint: modelView.fingerprint,
              narrativeFingerprint,
              versions,
              stage: 'PRECHECK',
              failureCode: 'PRECHECK_REJECTED',
              findings: precheck.findings.map((finding) => ({
                reasonCode: finding.reasonCode,
                severity: finding.severity,
                blockSequences: [finding.blockSequence],
                factIds: [],
              })),
              completedAt: new Date().toISOString(),
            }),
          );
          throw narrativeQualityRejected();
        }

        let qualityContext;
        try {
          qualityContext = buildNarrativeQualityContext({
            context,
            modelView,
            narrativeOutput,
            constraints,
            versions,
          });
        } catch (error) {
          await this.narrativeReviewStore.persistRejection(
            buildNarrativeReviewRejectionBundle({
              planningRunId: context.planningRun.id,
              rankedOptionId: context.rankedOption.id,
              generateAudit,
              contextFingerprint: context.fingerprint,
              modelViewFingerprint: modelView.fingerprint,
              narrativeFingerprint,
              versions,
              stage: 'PRECHECK',
              failureCode: narrativeReviewFailureCode(error, 'INVALID_NARRATIVE_QUALITY_CONTEXT'),
              completedAt: new Date().toISOString(),
            }),
          );
          throw error;
        }

        const judgeRequest = createNarrativeJudgeRequest(qualityContext);
        const judgeInputFingerprint = createInputFingerprint(judgeRequest.input);
        let judgeResult;
        try {
          judgeResult = await gateway.call(judgeRequest);
        } catch (error) {
          const judgeAudit = createFailedReviewAudit(error, {
            planningRun_ID: context.planningRun.id,
            taskType: 'JUDGE',
            promptVersion: judgeRequest.promptVersion,
            schemaVersion: judgeRequest.schemaVersion,
            inputFingerprint: judgeInputFingerprint,
          });
          await this.narrativeReviewStore.persistRejection(
            buildNarrativeReviewRejectionBundle({
              planningRunId: context.planningRun.id,
              rankedOptionId: context.rankedOption.id,
              generateAudit,
              ...(judgeAudit === undefined ? {} : { judgeAiRunId: judgeAudit.ID, judgeAudit }),
              contextFingerprint: context.fingerprint,
              modelViewFingerprint: modelView.fingerprint,
              narrativeFingerprint,
              qualityContextFingerprint: qualityContext.fingerprint,
              versions,
              stage: 'JUDGE',
              failureCode: narrativeReviewFailureCode(error, 'PROVIDER_ERROR'),
              completedAt: new Date().toISOString(),
            }),
          );
          throw error;
        }

        const judgeAudit = createSucceededReviewAudit({
          ID: judgeResult.aiRunId,
          planningRunId: context.planningRun.id,
          taskType: 'JUDGE',
          promptVersion: judgeRequest.promptVersion,
          schemaVersion: judgeRequest.schemaVersion,
          inputFingerprint: judgeResult.inputFingerprint,
        });
        let judgeOutput: NarrativeJudgeOutput;
        try {
          judgeOutput = parseNarrativeJudgeOutput(judgeResult.output, qualityContext);
        } catch (error) {
          await this.narrativeReviewStore.persistRejection(
            buildNarrativeReviewRejectionBundle({
              planningRunId: context.planningRun.id,
              rankedOptionId: context.rankedOption.id,
              generateAudit,
              judgeAiRunId: judgeAudit.ID,
              judgeAudit,
              contextFingerprint: context.fingerprint,
              modelViewFingerprint: modelView.fingerprint,
              narrativeFingerprint,
              qualityContextFingerprint: qualityContext.fingerprint,
              versions,
              stage: 'JUDGE',
              failureCode: 'INVALID_NARRATIVE_JUDGE_OUTPUT',
              completedAt: new Date().toISOString(),
            }),
          );
          throw error;
        }

        const dimensions = toNarrativeReviewDimensions(judgeOutput);
        if (decideNarrativePublication(judgeOutput) === 'REJECT') {
          await this.narrativeReviewStore.persistRejection(
            buildNarrativeReviewRejectionBundle({
              planningRunId: context.planningRun.id,
              rankedOptionId: context.rankedOption.id,
              generateAudit,
              judgeAiRunId: judgeAudit.ID,
              judgeAudit,
              contextFingerprint: context.fingerprint,
              modelViewFingerprint: modelView.fingerprint,
              narrativeFingerprint,
              qualityContextFingerprint: qualityContext.fingerprint,
              versions,
              stage: 'JUDGE',
              failureCode: 'SEMANTIC_REJECTED',
              dimensions,
              findings: judgeOutput.findings,
              completedAt: new Date().toISOString(),
            }),
          );
          throw narrativeQualityRejected();
        }

        // Candidate text is materialized only after the deterministic precheck and the
        // code-owned all-pass policy. These are the exact locally validated bytes judged above.
        const narrativeBundle = buildNarrativePersistenceBundle({
          context,
          modelView,
          output: narrativeOutput,
          aiRunId: generateResult.aiRunId,
          completedAt: new Date().toISOString(),
        });
        const publicationBundle = buildNarrativeReviewPublicationBundle({
          planningRunId: context.planningRun.id,
          rankedOptionId: context.rankedOption.id,
          generateAudit,
          judgeAiRunId: judgeAudit.ID,
          judgeAudit,
          contextFingerprint: context.fingerprint,
          modelViewFingerprint: modelView.fingerprint,
          narrativeFingerprint,
          qualityContextFingerprint: qualityContext.fingerprint,
          versions,
          dimensions,
          narrativeBundle,
          completedAt: new Date().toISOString(),
        });

        // If the request transaction is rolled back (including a late CAP after-handler
        // failure), persist only safe PRODUCT_WRITE_FAILED evidence after rollback completes.
        const productFailureBundle = buildNarrativeReviewRejectionBundle({
          planningRunId: context.planningRun.id,
          rankedOptionId: context.rankedOption.id,
          generateAudit,
          judgeAiRunId: judgeAudit.ID,
          judgeAudit,
          contextFingerprint: context.fingerprint,
          modelViewFingerprint: modelView.fingerprint,
          narrativeFingerprint,
          qualityContextFingerprint: qualityContext.fingerprint,
          versions,
          stage: 'JUDGE',
          failureCode: 'PRODUCT_WRITE_FAILED',
          completedAt: new Date().toISOString(),
        });
        request.on('failed', async () => {
          try {
            await this.narrativeReviewStore.persistRejection(productFailureBundle);
          } catch {
            // The request outcome is already failed. Never expose or log persistence causes.
          }
        });

        const productTransaction = cds.tx(request);
        await this.narrativeReviewWriter.writePublication(productTransaction, publicationBundle);
        return productTransaction.run(
          SELECT.one.from(NarrativeRuns).where({ ID: publicationBundle.narrativeRun.ID }),
        );
      } catch (error) {
        return rejectNarrativeError(request, error);
      }
    });

    await super.init();
  }
}
