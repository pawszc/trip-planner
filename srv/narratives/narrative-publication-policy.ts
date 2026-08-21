import { NARRATIVE_JUDGE_DIMENSIONS, type NarrativeJudgeOutput } from './narrative-judge.ts';
export { NARRATIVE_PUBLICATION_POLICY_VERSION } from './narrative-quality-versions.ts';

export type NarrativePublicationDecision = 'PUBLISH' | 'REJECT';

/** Code owns the fail-closed decision; model prose, severity and ordering cannot override it. */
export function decideNarrativePublication(
  output: NarrativeJudgeOutput,
): NarrativePublicationDecision {
  const statuses = new Map(output.dimensions.map((result) => [result.dimension, result.status]));
  if (
    output.dimensions.length !== NARRATIVE_JUDGE_DIMENSIONS.length ||
    statuses.size !== NARRATIVE_JUDGE_DIMENSIONS.length ||
    output.findings.length !== 0
  ) {
    return 'REJECT';
  }
  return NARRATIVE_JUDGE_DIMENSIONS.every((dimension) => statuses.get(dimension) === 'PASS')
    ? 'PUBLISH'
    : 'REJECT';
}
