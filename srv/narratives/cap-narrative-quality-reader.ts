import cds from '@sap/cds';
import { DomainError } from '../domain/domain-error.ts';
import { normalizeTripRequest, type PersistedTripRequest } from '../mapping/trip-request-mapper.ts';
import { validateTripRequest } from '../validation/trip-request-validation.ts';
import {
  buildGroundedOptionContext,
  type GroundedBudgetItemRecord,
  type GroundedOptionContext,
  type GroundedPlanningRunRecord,
  type GroundedRankedOptionRecord,
  type GroundedSourceSnapshotRecord,
  type GroundedTripRequestRecord,
} from './grounded-option-context.ts';
import {
  NARRATIVE_CONSTRAINT_SNAPSHOT_VERSION,
  type NarrativeConstraintSnapshot,
} from './narrative-quality-context.ts';

const TRIP_REQUEST_ENTITY = 'trip.planner.TripRequests';
const PLANNING_RUN_ENTITY = 'trip.planner.PlanningRuns';
const RANKED_OPTION_ENTITY = 'trip.planner.RankedOptions';
const BUDGET_ITEM_ENTITY = 'trip.planner.BudgetItems';
const SOURCE_SNAPSHOT_ENTITY = 'trip.planner.SourceSnapshots';

interface TransactionRunner {
  run(query: object): Promise<unknown>;
}

export interface NarrativeQualityTransactionalDatabase {
  tx<T>(handler: (transaction: TransactionRunner) => Promise<T>): Promise<T>;
}

export interface NarrativeQualityReadSnapshot {
  readonly context: GroundedOptionContext;
  readonly constraints: NarrativeConstraintSnapshot;
}

type DatabaseProvider = () => NarrativeQualityTransactionalDatabase;

function defaultDatabaseProvider(): NarrativeQualityTransactionalDatabase {
  if (!cds.db) throw new Error('The narrative quality database is not connected.');
  return cds.db as unknown as NarrativeQualityTransactionalDatabase;
}

function buildConstraintSnapshot(tripRequest: PersistedTripRequest): NarrativeConstraintSnapshot {
  const normalized = normalizeTripRequest(tripRequest);
  validateTripRequest(normalized);
  if (normalized.currency !== 'PLN' && normalized.currency !== 'EUR') {
    throw new DomainError(
      'INVALID_NARRATIVE_QUALITY_CONTEXT',
      'Quality context wymaga obsługiwanej waluty z zatwierdzonego briefu.',
    );
  }

  return {
    version: NARRATIVE_CONSTRAINT_SNAPSHOT_VERSION,
    startDate: normalized.startDate,
    endDate: normalized.endDate,
    adults: normalized.adults,
    currency: normalized.currency,
    hardBudgetLimit: normalized.hardConstraints.hardBudgetLimit,
    earliestDepartureTime: normalized.hardConstraints.earliestDepartureTime,
    latestReturnTime: normalized.hardConstraints.latestReturnTime,
    maxConnections: normalized.hardConstraints.maxConnections,
    maxTravelMinutes: normalized.hardConstraints.maxTravelMinutes,
    allowFlight: normalized.hardConstraints.allowFlight,
    allowTrain: normalized.hardConstraints.allowTrain,
    allowBus: normalized.hardConstraints.allowBus,
  };
}

/**
 * Reads one immutable product snapshot and commits it before either audited provider call.
 * The 3B2 grounded context remains unchanged; confirmed constraints travel in a separate
 * versioned quality envelope.
 */
export class CapNarrativeQualityReader {
  private readonly databaseProvider: DatabaseProvider;

  constructor(databaseProvider: DatabaseProvider = defaultDatabaseProvider) {
    this.databaseProvider = databaseProvider;
  }

  async read(rankedOptionId: string): Promise<NarrativeQualityReadSnapshot> {
    const ID = rankedOptionId.trim();
    if (ID.length === 0) {
      throw new DomainError('RANKED_OPTION_NOT_FOUND', 'Nie znaleziono opcji do opisania.');
    }

    return this.databaseProvider().tx(async (transaction) => {
      const rankedOption = (await transaction.run(
        cds.ql.SELECT.one.from(RANKED_OPTION_ENTITY).where({ ID }),
      )) as GroundedRankedOptionRecord | undefined;
      if (rankedOption === undefined) {
        throw new DomainError('RANKED_OPTION_NOT_FOUND', 'Nie znaleziono opcji do opisania.');
      }

      const planningRun = (await transaction.run(
        cds.ql.SELECT.one.from(PLANNING_RUN_ENTITY).where({ ID: rankedOption.planningRun_ID }),
      )) as GroundedPlanningRunRecord | undefined;
      if (planningRun === undefined) {
        throw new DomainError(
          'PLANNING_RUN_NOT_FOUND',
          'Opcja nie ma powiązanego uruchomienia planowania.',
        );
      }

      const tripRequest = (await transaction.run(
        cds.ql.SELECT.one.from(TRIP_REQUEST_ENTITY).where({ ID: planningRun.tripRequest_ID }),
      )) as (PersistedTripRequest & GroundedTripRequestRecord) | undefined;
      if (tripRequest === undefined) {
        throw new DomainError(
          'INVALID_GROUNDED_OPTION_CONTEXT',
          'PlanningRun nie ma powiązanego briefu do walidacji jakości.',
        );
      }

      const budgetItems = (await transaction.run(
        cds.ql.SELECT.from(BUDGET_ITEM_ENTITY).where({
          planningRun_ID: planningRun.ID,
          rankedOption_ID: rankedOption.ID,
        }),
      )) as GroundedBudgetItemRecord[];
      const sourceSnapshots = (await transaction.run(
        cds.ql.SELECT.from(SOURCE_SNAPSHOT_ENTITY).where({
          planningRun_ID: planningRun.ID,
          rankedOption_ID: rankedOption.ID,
        }),
      )) as GroundedSourceSnapshotRecord[];

      return {
        context: buildGroundedOptionContext({
          tripRequest,
          planningRun,
          rankedOption,
          budgetItems,
          sourceSnapshots,
        }),
        constraints: buildConstraintSnapshot(tripRequest),
      };
    });
  }
}
