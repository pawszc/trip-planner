import cds from '@sap/cds';
import { describe, expect, it } from 'vitest';
import { AiProvider, AiTaskType } from '../../srv/ai/contracts.ts';
import { createNarrativeLiveEvalAuditStore } from '../../scripts/narrative-quality-eval-live.ts';

describe('narrative live-eval audit store', () => {
  it('deploys the project model before the first durable AiRuns write', async () => {
    const audit = await createNarrativeLiveEvalAuditStore('sqlite::memory:');
    const ID = '00000000-0000-4000-8000-000000000001';

    await audit.store.insertStarted({
      ID,
      status: 'STARTED',
      taskType: AiTaskType.JUDGE,
      provider: AiProvider.OPENAI,
      configuredModel: 'synthetic-model-v1',
      configuredEffort: 'low',
      configuredMaxOutputTokens: 2_048,
      effectiveMaxOutputTokens: 2_048,
      promptVersion: 'synthetic-prompt-v1',
      schemaVersion: 'synthetic-schema-v1',
      inputFingerprint: 'a'.repeat(64),
      startedAt: '2026-08-16T00:00:00.000Z',
      expiresAt: '2026-09-15T00:00:00.000Z',
      refusal: false,
    });

    const persisted = (await audit.database.run(
      cds.ql.SELECT.one.from('trip.planner.AiRuns').where({ ID }),
    )) as { ID: string; status: string } | undefined;
    expect(persisted).toMatchObject({ ID, status: 'STARTED' });
  });
});
