import type { SourceSnapshot } from '../domain/money.ts';
import {
  createProviderFingerprint,
  isSha256Fingerprint,
  type ProviderJsonValue,
} from './provider-fingerprint.ts';
import { canonicalSourceSnapshot, isCompleteSourceSnapshot } from './source-snapshot.ts';

export const SELECTED_SOURCE_BINDING_VERSION = 'selected-source-binding-v1';

export interface SelectedSourceBinding {
  readonly optionRank: number;
  readonly candidateId: string;
  readonly source: SourceSnapshot;
}

function safeCandidateId(value: string): boolean {
  return (
    value.trim().length > 0 &&
    value.length <= 500 &&
    ![...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || (codePoint >= 127 && codePoint <= 159);
    })
  );
}

/**
 * Run-level commitment to every selected canonical SourceSnapshot and its stable option identity.
 * It is persisted on PlanningRun and recomputed from descendants before current replay.
 */
export function createSelectedSourceBindingFingerprint(
  bindings: readonly SelectedSourceBinding[],
  providerResultFingerprint: string,
): string {
  if (!isSha256Fingerprint(providerResultFingerprint)) {
    throw new TypeError('Provider result fingerprint is invalid.');
  }
  const seen = new Set<string>();
  const canonicalBindings = bindings.map((binding) => {
    if (
      !Number.isSafeInteger(binding.optionRank) ||
      binding.optionRank <= 0 ||
      !safeCandidateId(binding.candidateId) ||
      !isCompleteSourceSnapshot(binding.source)
    ) {
      throw new TypeError('Selected source binding is invalid.');
    }
    const identity = createProviderFingerprint({
      optionRank: binding.optionRank,
      candidateId: binding.candidateId,
      sourceId: binding.source.id,
    });
    if (seen.has(identity)) throw new TypeError('Selected source binding is duplicated.');
    seen.add(identity);
    return {
      optionRank: binding.optionRank,
      candidateId: binding.candidateId,
      sourceId: binding.source.id,
      source: JSON.parse(canonicalSourceSnapshot(binding.source)) as ProviderJsonValue,
    };
  });
  canonicalBindings.sort(
    (left, right) =>
      left.optionRank - right.optionRank ||
      left.candidateId.localeCompare(right.candidateId, 'en') ||
      left.sourceId.localeCompare(right.sourceId, 'en'),
  );
  return createProviderFingerprint({
    version: SELECTED_SOURCE_BINDING_VERSION,
    providerResultFingerprint,
    bindings: canonicalBindings,
  });
}
