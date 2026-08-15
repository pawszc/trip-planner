import cds from '@sap/cds';
import { DomainError } from '../domain/domain-error.ts';
import type { NarrativePersistenceBundle } from './narrative-persistence.ts';

const AI_RUN_ENTITY = 'trip.planner.AiRuns';
const NARRATIVE_RUN_ENTITY = 'trip.planner.NarrativeRuns';
const OPTION_NARRATIVE_ENTITY = 'trip.planner.OptionNarratives';
const NARRATIVE_FACT_REFERENCE_ENTITY = 'trip.planner.NarrativeFactReferences';

export interface NarrativeTransactionRunner {
  run(query: object): Promise<unknown>;
}

interface PersistedAiRunLink {
  ID: string;
  planningRun_ID: string | null;
  status: string;
  taskType: string;
  promptVersion: string;
  schemaVersion: string;
  inputFingerprint: string;
}

/** Writes a prevalidated narrative bundle inside the caller's short product transaction. */
export class CapNarrativeWriter {
  async write(
    transaction: NarrativeTransactionRunner,
    bundle: NarrativePersistenceBundle,
  ): Promise<void> {
    const aiRun = (await transaction.run(
      cds.ql.SELECT.one.from(AI_RUN_ENTITY).where({ ID: bundle.expectedAiRun.ID }),
    )) as PersistedAiRunLink | undefined;
    const expected = bundle.expectedAiRun;
    if (
      aiRun === undefined ||
      aiRun.planningRun_ID !== expected.planningRun_ID ||
      aiRun.status !== expected.status ||
      aiRun.taskType !== expected.taskType ||
      aiRun.promptVersion !== expected.promptVersion ||
      aiRun.schemaVersion !== expected.schemaVersion ||
      aiRun.inputFingerprint !== expected.inputFingerprint
    ) {
      throw new DomainError(
        'INVALID_NARRATIVE_AUDIT_LINK',
        'Narracja nie ma zgodnego, terminalnego audytu AI dla dokładnego kontekstu.',
      );
    }

    await transaction.run(cds.ql.INSERT.into(NARRATIVE_RUN_ENTITY).entries(bundle.narrativeRun));
    await transaction.run(
      cds.ql.INSERT.into(OPTION_NARRATIVE_ENTITY).entries(...bundle.optionNarratives),
    );
    await transaction.run(
      cds.ql.INSERT.into(NARRATIVE_FACT_REFERENCE_ENTITY).entries(...bundle.factReferences),
    );
  }
}
