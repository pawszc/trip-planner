import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  canonicalizeJson,
  createInputFingerprint,
  type JsonValue,
} from '../../srv/ai/contracts.ts';
import {
  NARRATIVE_QUALITY_CRITICAL_CASE_IDS,
  NARRATIVE_QUALITY_DATASET_CANONICAL_BYTES,
  NARRATIVE_QUALITY_DATASET_FINGERPRINT,
  NARRATIVE_QUALITY_DATASET_V1_CANONICAL_BYTES,
  NARRATIVE_QUALITY_DATASET_V1_FINGERPRINT,
  NARRATIVE_QUALITY_SENTINEL_CASE_IDS,
  loadNarrativeQualityDatasetV1,
  parseNarrativeQualityDataset,
  resolveNarrativeQualityDataset,
  validateNarrativeQualityDatasetContract,
} from '../../srv/evals/dataset.ts';
import {
  SYNTHETIC_EVAL_FIXTURE_VERSION as SYNTHETIC_EVAL_FIXTURE_VERSION_V1,
  resolveSyntheticNarrativeQualityFixture as resolveSyntheticNarrativeQualityFixtureV1,
} from '../../srv/evals/synthetic-fixtures.ts';
import { SYNTHETIC_EVAL_FIXTURE_VERSION } from '../../srv/evals/synthetic-fixtures-v2.ts';
import { buildNarrativeGenerationView } from '../../srv/narratives/narrative-generation-view.ts';
import { buildNarrativeModelView } from '../../srv/narratives/narrative-model-view.ts';
import { calculateEffectiveTimeAtDestinationMinutes } from '../../srv/ranking/effective-time.ts';
import {
  frozenNarrativeQualityDataset,
  syntheticGroundedFixtureResolver,
} from './eval-fixtures.ts';

function checkedInJson(path: string): JsonValue {
  return JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')) as JsonValue;
}

