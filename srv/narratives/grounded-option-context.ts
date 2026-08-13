import { createInputFingerprint, type JsonObject } from '../ai/contracts.ts';
import { buildGroundedContextComponents, requireGroundedText } from './grounded-option-facts.ts';
import {
  GROUNDED_OPTION_CONTEXT_VERSION,
  type GroundedFact,
  type GroundedOptionContext,
  type GroundedOptionContextInput,
} from './grounded-option-types.ts';

export * from './grounded-option-types.ts';

function createFactId(contextVersion: string, contextFingerprint: string, key: string): string {
  const digest = createInputFingerprint({
    contextVersion,
    contextFingerprint,
    factKey: key,
  });
  return `fact_${digest}`;
}

/**
 * Builds a canonical, immutable grounding envelope from one persisted successful option.
 * Fact IDs are derived only after the exact versioned context receives its fingerprint.
 */
export function buildGroundedOptionContext(
  input: GroundedOptionContextInput,
): GroundedOptionContext {
  const version = requireGroundedText(
    input.contextVersion ?? GROUNDED_OPTION_CONTEXT_VERSION,
    'contextVersion',
  );
  const { planningRun, rankedOption, sourceSnapshots, factDrafts } =
    buildGroundedContextComponents(input);
  const fingerprintBasis: JsonObject = {
    version,
    planningRun,
    rankedOption,
    facts: factDrafts,
    sourceSnapshots,
  };
  const fingerprint = createInputFingerprint(fingerprintBasis);
  const facts = factDrafts.map((fact): GroundedFact => ({
    factId: createFactId(version, fingerprint, fact.key),
    ...fact,
  }));

  return {
    version,
    fingerprint,
    planningRun,
    rankedOption,
    facts,
    sourceSnapshots,
  };
}
