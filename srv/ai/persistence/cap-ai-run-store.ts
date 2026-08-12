import cds from '@sap/cds';
import { AiError } from '../errors.ts';
import type {
  AiRunFailedUpdate,
  AiRunStartedRecord,
  AiRunStore,
  AiRunSucceededUpdate,
} from './ai-run-store.ts';

const AI_RUN_ENTITY = 'trip.planner.AiRuns';

interface TransactionRunner {
  run(query: object): Promise<unknown>;
}

export interface AiRunTransactionalDatabase {
  tx<T>(handler: (transaction: TransactionRunner) => Promise<T>): Promise<T>;
}

type DatabaseProvider = () => AiRunTransactionalDatabase;

function defaultDatabaseProvider(): AiRunTransactionalDatabase {
  if (!cds.db) {
    throw new AiError('AI_AUDIT_FAILED', 'The AI audit database is not connected.');
  }
  return cds.db as unknown as AiRunTransactionalDatabase;
}

function auditStoreFailure(operation: string, cause: unknown): AiError {
  if (cause instanceof AiError && cause.code === 'AI_AUDIT_FAILED') return cause;
  return new AiError('AI_AUDIT_FAILED', 'The AI audit store operation failed safely.', {
    details: { operation },
    cause,
  });
}

function usageColumns(usage: AiRunSucceededUpdate['usage'] | AiRunFailedUpdate['usage']) {
  if (usage === undefined) return {};
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    ...(usage.cacheReadTokens === undefined ? {} : { cacheReadTokens: usage.cacheReadTokens }),
    ...(usage.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: usage.cacheWriteTokens }),
    ...(usage.reasoningTokens === undefined ? {} : { reasoningTokens: usage.reasoningTokens }),
  };
}

function completionColumns(update: AiRunSucceededUpdate | AiRunFailedUpdate) {
  return {
    status: update.status,
    completedAt: update.completedAt,
    refusal: update.refusal.refused,
    ...usageColumns(update.usage),
    ...(update.responseModel === undefined ? {} : { responseModel: update.responseModel }),
    ...(update.latencyMs === undefined ? {} : { latencyMs: update.latencyMs }),
    ...(update.attempts === undefined ? {} : { attempts: update.attempts }),
    ...(update.providerRequestId === undefined
      ? {}
      : { providerRequestId: update.providerRequestId }),
    ...(update.refusal.category === undefined ? {} : { refusalCategory: update.refusal.category }),
    ...(update.status === 'FAILED'
      ? { errorCode: update.errorCode, retryable: update.retryable }
      : { errorCode: null, retryable: false }),
  };
}

export class CapAiRunStore implements AiRunStore {
  constructor(private readonly databaseProvider: DatabaseProvider = defaultDatabaseProvider) {}

  async insertStarted(record: AiRunStartedRecord): Promise<void> {
    try {
      const database = this.databaseProvider();
      await database.tx(async (transaction) => {
        await transaction.run(
          cds.ql.INSERT.into(AI_RUN_ENTITY).entries({
            ID: record.ID,
            ...(record.planningRunId === undefined ? {} : { planningRun_ID: record.planningRunId }),
            status: record.status,
            taskType: record.taskType,
            provider: record.provider,
            configuredModel: record.configuredModel,
            promptVersion: record.promptVersion,
            schemaVersion: record.schemaVersion,
            inputFingerprint: record.inputFingerprint,
            startedAt: record.startedAt,
            expiresAt: record.expiresAt,
            refusal: record.refusal,
          }),
        );
      });
    } catch (cause) {
      throw auditStoreFailure('insertStarted', cause);
    }
  }

  async completeSucceeded(ID: string, update: AiRunSucceededUpdate): Promise<void> {
    await this.complete('completeSucceeded', ID, update);
  }

  async completeFailed(ID: string, update: AiRunFailedUpdate): Promise<void> {
    await this.complete('completeFailed', ID, update);
  }

  async deleteExpired(now: string): Promise<number> {
    try {
      const database = this.databaseProvider();
      return await database.tx(async (transaction) => {
        const deleted = await transaction.run(
          cds.ql.DELETE.from(AI_RUN_ENTITY).where({ expiresAt: { '<': now } }),
        );
        if (typeof deleted !== 'number' || deleted < 0) {
          throw new AiError('AI_AUDIT_FAILED', 'AI audit cleanup returned an invalid row count.');
        }
        return deleted;
      });
    } catch (cause) {
      throw auditStoreFailure('deleteExpired', cause);
    }
  }

  private async complete(
    operation: 'completeSucceeded' | 'completeFailed',
    ID: string,
    update: AiRunSucceededUpdate | AiRunFailedUpdate,
  ): Promise<void> {
    try {
      const database = this.databaseProvider();
      await database.tx(async (transaction) => {
        const updatedRows = await transaction.run(
          cds.ql.UPDATE.entity(AI_RUN_ENTITY)
            .set(completionColumns(update))
            .where({ ID, status: 'STARTED' }),
        );
        if (updatedRows !== 1) {
          throw new AiError(
            'AI_AUDIT_FAILED',
            'The AI audit state transition did not update exactly one STARTED record.',
            { details: { operation } },
          );
        }
      });
    } catch (cause) {
      throw auditStoreFailure(operation, cause);
    }
  }
}
