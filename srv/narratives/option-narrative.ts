import { z } from 'zod';
import { AiTaskType, type StructuredAiRequest } from '../ai/contracts.ts';
import { AiError } from '../ai/errors.ts';
import type { GroundedOptionContext } from './grounded-option-context.ts';

export const OPTION_NARRATIVE_PROMPT_VERSION = 'grounded-option-narrative-prompt-v1';
export const OPTION_NARRATIVE_SCHEMA_VERSION = 'grounded-option-narrative-schema-v1';
export const OPTION_NARRATIVE_SCHEMA_NAME = 'grounded_option_narrative';

export const OPTION_NARRATIVE_INSTRUCTIONS = `You write concise narrative blocks for one already-selected travel option.
Use only facts in the supplied GroundedOptionContext. Never change ranking, constraints, dates,
times, scores, currency, or monetary values. Never calculate or infer a missing monetary value.
UNKNOWN and MISSING facts must remain explicit and must not be completed. Every block must cite
one or more exact facts from this context through factReferences. A fact reference provides
traceability only; do not claim that it proves anything beyond the referenced structured fact.
Return only the requested structured output and echo the exact contextFingerprint.`;

const factReferenceSchema = z
  .string()
  .trim()
  .regex(/^fact_[0-9a-f]{64}$/, 'factReferences must contain canonical grounded fact IDs.');

export const optionNarrativeBlockSchema = z
  .object({
    kind: z.enum(['SUMMARY', 'ADVANTAGE', 'TRADEOFF', 'RISK']),
    text: z.string().trim().min(1).max(1_200),
    factReferences: z.array(factReferenceSchema).min(1).max(32),
  })
  .strict();

export const optionNarrativeOutputSchema = z
  .object({
    contextFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    blocks: z.array(optionNarrativeBlockSchema).min(1).max(8),
  })
  .strict();

export type OptionNarrativeBlock = z.infer<typeof optionNarrativeBlockSchema>;
export type OptionNarrativeOutput = z.infer<typeof optionNarrativeOutputSchema>;

/** Adds exact-context reference integrity on top of the provider-facing strict structure. */
export function createOptionNarrativeOutputSchema(context: GroundedOptionContext) {
  const validFactIds = new Set(context.facts.map((fact) => fact.factId));
  return optionNarrativeOutputSchema.superRefine((output, refinement) => {
    if (output.contextFingerprint !== context.fingerprint) {
      refinement.addIssue({
        code: 'custom',
        path: ['contextFingerprint'],
        message: 'The narrative output belongs to a different grounded context.',
      });
    }

    for (const [blockIndex, block] of output.blocks.entries()) {
      const seenReferences = new Set<string>();
      for (const [referenceIndex, factId] of block.factReferences.entries()) {
        if (!validFactIds.has(factId)) {
          refinement.addIssue({
            code: 'custom',
            path: ['blocks', blockIndex, 'factReferences', referenceIndex],
            message: 'The narrative block references a fact outside the exact request context.',
          });
        }
        if (seenReferences.has(factId)) {
          refinement.addIssue({
            code: 'custom',
            path: ['blocks', blockIndex, 'factReferences', referenceIndex],
            message: 'A narrative block must not repeat the same fact reference.',
          });
        }
        seenReferences.add(factId);
      }
    }
  });
}

/** Revalidates the complete output locally immediately before persistence or product use. */
export function parseOptionNarrativeOutput(
  output: unknown,
  context: GroundedOptionContext,
): OptionNarrativeOutput {
  const result = createOptionNarrativeOutputSchema(context).safeParse(output);
  if (!result.success) {
    throw new AiError(
      'INVALID_STRUCTURED_OUTPUT',
      'The generated option narrative failed local schema or fact-reference validation.',
    );
  }
  return result.data;
}

export function createOptionNarrativeRequest(
  context: GroundedOptionContext,
): StructuredAiRequest<OptionNarrativeOutput> {
  return {
    taskType: AiTaskType.GENERATE,
    promptVersion: OPTION_NARRATIVE_PROMPT_VERSION,
    schemaVersion: OPTION_NARRATIVE_SCHEMA_VERSION,
    schemaName: OPTION_NARRATIVE_SCHEMA_NAME,
    instructions: OPTION_NARRATIVE_INSTRUCTIONS,
    input: context,
    outputSchema: createOptionNarrativeOutputSchema(context),
    planningRunId: context.planningRun.id,
  };
}
