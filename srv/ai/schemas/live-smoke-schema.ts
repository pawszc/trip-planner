import { z } from 'zod';
import { AiTaskType } from '../contracts.ts';
import type { AiProvider, StructuredAiRequest } from '../contracts.ts';

export const LIVE_SMOKE_SCHEMA_NAME = 'phase_3a_live_smoke';
export const LIVE_SMOKE_SCHEMA_VERSION = 'phase-3a-live-smoke-v1';
export const LIVE_SMOKE_PROMPT_VERSION = 'phase-3a-live-smoke-v1';

export const liveSmokeSchema = z
  .object({
    ok: z.literal(true),
    phase: z.literal('3a'),
    check: z.literal('structured-output'),
  })
  .strict();

export type LiveSmokeOutput = z.infer<typeof liveSmokeSchema>;

export function createLiveSmokeRequest(provider: AiProvider): StructuredAiRequest<LiveSmokeOutput> {
  return {
    taskType: AiTaskType.SMOKE,
    promptVersion: LIVE_SMOKE_PROMPT_VERSION,
    schemaVersion: LIVE_SMOKE_SCHEMA_VERSION,
    schemaName: LIVE_SMOKE_SCHEMA_NAME,
    instructions: 'Return the supplied JSON object unchanged in the required structured format.',
    input: { ok: true, phase: '3a', check: 'structured-output' },
    outputSchema: liveSmokeSchema,
    maxOutputTokens: 128,
    provider,
  };
}
