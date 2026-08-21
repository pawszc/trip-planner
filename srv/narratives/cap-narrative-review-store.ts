import cds from '@sap/cds';
import { DomainError } from '../domain/domain-error.ts';
import type {
  NarrativeReviewAiRunExpectation,
  NarrativeReviewPersistenceBundle,
} from './narrative-review-persistence.ts';

const AI_RUN_ENTITY = 'trip.planner.AiRuns';
const NARRATIVE_REVIEW_RUN_ENTITY = 'trip.planner.NarrativeReviewRuns';
const NARRATIVE_REVIEW_FINDING_ENTITY = 'trip.planner.NarrativeReviewFindings';

export interface NarrativeReviewTransactionRunner {
  run(query: object): Promise<unknown>;
}

export interface NarrativeReviewTransactionalDatabase {
  tx<T>(handler: (transaction: NarrativeReviewTransactionRunner) => Promise<T>): Promise<T>;
}

type DatabaseProvider = () => NarrativeReviewTransactionalDatabase;
type ActiveDatabaseTransactionDetector = () => boolean;

interface PersistedAiRunLink {
  readonly ID: string;
  readonly planningRun_ID: string | null;
  readonly status: string;
  readonly taskType: string;
  readonly promptVersion: string;
  readonly schemaVersion: string;
  readonly inputFingerprint: string;
}

interface CapTransactionState {
  readonly ready?: unknown;
  readonly _done?: 'committed' | 'rolled back';
}

interface CapContextWithTransactions {
  readonly context?: CapContextWithTransactions;
  readonly transactions?: Map<unknown, CapTransactionState>;
}

function defaultDatabaseProvider(): NarrativeReviewTransactionalDatabase {
  if (!cds.db) {
    throw new DomainError(
      'INVALID_NARRATIVE_REVIEW_PERSISTENCE',
      'Narrative review database is not connected.',
    );
  }
  return cds.db as unknown as NarrativeReviewTransactionalDatabase;
}

function hasActiveCapDatabaseTransaction(): boolean {
  if (!cds.db || !cds.context) return false;
  const current = cds.context as unknown as CapContextWithTransactions;
  const root = current.context ?? current;
  const transaction = root.transactions?.get(cds.db);
  if (transaction === undefined) return false;
  return (
    transaction.ready !== undefined &&
    transaction.ready !== 'committed' &&
    transaction.ready !== 'rolled back' &&
    transaction._done !== 'committed' &&
    transaction._done !== 'rolled back'
  );
}

function invalidAuditLink(): never {
  throw new DomainError(
    'INVALID_NARRATIVE_AUDIT_LINK',
    'Narrative review has no exact persisted AI audit linkage.',
  );
}

export async function assertExpectedNarrativeReviewAiRun(
  transaction: NarrativeReviewTransactionRunner,
  expected: NarrativeReviewAiRunExpectation,
): Promise<void> {
  const persisted = (await transaction.run(
    cds.ql.SELECT.one.from(AI_RUN_ENTITY).where({ ID: expected.ID }),
  )) as PersistedAiRunLink | undefined;
  if (
    persisted === undefined ||
    persisted.ID !== expected.ID ||
    persisted.planningRun_ID !== expected.planningRun_ID ||
    persisted.status !== expected.status ||
    persisted.taskType !== expected.taskType ||
    persisted.promptVersion !== expected.promptVersion ||
    persisted.schemaVersion !== expected.schemaVersion ||
    persisted.inputFingerprint !== expected.inputFingerprint
  ) {
    invalidAuditLink();
  }
}

export async function insertNarrativeReview(
  transaction: NarrativeReviewTransactionRunner,
  bundle: NarrativeReviewPersistenceBundle,
): Promise<void> {
  await transaction.run(cds.ql.INSERT.into(NARRATIVE_REVIEW_RUN_ENTITY).entries(bundle.reviewRun));
  if (bundle.findings.length > 0) {
    await transaction.run(
      cds.ql.INSERT.into(NARRATIVE_REVIEW_FINDING_ENTITY).entries(...bundle.findings),
    );
  }
}

/**
 * Persists rejection evidence in its own root transaction. The handler can then return a
 * controlled error without rolling this evidence back with the CAP request transaction.
 */
export class CapNarrativeReviewStore {
  private readonly databaseProvider: DatabaseProvider;
  private readonly activeDatabaseTransactionDetector: ActiveDatabaseTransactionDetector;

  constructor(
    databaseProvider: DatabaseProvider = defaultDatabaseProvider,
    activeDatabaseTransactionDetector: ActiveDatabaseTransactionDetector = hasActiveCapDatabaseTransaction,
  ) {
    this.databaseProvider = databaseProvider;
    this.activeDatabaseTransactionDetector = activeDatabaseTransactionDetector;
  }

  async persistRejection(bundle: NarrativeReviewPersistenceBundle): Promise<void> {
    if (bundle.reviewRun.decision !== 'REJECT' || bundle.reviewRun.failureCode === null) {
      throw new DomainError(
        'INVALID_NARRATIVE_REVIEW_PERSISTENCE',
        'The independent review store accepts rejection metadata only.',
      );
    }
    if (this.activeDatabaseTransactionDetector()) {
      throw new DomainError(
        'INVALID_NARRATIVE_REVIEW_PERSISTENCE',
        'Narrative rejection persistence requires an independent transaction boundary.',
      );
    }

    try {
      await this.databaseProvider().tx(async (transaction) => {
        await assertExpectedNarrativeReviewAiRun(transaction, bundle.expectedGenerateAiRun);
        if (bundle.expectedJudgeAiRun !== undefined) {
          await assertExpectedNarrativeReviewAiRun(transaction, bundle.expectedJudgeAiRun);
        }
        await insertNarrativeReview(transaction, bundle);
      });
    } catch (cause) {
      if (cause instanceof DomainError) throw cause;
      throw new DomainError(
        'INVALID_NARRATIVE_REVIEW_PERSISTENCE',
        'Narrative rejection metadata could not be persisted safely.',
      );
    }
  }
}
