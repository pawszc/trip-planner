import { randomUUID } from 'node:crypto';
import { createInputFingerprint, isValidAiRunId } from '../ai/contracts.ts';
import { DomainError } from '../domain/domain-error.ts';
import type { GroundedOptionContext } from './grounded-option-context.ts';
import {
  OPTION_NARRATIVE_PROMPT_VERSION,
  OPTION_NARRATIVE_SCHEMA_VERSION,
  parseOptionNarrativeOutput,
  type OptionNarrativeOutput,
} from './option-narrative.ts';

export interface NarrativeRunRecord {
  ID: string;
  planningRun_ID: string;
  rankedOption_ID: string;
  aiRunId: string;
  status: 'SUCCEEDED';
  contextVersion: string;
  contextFingerprint: string;
  promptVersion: string;
  schemaVersion: string;
  blockCount: number;
  completedAt: string;
}

export interface OptionNarrativeRecord {
  ID: string;
  narrativeRun_ID: string;
  planningRun_ID: string;
  rankedOption_ID: string;
  sequence: number;
  kind: 'SUMMARY' | 'ADVANTAGE' | 'TRADEOFF' | 'RISK';
  text: string;
}

export interface NarrativeFactReferenceRecord {
  ID: string;
  narrativeRun_ID: string;
  optionNarrative_ID: string;
  planningRun_ID: string;
  rankedOption_ID: string;
  sequence: number;
  factId: string;
}

export interface NarrativePersistenceBundle {
  expectedAiRun: {
    ID: string;
    planningRun_ID: string;
    status: 'SUCCEEDED';
    taskType: 'GENERATE';
    promptVersion: string;
    schemaVersion: string;
    inputFingerprint: string;
  };
  narrativeRun: NarrativeRunRecord;
  optionNarratives: readonly OptionNarrativeRecord[];
  factReferences: readonly NarrativeFactReferenceRecord[];
}

export interface NarrativePersistenceInput {
  context: GroundedOptionContext;
  output: unknown;
  aiRunId: string;
  completedAt: string;
  generateId?: () => string;
}

function invalidNarrativePersistence(message: string): never {
  throw new DomainError('INVALID_NARRATIVE_PERSISTENCE', message);
}

function requireTimestamp(value: string): string {
  if (value.trim().length === 0 || Number.isNaN(Date.parse(value))) {
    invalidNarrativePersistence('Narrative completion time must be a valid timestamp.');
  }
  return value;
}

/**
 * Revalidates the complete output and then materializes one atomic product-write bundle.
 * No partial block or silently filtered reference can reach persistence.
 */
export function buildNarrativePersistenceBundle(
  input: NarrativePersistenceInput,
): NarrativePersistenceBundle {
  if (!isValidAiRunId(input.aiRunId)) {
    invalidNarrativePersistence('Narrative persistence requires the audited AI run UUID.');
  }
  const output: OptionNarrativeOutput = parseOptionNarrativeOutput(input.output, input.context);
  const generateId = input.generateId ?? randomUUID;
  const narrativeRunId = generateId();
  const commonReferences = {
    narrativeRun_ID: narrativeRunId,
    planningRun_ID: input.context.planningRun.id,
    rankedOption_ID: input.context.rankedOption.id,
  } as const;

  const optionNarratives: OptionNarrativeRecord[] = [];
  const factReferences: NarrativeFactReferenceRecord[] = [];
  for (const [blockIndex, block] of output.blocks.entries()) {
    const optionNarrativeId = generateId();
    optionNarratives.push({
      ID: optionNarrativeId,
      ...commonReferences,
      sequence: blockIndex + 1,
      kind: block.kind,
      text: block.text,
    });
    for (const [referenceIndex, factId] of block.factReferences.entries()) {
      factReferences.push({
        ID: generateId(),
        ...commonReferences,
        optionNarrative_ID: optionNarrativeId,
        sequence: referenceIndex + 1,
        factId,
      });
    }
  }

  return {
    expectedAiRun: {
      ID: input.aiRunId,
      planningRun_ID: input.context.planningRun.id,
      status: 'SUCCEEDED',
      taskType: 'GENERATE',
      promptVersion: OPTION_NARRATIVE_PROMPT_VERSION,
      schemaVersion: OPTION_NARRATIVE_SCHEMA_VERSION,
      inputFingerprint: createInputFingerprint(input.context),
    },
    narrativeRun: {
      ID: narrativeRunId,
      planningRun_ID: input.context.planningRun.id,
      rankedOption_ID: input.context.rankedOption.id,
      aiRunId: input.aiRunId,
      status: 'SUCCEEDED',
      contextVersion: input.context.version,
      contextFingerprint: input.context.fingerprint,
      promptVersion: OPTION_NARRATIVE_PROMPT_VERSION,
      schemaVersion: OPTION_NARRATIVE_SCHEMA_VERSION,
      blockCount: optionNarratives.length,
      completedAt: requireTimestamp(input.completedAt),
    },
    optionNarratives,
    factReferences,
  };
}
