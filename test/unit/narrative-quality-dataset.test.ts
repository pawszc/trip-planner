import { describe, expect, it } from 'vitest';
import {
  NARRATIVE_QUALITY_CRITICAL_CASE_IDS,
  NARRATIVE_QUALITY_DATASET_CANONICAL_BYTES,
  NARRATIVE_QUALITY_DATASET_FINGERPRINT,
  NARRATIVE_QUALITY_SENTINEL_CASE_IDS,
  parseNarrativeQualityDataset,
  resolveNarrativeQualityDataset,
  validateNarrativeQualityDatasetContract,
} from '../../srv/evals/dataset.ts';
import {
  frozenNarrativeQualityDataset,
  syntheticGroundedFixtureResolver,
} from './eval-fixtures.ts';

describe('narrative-quality-v1 dataset contract', () => {
  it('loads the frozen synthetic dataset with its literal canonical fingerprint and distribution', () => {
    const dataset = frozenNarrativeQualityDataset();
    const summary = validateNarrativeQualityDatasetContract(dataset);

    expect(summary).toEqual({
      fingerprintBasisVersion: 'parsed-canonical-json-sha256-v1',
      fingerprint: NARRATIVE_QUALITY_DATASET_FINGERPRINT,
      canonicalBytes: NARRATIVE_QUALITY_DATASET_CANONICAL_BYTES,
      contextCount: 4,
      semanticCaseCount: 32,
      publishCount: 12,
      rejectCount: 20,
      criticalRejectCount: 18,
      sentinelCount: 8,
      endToEndCaseCount: 4,
    });
    expect(NARRATIVE_QUALITY_DATASET_FINGERPRINT).toBe(
      '744d0a275f6c3324d5e1d3ff8d383bc1d957d56ea02c10169da756a60678c4b1',
    );
    expect(Object.isFrozen(dataset)).toBe(true);
    expect(Object.isFrozen(dataset.cases[0]!.candidate.blocks)).toBe(true);
  });

  it('locks the exact architect-curated critical and sentinel memberships', () => {
    const dataset = frozenNarrativeQualityDataset();
    expect(dataset.cases.filter(({ expected }) => expected.critical).map(({ id }) => id)).toEqual(
      NARRATIVE_QUALITY_CRITICAL_CASE_IDS,
    );
    expect(dataset.cases.filter(({ sentinel }) => sentinel).map(({ id }) => id)).toEqual(
      NARRATIVE_QUALITY_SENTINEL_CASE_IDS,
    );
  });

  it('rejects unknown authoring fields before fingerprint validation', () => {
    const changed = structuredClone(frozenNarrativeQualityDataset()) as unknown as Record<
      string,
      unknown
    >;
    changed.untrusted = true;
    expect(() => parseNarrativeQualityDataset(changed)).toThrowError(
      expect.objectContaining({ code: 'INVALID_DATASET' }),
    );
  });

  it('rejects a changed golden label instead of accepting a new local baseline', () => {
    const changed = structuredClone(frozenNarrativeQualityDataset());
    changed.cases[0]!.expected.decision = 'REJECT';
    changed.cases[0]!.expected.failedDimensions = ['FACTUAL_ENTAILMENT'];
    changed.cases[0]!.expected.requiredReasonCodes = ['UNSUPPORTED_CLAIM'];

    expect(() => parseNarrativeQualityDataset(changed)).toThrowError(
      expect.objectContaining({ code: 'INVALID_DATASET_AUTHORING' }),
    );
  });

  it('resolves every authoring fact key to an exact derived ID and validates all four E2E contexts', () => {
    const resolved = resolveNarrativeQualityDataset(
      frozenNarrativeQualityDataset(),
      syntheticGroundedFixtureResolver,
    );

    expect(resolved.cases).toHaveLength(32);
    expect(resolved.endToEndCases.map(({ authored }) => authored.id)).toEqual([
      'E01',
      'E02',
      'E03',
      'E04',
    ]);
    expect(
      resolved.cases.every(({ candidate }) =>
        candidate.blocks.every(({ factReferences }) =>
          factReferences.every((factId) => /^fact_[0-9a-f]{64}$/.test(factId)),
        ),
      ),
    ).toBe(true);
  });

  it('fails closed when a production fixture does not expose an authored fact key', () => {
    expect(() =>
      resolveNarrativeQualityDataset(frozenNarrativeQualityDataset(), (builder, authoring) => {
        const context = syntheticGroundedFixtureResolver(builder, authoring);
        return {
          ...context,
          facts: context.facts.filter(({ key }) => key !== 'option.destination'),
        };
      }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_DATASET_AUTHORING' }));
  });

  it('rejects duplicate fact keys from a fixture before resolving candidates', () => {
    expect(() =>
      resolveNarrativeQualityDataset(frozenNarrativeQualityDataset(), (builder, authoring) => {
        const context = syntheticGroundedFixtureResolver(builder, authoring);
        return { ...context, facts: [...context.facts, context.facts[0]!] };
      }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_DATASET_AUTHORING' }));
  });
});
