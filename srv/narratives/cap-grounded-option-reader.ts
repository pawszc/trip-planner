import cds from '@sap/cds';
import { DomainError } from '../domain/domain-error.ts';
import {
  buildGroundedOptionContext,
  type GroundedBudgetItemRecord,
  type GroundedOptionContext,
  type GroundedPlanningRunRecord,
  type GroundedRankedOptionRecord,
  type GroundedSourceSnapshotRecord,
} from './grounded-option-context.ts';

const PLANNING_RUN_ENTITY = 'trip.planner.PlanningRuns';
const RANKED_OPTION_ENTITY = 'trip.planner.RankedOptions';
const BUDGET_ITEM_ENTITY = 'trip.planner.BudgetItems';
const SOURCE_SNAPSHOT_ENTITY = 'trip.planner.SourceSnapshots';

interface TransactionRunner {
  run(query: object): Promise<unknown>;
}

export interface NarrativeTransactionalDatabase {
  tx<T>(handler: (transaction: TransactionRunner) => Promise<T>): Promise<T>;
}

type DatabaseProvider = () => NarrativeTransactionalDatabase;

function defaultDatabaseProvider(): NarrativeTransactionalDatabase {
  if (!cds.db) throw new Error('The narrative database is not connected.');
  return cds.db as unknown as NarrativeTransactionalDatabase;
}

/** Reads and commits the exact product snapshot before any audited provider call starts. */
export class CapGroundedOptionReader {
  private readonly databaseProvider: DatabaseProvider;

  constructor(databaseProvider: DatabaseProvider = defaultDatabaseProvider) {
    this.databaseProvider = databaseProvider;
  }

  async read(rankedOptionId: string): Promise<GroundedOptionContext> {
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

      return buildGroundedOptionContext({
        planningRun,
        rankedOption,
        budgetItems,
        sourceSnapshots,
      });
    });
  }
}