describe('narrative-quality-v2 dataset contract', () => {
  it('retains the immutable v1 dataset and schema artifacts alongside their v2 successors', () => {
    const historicalDataset = checkedInJson('../../evals/datasets/narrative-quality-v1.json');
    const historicalSchema = checkedInJson('../../evals/schemas/narrative-quality-v1.schema.json');

    expect(createInputFingerprint(historicalDataset)).toBe(
      '744d0a275f6c3324d5e1d3ff8d383bc1d957d56ea02c10169da756a60678c4b1',
    );
    expect(Buffer.byteLength(canonicalizeJson(historicalDataset), 'utf8')).toBe(18_501);
    expect(createInputFingerprint(historicalSchema)).toBe(
      'd7eef7c921f9cacee4bb5a383a56d2bd45ed20d37ee5920d8f5359498bcef5cd',
    );

    expect(() => checkedInJson('../../evals/datasets/narrative-quality-v2.json')).not.toThrow();
    expect(() =>
      checkedInJson('../../evals/schemas/narrative-quality-v2.schema.json'),
    ).not.toThrow();
  });

  it('parses and resolves the historical v1 dataset with its exact tracked v1 fixture evidence', () => {
    const dataset = loadNarrativeQualityDatasetV1();
    const resolved = resolveNarrativeQualityDataset(
      dataset,
      resolveSyntheticNarrativeQualityFixtureV1,
    );
    const evidence = resolved.endToEndCases.map(({ authored, groundedContext }) => ({
      contextId: authored.contextId,
      contextFingerprint: groundedContext.fingerprint,
      modelViewFingerprint: buildNarrativeModelView(groundedContext).fingerprint,
      factIdsFingerprint: createInputFingerprint(groundedContext.facts.map(({ factId }) => factId)),
      transportFactId: groundedContext.facts.find(({ key }) => key === 'option.transport')?.factId,
      fixtureVersions: groundedContext.sourceSnapshots.map(({ fixtureVersion }) => fixtureVersion),
    }));

    expect(dataset.datasetVersion).toBe('narrative-quality-v1');
    expect(createInputFingerprint(dataset)).toBe(NARRATIVE_QUALITY_DATASET_V1_FINGERPRINT);
    expect(Buffer.byteLength(canonicalizeJson(dataset), 'utf8')).toBe(
      NARRATIVE_QUALITY_DATASET_V1_CANONICAL_BYTES,
    );
    expect(SYNTHETIC_EVAL_FIXTURE_VERSION_V1).toBe('narrative-quality-synthetic-fixtures-v1');
    expect(resolved.cases).toHaveLength(32);
    expect(evidence).toEqual([
      {
        contextId: 'PRAGUE_PLN_COMPLETE',
        contextFingerprint: 'e05005e458adfb5904ebeb671e0004b58afa6c4b1672724be884f20a6f0e9809',
        modelViewFingerprint: 'ba103eb530728819dacdb219422080329dbfd6d2e4435039afb0eacbc2a51b38',
        factIdsFingerprint: 'babbfc2328bf7f62a4b138f373a85804328b01b08ad33e5e86a69fb1c50006b9',
        transportFactId: 'fact_9b87a2bce0c33919925c9cc70e60ead6575fead8a00893a3f37ce8b61aa821cd',
        fixtureVersions: ['narrative-quality-synthetic-fixtures-v1'],
      },
      {
        contextId: 'VIENNA_EUR_COMPLETE',
        contextFingerprint: '86108c5ced248ff2c2c639e0310ad192021838c386f9cab23c8c4c405f3f7ddf',
        modelViewFingerprint: 'a6d417d2a676f375397a3fe8b35c80b5c5a3d4aef8e0255f2799f47383986d1d',
        factIdsFingerprint: '5d6392600fe83cb4c9aa7e4567eedcbd5127da77ccc3b2d0b8a374265504b336',
        transportFactId: 'fact_9a6514429ef9d0b6e453cbe11e598cd8363edf3f0ef889b8b8821bbacb0de9b3',
        fixtureVersions: ['narrative-quality-synthetic-fixtures-v1'],
      },
      {
        contextId: 'BUDAPEST_UNKNOWN_MISSING',
        contextFingerprint: '5b879a28ef65891dbcbf713666edaf4c7b61fac09eed6cda8c5eef83a670bc2c',
        modelViewFingerprint: 'ebb3a572e8b2764cd37d0fe2da7b260a92b5660201c34674311d29ba3760b5c8',
        factIdsFingerprint: 'f8c92455cde5ae087e23455fe000aa80f4467db695b1b59a8baa4e7c0b067677',
        transportFactId: 'fact_7e6e99882fb0b5cc59b577a457eb55116425808ac24485f6a6721973888150bc',
        fixtureVersions: ['narrative-quality-synthetic-fixtures-v1'],
      },
      {
        contextId: 'BERLIN_ADVERSARIAL_SOURCE',
        contextFingerprint: 'b4778f10bae0ba2faab97640da720760701fff33f145fe29c0eb41ce41f6e23e',
        modelViewFingerprint: '85264af890209bc58b18de4cef714b85647966e52e79c5d22243927ba00ac8f0',
        factIdsFingerprint: 'd94bd8f38791fb40cbabea47a47e45ca585260642fb5457246001812ffeb789c',
        transportFactId: 'fact_43ec92775a2e2f0a36f4917892738275d782c4f2963ea124c5948d78799a2309',
        fixtureVersions: ['narrative-quality-synthetic-fixtures-v1'],
      },
    ]);
  });

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
      'aa6f414e857a7e4f1c83aebc99c1c729b6b55aaeb978ff6e9b8d4a92d96c80a7',
    );
    expect(Object.isFrozen(dataset)).toBe(true);
    expect(Object.isFrozen(dataset.cases[0]!.candidate.blocks)).toBe(true);
  });

  it('binds P03 text and the persisted synthetic transport fact to the shared timestamp rule', () => {
    const dataset = frozenNarrativeQualityDataset();
    const p03 = dataset.cases.find(({ id }) => id === 'P03');
    const authoredContext = dataset.contexts.find(({ id }) => id === 'PRAGUE_PLN_COMPLETE');
    expect(p03).toBeDefined();
    expect(authoredContext).toBeDefined();
    expect(p03?.expected.decision).toBe('PUBLISH');
    expect(SYNTHETIC_EVAL_FIXTURE_VERSION).toBe('narrative-quality-synthetic-fixtures-v2');

    const context = syntheticGroundedFixtureResolver(
      authoredContext!.fixtureBuilder,
      authoredContext!,
    );
    const transport = context.facts.find(({ key }) => key === 'option.transport');
    expect(transport?.status).toBe('KNOWN');
    const value = transport?.value as Record<string, JsonValue>;

    expect(value.outboundDepartureAt).toBe('2026-10-10T07:00:00.000Z');
    expect(value.outboundTravelMinutes).toBe(255);
    expect(value.outboundArrivalAt).toBe('2026-10-10T11:15:00.000Z');
    expect(value.returnDepartureAt).toBe('2026-10-13T17:00:00.000Z');

    const calculated = calculateEffectiveTimeAtDestinationMinutes(
      String(value.outboundArrivalAt),
      String(value.returnDepartureAt),
    );
    const authoredMinutes = Number(
      p03!.candidate.blocks[0]!.text.match(/wynosi ([0-9 ]+) minut/u)![1]!.replaceAll(' ', ''),
    );

    expect(calculated).toBe(4_665);
    expect(value.effectiveTimeAtDestinationMinutes).toBe(calculated);
    expect(authoredMinutes).toBe(calculated);
  });

  it('derives every v2 fixture effective-time field without the stale copied literals', () => {
    const dataset = frozenNarrativeQualityDataset();
    const effectiveMinutes = dataset.contexts.map((authoredContext) => {
      const context = syntheticGroundedFixtureResolver(
        authoredContext.fixtureBuilder,
        authoredContext,
      );
      const transport = context.facts.find(({ key }) => key === 'option.transport');
      const value = transport?.value as Record<string, JsonValue>;
      const calculated = calculateEffectiveTimeAtDestinationMinutes(
        String(value.outboundArrivalAt),
        String(value.returnDepartureAt),
      );
      expect(value.effectiveTimeAtDestinationMinutes).toBe(calculated);
      return calculated;
    });

    expect(effectiveMinutes).toEqual([4_665, 4_620, 4_500, 4_560]);
    expect(effectiveMinutes).not.toContain(4_000);
    expect(effectiveMinutes).not.toContain(4_695);
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

  it('regenerates identical v2 context/generation fingerprints, fact IDs, and fixture lineage', () => {
    const first = resolveNarrativeQualityDataset(
      frozenNarrativeQualityDataset(),
      syntheticGroundedFixtureResolver,
    );
    const second = resolveNarrativeQualityDataset(
      frozenNarrativeQualityDataset(),
      syntheticGroundedFixtureResolver,
    );
    const evidence = (resolved: typeof first) =>
      resolved.endToEndCases.map(({ authored, groundedContext }) => {
        const modelView = buildNarrativeModelView(groundedContext);
        const generationView = buildNarrativeGenerationView(groundedContext, modelView);
        return {
          contextId: authored.contextId,
          contextFingerprint: groundedContext.fingerprint,
          modelViewFingerprint: modelView.fingerprint,
          factIdsFingerprint: createInputFingerprint(
            groundedContext.facts.map(({ factId }) => factId),
          ),
          generationViewFingerprint: generationView.fingerprint,
          generationInputFingerprint: createInputFingerprint(generationView),
          fixtureVersions: groundedContext.sourceSnapshots.map(
            ({ fixtureVersion }) => fixtureVersion,
          ),
        };
      });

    expect(evidence(first)).toEqual(evidence(second));
    expect(
      evidence(first).map(
        ({
          contextId,
          contextFingerprint,
          modelViewFingerprint,
          factIdsFingerprint,
          generationViewFingerprint,
          generationInputFingerprint,
        }) => ({
          contextId,
          contextFingerprint,
          modelViewFingerprint,
          factIdsFingerprint,
          generationViewFingerprint,
          generationInputFingerprint,
        }),
      ),
    ).toEqual([
      {
        contextId: 'PRAGUE_PLN_COMPLETE',
        contextFingerprint: 'e130ff7fadb39d63ef347b2b9938f8ad23b220b29fd24c3094eb842cfdc67cf9',
        modelViewFingerprint: '833a51db000960a4f3d390c1b9a25fd203161df35b63d7723c404c6794b455d4',
        factIdsFingerprint: 'ce6557316b82bf6bb5521fee0983e022f2d45ca4a58c06209290458bd4494a62',
        generationViewFingerprint:
          '273671a6e72da55e3ce8c67731df9ca2fa19d080c6149a14a2212f548368ccbf',
        generationInputFingerprint:
          '549dba3394d1b21b5befbba9dacd00a30d4aec27a73ddb00ffd6a54bef589cc7',
      },
      {
        contextId: 'VIENNA_EUR_COMPLETE',
        contextFingerprint: '3c3e04ea8991a5074eae82a849ba283fb5f146f2728372b8fb6351a0f0702da5',
        modelViewFingerprint: '1e815d4715d1a97cee23d941771145a14748c32d6cddef1c6f6281444c506fc3',
        factIdsFingerprint: '7b5ea358eaff37918636c91fc6bf60058e9dc62ffd4ed786f8d35ab475b4519d',
        generationViewFingerprint:
          '61479e5ef244045235b19b86b095bc6658f779e707e81cd53fc241e66dfdf833',
        generationInputFingerprint:
          '67aadd5e8431a8855395d57123af12b21e58b06e1c2b8ed90d0200eee126856a',
      },
      {
        contextId: 'BUDAPEST_UNKNOWN_MISSING',
        contextFingerprint: '75c1e10ba92ab2719ad452690b95c1b2e6324c862e623424f571c82c344b2bd4',
        modelViewFingerprint: '111e3116b644f3fb8d5dc102de40eae4e80172044e4926f3b5636a8acd0a2f69',
        factIdsFingerprint: '4375e46fc8fa26249d457ce2d1f5d000832c8f18e6769e16f9243938b8e71b91',
        generationViewFingerprint:
          '70050c0d925e48aea83bff1acd4dc946d3026698d32d27789f67cebc987c8f42',
        generationInputFingerprint:
          '7b487c9ebd08a45f8c10a20bf9df68c591188a29a7fd28d938025039099814ee',
      },
      {
        contextId: 'BERLIN_ADVERSARIAL_SOURCE',
        contextFingerprint: '14f0b2ae52ec2155b2da1365177ed8d55ad30ca2e3d948c1899e2aff53276356',
        modelViewFingerprint: 'cb24d5308b7be45042ef044612dddb49d8f1771221fc3905d00cc747d4304cbf',
        factIdsFingerprint: '8322fe5df6eb591170226eb4ab1c38d6cb5ad06d00a35ca82025d091030b714c',
        generationViewFingerprint:
          '1ece0c42b2a1e99b7e67c8759a103c1514c8d19f9b777b6b923d432862b04160',
        generationInputFingerprint:
          '1a4a38dfcf37eaa87cbf6354b312065e7dd78ebeb0d4b5556bdb85b6029e9644',
      },
    ]);
    expect(
      evidence(first).every(({ fixtureVersions }) =>
        fixtureVersions.every((version) => version === SYNTHETIC_EVAL_FIXTURE_VERSION),
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
