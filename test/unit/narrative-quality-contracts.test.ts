import { readFileSync } from 'node:fs';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { zodTextFormat } from 'openai/helpers/zod';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  canonicalizeJson,
  createInputFingerprint,
  type JsonValue,
} from '../../srv/ai/contracts.ts';
import {
  buildGroundedOptionContext,
  type GroundedOptionContext,
  type GroundedOptionContextInput,
} from '../../srv/narratives/grounded-option-context.ts';
import {
  NARRATIVE_JUDGE_DIMENSIONS,
  NARRATIVE_JUDGE_DIMENSION_STATUSES,
  NARRATIVE_JUDGE_INPUT_MAX_BYTES,
  NARRATIVE_JUDGE_PROMPT_VERSION,
  NARRATIVE_JUDGE_REASON_CODES,
  NARRATIVE_JUDGE_REASON_DIMENSIONS,
  NARRATIVE_JUDGE_REASON_SEVERITIES,
  NARRATIVE_JUDGE_SEVERITIES,
  NARRATIVE_JUDGE_SCHEMA_NAME,
  NARRATIVE_JUDGE_SCHEMA_VERSION,
  NARRATIVE_JUDGE_TRANSPORT_MAX_BLOCK_SEQUENCES,
  NARRATIVE_JUDGE_TRANSPORT_SCHEMA,
  NARRATIVE_QUALITY_RUBRIC_CONTRACT,
  NARRATIVE_QUALITY_RUBRIC_FINGERPRINT,
  createNarrativeJudgeInput,
  createNarrativeJudgeRequest,
  parseNarrativeJudgeOutput,
  validateNarrativeJudgeOutput,
  type NarrativeJudgeDimension,
  type NarrativeJudgeInput,
  type NarrativeJudgeOutput,
} from '../../srv/narratives/narrative-judge.ts';
import {
  NARRATIVE_MODEL_VIEW_MAX_BYTES,
  NARRATIVE_MODEL_VIEW_VERSION,
  NARRATIVE_PROVENANCE_FACT_KEY_VERSION,
  buildNarrativeModelView,
} from '../../srv/narratives/narrative-model-view.ts';
import { parseNarrativeQualityRubricContract } from '../../srv/narratives/narrative-quality-rubric.ts';
import {
  NARRATIVE_CONSTRAINT_SNAPSHOT_VERSION,
  NARRATIVE_QUALITY_CONTEXT_MAX_BYTES,
  NARRATIVE_QUALITY_CONTEXT_VERSION,
  buildNarrativeQualityContext,
  createNarrativeFingerprint,
  type BuildNarrativeQualityContextInput,
  type NarrativeConstraintSnapshotInput,
  type NarrativeQualityContractVersions,
  type NarrativeQualityContext,
} from '../../srv/narratives/narrative-quality-context.ts';
import {
  NARRATIVE_PUBLICATION_POLICY_VERSION,
  decideNarrativePublication,
} from '../../srv/narratives/narrative-publication-policy.ts';
import {
  NARRATIVE_QUALITY_DATASET_VERSION,
  NARRATIVE_MODEL_PROFILE_VERSION,
  NARRATIVE_PRICE_CATALOG_VERSION,
  NARRATIVE_QUALITY_RUBRIC_VERSION,
  NARRATIVE_SAFETY_PRECHECK_VERSION,
} from '../../srv/narratives/narrative-quality-versions.ts';
import {
  OPTION_NARRATIVE_PROMPT_VERSION,
  OPTION_NARRATIVE_SCHEMA_VERSION,
  createOptionNarrativeRequest,
  type OptionNarrativeOutput,
} from '../../srv/narratives/option-narrative.ts';
import { groundedOptionContextInput } from '../fixtures/grounded-option.ts';

function contextInput(): GroundedOptionContextInput {
  return structuredClone(groundedOptionContextInput);
}

function context() {
  return buildGroundedOptionContext(contextInput());
}

function constraints(): NarrativeConstraintSnapshotInput {
  return {
    startDate: '2026-10-10',
    endDate: '2026-10-13',
    adults: 2,
    currency: 'PLN',
    hardBudgetLimit: true,
    earliestDepartureTime: '07:00',
    latestReturnTime: '22:00',
    maxConnections: 1,
    maxTravelMinutes: 480,
    allowFlight: false,
    allowTrain: true,
    allowBus: true,
  };
}

function versions(groundedContextVersion = 'grounded-option-context-v1') {
  return {
    groundedContextVersion,
    modelViewVersion: NARRATIVE_MODEL_VIEW_VERSION,
    qualityContextVersion: NARRATIVE_QUALITY_CONTEXT_VERSION,
    constraintSnapshotVersion: NARRATIVE_CONSTRAINT_SNAPSHOT_VERSION,
    generatePromptVersion: OPTION_NARRATIVE_PROMPT_VERSION,
    generateSchemaVersion: OPTION_NARRATIVE_SCHEMA_VERSION,
    judgePromptVersion: NARRATIVE_JUDGE_PROMPT_VERSION,
    judgeSchemaVersion: NARRATIVE_JUDGE_SCHEMA_VERSION,
    rubricVersion: NARRATIVE_QUALITY_RUBRIC_VERSION,
    datasetVersion: NARRATIVE_QUALITY_DATASET_VERSION,
    publicationPolicyVersion: NARRATIVE_PUBLICATION_POLICY_VERSION,
    safetyPrecheckVersion: NARRATIVE_SAFETY_PRECHECK_VERSION,
    modelProfileVersion: NARRATIVE_MODEL_PROFILE_VERSION,
    priceCatalogVersion: NARRATIVE_PRICE_CATALOG_VERSION,
  } satisfies NarrativeQualityContractVersions;
}

function factByKey(grounded: GroundedOptionContext, key: string) {
  const found = grounded.facts.find((fact) => fact.key === key);
  if (found === undefined) throw new Error(`Missing ${key} fixture fact.`);
  return found;
}

function narrative(grounded = context()): OptionNarrativeOutput {
  const destination = factByKey(grounded, 'option.destination');
  return {
    contextFingerprint: grounded.fingerprint,
    blocks: [
      {
        kind: 'SUMMARY',
        text: 'Praga jest wybraną opcją.',
        factReferences: [destination.factId],
      },
    ],
  };
}

function qualityContext() {
  const grounded = context();
  return buildNarrativeQualityContext({
    context: grounded,
    modelView: buildNarrativeModelView(grounded),
    narrativeOutput: narrative(grounded),
    constraints: constraints(),
    versions: versions(grounded.version),
  });
}

function allPassOutput(quality: NarrativeQualityContext): NarrativeJudgeOutput {
  return {
    qualityContextFingerprint: quality.fingerprint,
    narrativeFingerprint: quality.narrativeFingerprint,
    dimensions: NARRATIVE_JUDGE_DIMENSIONS.map((dimension) => ({
      dimension,
      status: 'PASS' as const,
    })),
    findings: [],
  };
}

function failDimension(
  output: NarrativeJudgeOutput,
  dimension: NarrativeJudgeDimension,
): NarrativeJudgeOutput {
  return {
    ...output,
    dimensions: output.dimensions.map((result) =>
      result.dimension === dimension ? { ...result, status: 'FAIL' as const } : result,
    ),
  };
}

function collectObjectKeys(value: unknown): readonly string[] {
  if (value === null || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap((item) => collectObjectKeys(item));
  return Object.entries(value).flatMap(([key, nested]) => [key, ...collectObjectKeys(nested)]);
}

function goldenRubric(): unknown {
  return JSON.parse(
    readFileSync(new URL('../../evals/rubrics/narrative-quality-v1.json', import.meta.url), 'utf8'),
  ) as unknown;
}

describe('narrative quality contract version binding', () => {
  it('binds the Luna profile and versioned static JUDGE transport schema', () => {
    expect(versions()).toEqual({
      groundedContextVersion: 'grounded-option-context-v1',
      modelViewVersion: 'narrative-model-view-v1',
      qualityContextVersion: 'narrative-quality-context-v1',
      constraintSnapshotVersion: 'narrative-constraint-snapshot-v1',
      generatePromptVersion: 'grounded-option-narrative-prompt-v2',
      generateSchemaVersion: 'grounded-option-narrative-schema-v1',
      judgePromptVersion: 'narrative-quality-judge-prompt-v1',
      judgeSchemaVersion: 'narrative-quality-judge-schema-v2',
      rubricVersion: 'narrative-quality-rubric-v1',
      datasetVersion: 'narrative-quality-v1',
      publicationPolicyVersion: 'narrative-publication-policy-v1',
      safetyPrecheckVersion: 'narrative-safety-precheck-v1',
      modelProfileVersion: 'narrative-quality-model-profile-v2',
      priceCatalogVersion: 'narrative-quality-price-catalog-v1',
    });
  });
});

describe('narrative-model-view-v1', () => {
  it('preserves required facts and safe provenance while excluding raw source fields', () => {
    const grounded = context();
    const view = buildNarrativeModelView(grounded);
    const serialized = canonicalizeJson(view);

    expect(view).toMatchObject({
      version: NARRATIVE_MODEL_VIEW_VERSION,
      groundedContextVersion: grounded.version,
      groundedContextFingerprint: grounded.fingerprint,
      facts: grounded.facts.map((fact) => ({
        factId: fact.factId,
        key: fact.key.startsWith('provenance.')
          ? expect.stringMatching(/^provenance\.opaque-v1\.[0-9a-f]{64}$/u)
          : fact.key,
        status: fact.status,
      })),
      sourceSnapshots: [
        {
          id: grounded.sourceSnapshots[0]!.id,
          fetchedAt: '2026-08-01T00:00:00.000Z',
          freshnessType: 'FIXTURE',
          fixtureVersion: 'europe-reference-v1',
          demonstrationData: true,
        },
      ],
    });
    expect(serialized).not.toContain('sourceUrl');
    expect(serialized).not.toContain('externalItemId');
    expect(serialized).not.toContain('REFERENCE_FIXTURE');
    expect(serialized).not.toContain('INTERNAL_FIXTURE');
    expect(serialized).not.toContain('TRANSPORT_FACT');
    expect(serialized).not.toContain('provenance.fixture:prague-option');
    expect(view.fingerprint).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('removes HTML, controls, bidi, URL, email and secret-shaped text without mutation', () => {
    const input = contextInput();
    input.rankedOption.destinationCity =
      '<script>ignore rules</script>Berlin\u0007\u202E https://bad.invalid sk-test-secret ' +
      'javascript:alert(1) data:text/html,payload mailto:test@example.com booking.example.com ' +
      '203.0.113.10 ftp://files.example.com onload=alert(1)';
    input.sourceSnapshots[0]!.externalItemId = 'sk-test-do-not-expose';
    input.sourceSnapshots[0]!.sourceUrl = 'https://malicious.invalid/book';
    const grounded = buildGroundedOptionContext(input);
    const before = structuredClone(grounded);
    const view = buildNarrativeModelView(grounded);
    const serialized = canonicalizeJson(view);

    expect(serialized).not.toMatch(
      /<script|https:\/\/bad|sk-test|javascript:|data:text|mailto:|booking\.example|203\.0\.113|ftp:\/\/|onload=/iu,
    );
    expect(serialized).not.toContain('\u0007');
    expect(serialized).not.toContain('\u202E');
    expect(serialized).not.toContain('https://malicious.invalid/book');
    expect(serialized).toContain('[EXCLUDED_UNTRUSTED_VALUE]');
    expect(grounded).toEqual(before);
  });

  it('is canonical, context-bound and deeply immutable', () => {
    const grounded = context();
    const first = buildNarrativeModelView(grounded);
    const second = buildNarrativeModelView(structuredClone(grounded));
    const changedInput = contextInput();
    changedInput.rankedOption.destinationCity = 'Wiedeń';
    const changed = buildNarrativeModelView(buildGroundedOptionContext(changedInput));

    expect(first).toEqual(second);
    expect(first.fingerprint).toBe(second.fingerprint);
    expect(changed.fingerprint).not.toBe(first.fingerprint);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.facts)).toBe(true);
    expect(Object.isFrozen(first.facts[0]?.value)).toBe(true);
  });

  it('fails closed before a provider call when the canonical view exceeds its byte cap', () => {
    const input = contextInput();
    input.rankedOption.destinationCity = 'A'.repeat(NARRATIVE_MODEL_VIEW_MAX_BYTES);
    const grounded = buildGroundedOptionContext(input);

    expect(() => buildNarrativeModelView(grounded)).toThrowError(
      expect.objectContaining({ code: 'INVALID_NARRATIVE_MODEL_VIEW' }),
    );
  });

  it('fails closed for another grounded contract version', () => {
    const otherVersion = contextInput();
    otherVersion.contextVersion = 'grounded-option-context-v2';

    expect(() => buildNarrativeModelView(buildGroundedOptionContext(otherVersion))).toThrowError(
      expect.objectContaining({ code: 'INVALID_NARRATIVE_MODEL_VIEW' }),
    );
  });

  it('projects provenance keys to stable, unique, versioned opaque identifiers', () => {
    const input = contextInput();
    const grounded = buildGroundedOptionContext({
      ...input,
      sourceSnapshots: [
        ...input.sourceSnapshots,
        {
          ...structuredClone(input.sourceSnapshots[0]!),
          ID: '40000000-0000-4000-8000-000000000002',
          sourceKey: '<b>unsafe-provider-source-key</b>',
          externalItemId: 'second-provider-external-id',
          contexts: 'UNUSED_PROVIDER_CONTEXT',
        },
      ],
    });
    const first = buildNarrativeModelView(grounded);
    const second = buildNarrativeModelView(structuredClone(grounded));
    const groundedProvenance = grounded.facts.filter(({ key }) => key.startsWith('provenance.'));
    const projectedProvenance = first.facts.filter(({ factId }) =>
      groundedProvenance.some((fact) => fact.factId === factId),
    );

    expect(NARRATIVE_PROVENANCE_FACT_KEY_VERSION).toBe('narrative-provenance-fact-key-v1');
    expect(projectedProvenance).toHaveLength(2);
    expect(new Set(projectedProvenance.map(({ key }) => key)).size).toBe(2);
    expect(projectedProvenance.map(({ key }) => key)).toEqual(
      second.facts
        .filter(({ factId }) => groundedProvenance.some((fact) => fact.factId === factId))
        .map(({ key }) => key),
    );
    expect(
      projectedProvenance.every(({ key }) => /^provenance\.opaque-v1\.[0-9a-f]{64}$/u.test(key)),
    ).toBe(true);
    expect(canonicalizeJson(first)).not.toMatch(
      /fixture:prague-option|unsafe-provider-source-key/iu,
    );
  });

  it('removes every raw source-identity sentinel from complete GENERATE and JUDGE inputs', () => {
    const sentinels = {
      provider: 'PROVIDER_SENTINEL_NORTHSTAR',
      externalItemId: 'EXTERNAL_ITEM_ID_SENTINEL_9QX',
      sourceKey: 'SOURCE_KEY_SENTINEL_PROVIDER_SENTINEL_NORTHSTAR_EXTERNAL_ITEM_ID_SENTINEL_9QX',
      sourceUrl: 'SOURCE_URL_SENTINEL_PRIVATE_PATH',
      contexts: 'CONTEXTS_SENTINEL_PROVIDER_SHAPED',
      providerShaped: 'sk-provider-shaped-sentinel-7QZ91',
    } as const;
    const input = contextInput();
    const source = input.sourceSnapshots[0]!;
    source.provider = sentinels.provider;
    source.externalItemId = `${sentinels.externalItemId}:${sentinels.providerShaped}`;
    source.sourceKey = sentinels.sourceKey;
    source.sourceUrl = `https://source-url-sentinel.example.test/${sentinels.sourceUrl}`;
    source.contexts = `${source.contexts}, ${sentinels.contexts}`;

    const grounded = buildGroundedOptionContext(input);
    const modelView = buildNarrativeModelView(grounded);
    const generated = narrative(grounded);
    const quality = buildNarrativeQualityContext({
      context: grounded,
      modelView,
      narrativeOutput: generated,
      constraints: constraints(),
      versions: versions(grounded.version),
    });
    const generateRequest = createOptionNarrativeRequest(grounded, modelView);
    const judgeRequest = createNarrativeJudgeRequest(quality);
    const serializedInputs = [
      canonicalizeJson(generateRequest.input),
      canonicalizeJson(judgeRequest.input),
    ];
    const inputKeys = [
      ...collectObjectKeys(generateRequest.input),
      ...collectObjectKeys(judgeRequest.input),
    ].join('\n');

    for (const sentinel of Object.values(sentinels)) {
      for (const serialized of serializedInputs) expect(serialized).not.toContain(sentinel);
      expect(inputKeys).not.toContain(sentinel);
    }
    expect(
      modelView.facts.find(
        ({ factId }) => factId === factByKey(grounded, `provenance.${sentinels.sourceKey}`).factId,
      ),
    ).toMatchObject({
      key: expect.stringMatching(/^provenance\.opaque-v1\.[0-9a-f]{64}$/u),
      sourceSnapshotIds: [source.ID],
    });
  });

  it('fails closed instead of rewriting invalid required provenance metadata', () => {
    const badTimestamp = contextInput();
    badTimestamp.sourceSnapshots[0]!.fetchedAt = 'not-an-instant';
    const badDemonstrationFlag = contextInput();
    badDemonstrationFlag.sourceSnapshots[0]!.demonstrationData = 'true' as unknown as boolean;

    for (const grounded of [
      buildGroundedOptionContext(badTimestamp),
      buildGroundedOptionContext(badDemonstrationFlag),
    ]) {
      expect(() => buildNarrativeModelView(grounded)).toThrowError(
        expect.objectContaining({ code: 'INVALID_NARRATIVE_MODEL_VIEW' }),
      );
    }
  });
});

describe('narrative-quality-context-v1', () => {
  it('binds the exact validated narrative, model view, constraints and every contract version', () => {
    const grounded = context();
    const output = narrative(grounded);
    const modelView = buildNarrativeModelView(grounded);
    const quality = buildNarrativeQualityContext({
      context: grounded,
      modelView,
      narrativeOutput: output,
      constraints: constraints(),
      versions: versions(grounded.version),
    });

    expect(quality).toMatchObject({
      version: NARRATIVE_QUALITY_CONTEXT_VERSION,
      groundedContextFingerprint: grounded.fingerprint,
      modelViewFingerprint: modelView.fingerprint,
      narrativeFingerprint: createNarrativeFingerprint(output),
      narrative: output,
      modelView,
      constraints: {
        version: NARRATIVE_CONSTRAINT_SNAPSHOT_VERSION,
        startDate: '2026-10-10',
        endDate: '2026-10-13',
        adults: 2,
        currency: 'PLN',
        hardBudgetLimit: true,
        earliestDepartureTime: '07:00',
        latestReturnTime: '22:00',
        maxConnections: 1,
        maxTravelMinutes: 480,
        allowFlight: false,
        allowTrain: true,
        allowBus: true,
      },
      versions: versions(grounded.version),
    });
    expect(quality.fingerprint).toMatch(/^[0-9a-f]{64}$/u);
    expect(Object.isFrozen(quality)).toBe(true);
    expect(Object.isFrozen(quality.narrative.blocks)).toBe(true);
  });

  it('rejects another model view, an unvalidated narrative and version drift', () => {
    const grounded = context();
    const anotherInput = contextInput();
    anotherInput.rankedOption.destinationCity = 'Wiedeń';
    const another = buildGroundedOptionContext(anotherInput);
    const base: BuildNarrativeQualityContextInput = {
      context: grounded,
      modelView: buildNarrativeModelView(grounded),
      narrativeOutput: narrative(grounded),
      constraints: constraints(),
      versions: versions(grounded.version),
    };

    expect(() =>
      buildNarrativeQualityContext({ ...base, modelView: buildNarrativeModelView(another) }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_NARRATIVE_QUALITY_CONTEXT' }));
    expect(() =>
      buildNarrativeQualityContext({
        ...base,
        narrativeOutput: { ...narrative(grounded), contextFingerprint: 'f'.repeat(64) },
      }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_STRUCTURED_OUTPUT' }));
    expect(() =>
      buildNarrativeQualityContext({
        ...base,
        versions: {
          ...base.versions,
          rubricVersion: 'rubric-drift-v2',
        } as unknown as NarrativeQualityContractVersions,
      }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_NARRATIVE_QUALITY_CONTEXT' }));
  });

  it('rejects unknown fields so free-form input cannot enter the quality envelope', () => {
    const grounded = context();
    const base: BuildNarrativeQualityContextInput = {
      context: grounded,
      modelView: buildNarrativeModelView(grounded),
      narrativeOutput: narrative(grounded),
      constraints: constraints(),
      versions: versions(grounded.version),
    };

    expect(() =>
      buildNarrativeQualityContext({
        ...base,
        constraints: {
          ...base.constraints,
          freeFormUserText: 'must never enter the provider envelope',
        } as unknown as NarrativeConstraintSnapshotInput,
      }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_NARRATIVE_QUALITY_CONTEXT' }));
    expect(() =>
      buildNarrativeQualityContext({
        ...base,
        versions: {
          ...base.versions,
          freeFormUserText: 'must never enter the provider envelope',
        } as unknown as NarrativeQualityContractVersions,
      }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_NARRATIVE_QUALITY_CONTEXT' }));
  });

  it('enforces the independent canonical quality-envelope byte limit before JUDGE', () => {
    const largeInput = contextInput();
    largeInput.rankedOption.destinationCity = 'A'.repeat(48 * 1024);
    const grounded = buildGroundedOptionContext(largeInput);
    const modelView = buildNarrativeModelView(grounded);
    const destination = factByKey(grounded, 'option.destination');
    const maximumNarrative: OptionNarrativeOutput = {
      contextFingerprint: grounded.fingerprint,
      blocks: Array.from({ length: 8 }, (_, index) => ({
        kind: index === 0 ? ('SUMMARY' as const) : ('TRADEOFF' as const),
        text: `${index}`.padEnd(1_200, 'B'),
        factReferences: [destination.factId],
      })),
    };

    expect(Buffer.byteLength(canonicalizeJson(modelView), 'utf8')).toBeLessThanOrEqual(
      NARRATIVE_QUALITY_CONTEXT_MAX_BYTES,
    );
    expect(() =>
      buildNarrativeQualityContext({
        context: grounded,
        modelView,
        narrativeOutput: maximumNarrative,
        constraints: constraints(),
        versions: versions(grounded.version),
      }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_NARRATIVE_QUALITY_CONTEXT' }));
  });

  it.each([
    ['invalid date', { startDate: '2026-02-29' }],
    ['reversed dates', { startDate: '2026-10-14' }],
    ['zero adults', { adults: 0 }],
    ['bad departure time', { earliestDepartureTime: '7:00' }],
    ['bad return time', { latestReturnTime: '24:00' }],
    ['negative connections', { maxConnections: -1 }],
    ['zero travel limit', { maxTravelMinutes: 0 }],
    ['no allowed mode', { allowFlight: false, allowTrain: false, allowBus: false }],
    ['non-boolean hard budget', { hardBudgetLimit: 'true' }],
    ['non-boolean mode', { allowTrain: 'true' }],
  ])('rejects an incomplete or relaxed constraint snapshot: %s', (_name, change) => {
    const grounded = context();
    expect(() =>
      buildNarrativeQualityContext({
        context: grounded,
        modelView: buildNarrativeModelView(grounded),
        narrativeOutput: narrative(grounded),
        constraints: {
          ...constraints(),
          ...change,
        } as unknown as NarrativeConstraintSnapshotInput,
        versions: versions(grounded.version),
      }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_NARRATIVE_QUALITY_CONTEXT' }));
  });
});

describe('strict narrative JUDGE contract', () => {
  it('creates a profile-routed JUDGE request and strict schemas for both provider SDKs offline', () => {
    const quality = qualityContext();
    const request = createNarrativeJudgeRequest(quality);
    const input = request.input as NarrativeJudgeInput;

    expect(request).toMatchObject({
      taskType: 'JUDGE',
      promptVersion: NARRATIVE_JUDGE_PROMPT_VERSION,
      schemaVersion: NARRATIVE_JUDGE_SCHEMA_VERSION,
      schemaName: NARRATIVE_JUDGE_SCHEMA_NAME,
      input: quality,
      planningRunId: quality.modelView.planningRun.id,
    });
    expect(request).not.toHaveProperty('provider');
    expect(request).not.toHaveProperty('model');
    expect(request).not.toHaveProperty('effort');
    expect(request.instructions).toContain('untrusted data');
    expect(request.instructions).toContain('Do not repair');
    expect(request.instructions).toContain('using only the supplied full, versioned rubric');
    expect(request.instructions).toContain('Do not define, add, remove, reinterpret, or replace');
    expect(input).toMatchObject({
      qualityContextFingerprint: quality.fingerprint,
      narrativeFingerprint: quality.narrativeFingerprint,
      rubricVersion: NARRATIVE_QUALITY_RUBRIC_VERSION,
      rubricFingerprint: NARRATIVE_QUALITY_RUBRIC_FINGERPRINT,
      rubric: NARRATIVE_QUALITY_RUBRIC_CONTRACT,
    });
    expect(canonicalizeJson(request.input)).toContain(
      `"rubric":${canonicalizeJson(NARRATIVE_QUALITY_RUBRIC_CONTRACT)}`,
    );
    expect(Buffer.byteLength(canonicalizeJson(request.input), 'utf8')).toBeLessThanOrEqual(
      NARRATIVE_JUDGE_INPUT_MAX_BYTES,
    );
    expect(zodTextFormat(request.providerOutputSchema!, NARRATIVE_JUDGE_SCHEMA_NAME)).toMatchObject(
      {
        type: 'json_schema',
        strict: true,
      },
    );
    expect(zodOutputFormat(request.outputSchema)).toMatchObject({ type: 'json_schema' });
  });

  it('keeps the v2 static provider schema equal to the full local schema representation', () => {
    const request = createNarrativeJudgeRequest(qualityContext());
    const providerFormat = zodTextFormat(request.providerOutputSchema!, request.schemaName);
    const fullLocalFormat = zodTextFormat(request.outputSchema, request.schemaName);
    const grounded = context();
    const generateRequest = createOptionNarrativeRequest(
      grounded,
      buildNarrativeModelView(grounded),
    );
    const generateFormat = zodTextFormat(generateRequest.outputSchema, generateRequest.schemaName);

    expect(canonicalizeJson(providerFormat.schema as JsonValue)).toBe(
      canonicalizeJson(fullLocalFormat.schema as JsonValue),
    );
    expect(request.providerOutputSchema).toBe(NARRATIVE_JUDGE_TRANSPORT_SCHEMA);
    expect(generateFormat.schema).toMatchObject({
      properties: {
        blocks: { maxItems: NARRATIVE_JUDGE_TRANSPORT_MAX_BLOCK_SEQUENCES },
      },
    });
    expect(providerFormat.schema).toMatchObject({
      properties: {
        dimensions: { minItems: 1, maxItems: NARRATIVE_JUDGE_DIMENSIONS.length },
        findings: {
          items: {
            properties: {
              blockSequences: {
                maxItems: NARRATIVE_JUDGE_TRANSPORT_MAX_BLOCK_SEQUENCES,
                items: { maximum: NARRATIVE_JUDGE_TRANSPORT_MAX_BLOCK_SEQUENCES },
              },
            },
          },
        },
      },
    });
  });

  it('pins the exact versioned provider-schema delta from the one-block v1 contract', () => {
    const quality = qualityContext();
    const request = createNarrativeJudgeRequest(quality);
    const providerFormat = zodTextFormat(request.providerOutputSchema!, request.schemaName);
    const v2Schema = providerFormat.schema as JsonValue;
    const legacyV1ProviderSchema = z
      .object({
        qualityContextFingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
        narrativeFingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
        dimensions: z
          .array(
            z
              .object({
                dimension: z.enum(NARRATIVE_JUDGE_DIMENSIONS),
                status: z.enum(NARRATIVE_JUDGE_DIMENSION_STATUSES),
              })
              .strict(),
          )
          .length(NARRATIVE_JUDGE_DIMENSIONS.length),
        findings: z
          .array(
            z
              .object({
                reasonCode: z.enum(NARRATIVE_JUDGE_REASON_CODES),
                severity: z.enum(NARRATIVE_JUDGE_SEVERITIES),
                blockSequences: z
                  .array(z.number().int().min(1).max(quality.narrative.blocks.length))
                  .min(1)
                  .max(quality.narrative.blocks.length),
                factIds: z.array(z.string().regex(/^fact_[0-9a-f]{64}$/u)).max(32),
              })
              .strict(),
          )
          .max(64),
      })
      .strict();
    const v1Schema = zodTextFormat(legacyV1ProviderSchema, request.schemaName).schema as JsonValue;
    const v1MigratedByDocumentedDeltas = structuredClone(v1Schema) as unknown as {
      properties: {
        dimensions: { minItems: number };
        findings: {
          items: {
            properties: {
              blockSequences: { maxItems: number; items: { maximum: number } };
            };
          };
        };
      };
    };

    expect(quality.narrative.blocks).toHaveLength(1);
    v1MigratedByDocumentedDeltas.properties.dimensions.minItems = 1;
    v1MigratedByDocumentedDeltas.properties.findings.items.properties.blockSequences.maxItems =
      NARRATIVE_JUDGE_TRANSPORT_MAX_BLOCK_SEQUENCES;
    v1MigratedByDocumentedDeltas.properties.findings.items.properties.blockSequences.items.maximum =
      NARRATIVE_JUDGE_TRANSPORT_MAX_BLOCK_SEQUENCES;

    expect(createInputFingerprint(v2Schema)).toBe(
      '41d51c394515d10a194165b21e7350d54f62403271db38ca5ed3349d160a6429',
    );
    expect(createInputFingerprint(v1Schema)).toBe(
      '2f5e8d0edafa7566445925a30f371377cc331ddb11fa95f5a2445e5c0157df14',
    );
    expect(canonicalizeJson(v1MigratedByDocumentedDeltas as unknown as JsonValue)).toBe(
      canonicalizeJson(v2Schema),
    );
  });

  it('freezes the exact eight dimensions and closed nineteen-code catalog', () => {
    expect(NARRATIVE_JUDGE_DIMENSIONS).toHaveLength(8);
    expect(new Set(NARRATIVE_JUDGE_DIMENSIONS).size).toBe(8);
    expect(NARRATIVE_JUDGE_DIMENSION_STATUSES).toEqual(['PASS', 'FAIL']);
    expect(NARRATIVE_JUDGE_REASON_CODES).toHaveLength(19);
    expect(new Set(NARRATIVE_JUDGE_REASON_CODES).size).toBe(19);
    expect(NARRATIVE_JUDGE_SEVERITIES).toEqual(['MAJOR', 'CRITICAL']);
  });

  it('matches the complete checked-in golden rubric JSON and its pinned fingerprint', () => {
    const golden = goldenRubric();
    const parsed = parseNarrativeQualityRubricContract(golden);

    expect(parsed).toBe(NARRATIVE_QUALITY_RUBRIC_CONTRACT);
    expect(canonicalizeJson(golden as JsonValue)).toBe(
      canonicalizeJson(NARRATIVE_QUALITY_RUBRIC_CONTRACT),
    );
    expect(createInputFingerprint(golden as JsonValue)).toBe(NARRATIVE_QUALITY_RUBRIC_FINGERPRINT);
    expect(parsed.rubricVersion).toBe(NARRATIVE_QUALITY_RUBRIC_VERSION);
    expect(parsed.dimensions.map(({ id }) => id)).toEqual(NARRATIVE_JUDGE_DIMENSIONS);
    expect(parsed.reasons.map(({ code }) => code)).toEqual(NARRATIVE_JUDGE_REASON_CODES);
    expect(parsed.statusSemantics.PASS).toEqual(expect.any(String));
    expect(parsed.statusSemantics.FAIL).toEqual(expect.any(String));
    expect(parsed.publicationSemantics).toMatchObject({
      publish: 'All eight dimensions are PASS and there are zero findings.',
      reject: 'Any dimension is FAIL or any finding exists.',
      modelOverallVerdictAllowed: false,
      rewriteOrRepairAllowed: false,
    });
    expect(parsed.outputPolicy).toMatchObject({
      evaluateEachDimensionExactlyOnce: true,
      strictStructuredOutputOnly: true,
      rationaleAllowed: false,
      proseAllowed: false,
      rawExcerptsAllowed: false,
    });
  });

  it('derives complete reason-to-dimension and reason-to-severity maps from one rubric', () => {
    const dimensionIds = new Set(NARRATIVE_JUDGE_DIMENSIONS);
    const reasonCodes = new Set(NARRATIVE_JUDGE_REASON_CODES);

    expect(NARRATIVE_QUALITY_RUBRIC_CONTRACT.dimensions).toHaveLength(8);
    expect(NARRATIVE_QUALITY_RUBRIC_CONTRACT.reasons).toHaveLength(19);
    for (const dimension of NARRATIVE_QUALITY_RUBRIC_CONTRACT.dimensions) {
      expect(dimension.definition.length).toBeGreaterThan(0);
      expect(dimensionIds.has(dimension.id)).toBe(true);
      for (const reason of dimension.primaryReasonCodes) expect(reasonCodes.has(reason)).toBe(true);
    }
    for (const reason of NARRATIVE_QUALITY_RUBRIC_CONTRACT.reasons) {
      expect(NARRATIVE_JUDGE_REASON_DIMENSIONS[reason.code]).toEqual(reason.dimensions);
      expect(NARRATIVE_JUDGE_REASON_SEVERITIES[reason.code]).toEqual(reason.allowedSeverities);
      expect(reason.dimensions.every((dimension) => dimensionIds.has(dimension))).toBe(true);
      expect(
        reason.allowedSeverities.every((severity) => ['MAJOR', 'CRITICAL'].includes(severity)),
      ).toBe(true);
    }
    expect(Object.keys(NARRATIVE_JUDGE_REASON_DIMENSIONS).sort()).toEqual(
      [...NARRATIVE_JUDGE_REASON_CODES].sort(),
    );
    expect(Object.keys(NARRATIVE_JUDGE_REASON_SEVERITIES).sort()).toEqual(
      [...NARRATIVE_JUDGE_REASON_CODES].sort(),
    );
  });

  it('rejects incomplete, unknown, or one-character-drifted rubric contracts and bindings', () => {
    const golden = goldenRubric() as {
      dimensions: Array<{ id: string; definition: string }>;
      reasons: Array<{ code: string }>;
    };
    const incomplete = structuredClone(golden);
    incomplete.dimensions.pop();
    const unknownDimension = structuredClone(golden);
    unknownDimension.dimensions[0]!.id = 'STYLE_SCORE';
    const unknownReason = structuredClone(golden);
    unknownReason.reasons[0]!.code = 'FREE_FORM_REASON';
    const definitionDrift = structuredClone(golden);
    definitionDrift.dimensions[0]!.definition += '!';

    for (const changed of [incomplete, unknownDimension, unknownReason, definitionDrift]) {
      expect(createInputFingerprint(changed as JsonValue)).not.toBe(
        NARRATIVE_QUALITY_RUBRIC_FINGERPRINT,
      );
      expect(() => parseNarrativeQualityRubricContract(changed)).toThrowError(
        expect.objectContaining({ code: 'INVALID_NARRATIVE_QUALITY_RUBRIC' }),
      );
    }

    const quality = qualityContext();
    expect(() =>
      createNarrativeJudgeInput(quality, {
        rubricVersion: NARRATIVE_QUALITY_RUBRIC_VERSION,
        rubricFingerprint: NARRATIVE_QUALITY_RUBRIC_FINGERPRINT,
        rubric: definitionDrift,
      }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_NARRATIVE_QUALITY_RUBRIC' }));
    expect(() =>
      createNarrativeJudgeInput(quality, {
        rubricVersion: 'narrative-quality-rubric-v2',
        rubricFingerprint: NARRATIVE_QUALITY_RUBRIC_FINGERPRINT,
        rubric: NARRATIVE_QUALITY_RUBRIC_CONTRACT,
      }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_NARRATIVE_QUALITY_RUBRIC' }));
    expect(() =>
      createNarrativeJudgeInput(quality, {
        rubricVersion: NARRATIVE_QUALITY_RUBRIC_VERSION,
        rubricFingerprint: 'f'.repeat(64),
        rubric: NARRATIVE_QUALITY_RUBRIC_CONTRACT,
      }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_NARRATIVE_QUALITY_RUBRIC' }));
  });

  it('enforces the expanded JUDGE-input byte limit after adding the full rubric', () => {
    const quality = structuredClone(qualityContext()) as NarrativeQualityContext & {
      oversizedUntrustedField: string;
    };
    quality.oversizedUntrustedField = 'X'.repeat(NARRATIVE_JUDGE_INPUT_MAX_BYTES);

    expect(() => createNarrativeJudgeRequest(quality)).toThrowError(
      expect.objectContaining({ code: 'INVALID_NARRATIVE_QUALITY_CONTEXT' }),
    );
  });

  it('accepts exact all-pass and controlled failing results', () => {
    const quality = qualityContext();
    expect(parseNarrativeJudgeOutput(allPassOutput(quality), quality)).toEqual(
      allPassOutput(quality),
    );

    const failing = failDimension(allPassOutput(quality), 'MONEY_DATE_TIME_FIDELITY');
    const withFinding: NarrativeJudgeOutput = {
      ...failing,
      findings: [
        {
          reasonCode: 'MONEY_VALUE_MISMATCH',
          severity: 'CRITICAL',
          blockSequences: [1],
          factIds: [quality.modelView.facts[0]!.factId],
        },
      ],
    };
    expect(parseNarrativeJudgeOutput(withFinding, quality)).toEqual(withFinding);
  });

  it('classifies each explicit local validation phase without inspecting Zod messages', () => {
    const quality = qualityContext();
    const base = allPassOutput(quality);
    const stage = (output: unknown) => {
      const result = validateNarrativeJudgeOutput(output, quality);
      expect(result.success).toBe(false);
      return result.success ? 'UNEXPECTED_SUCCESS' : result.validationFailureStage;
    };

    expect(stage({})).toBe('TRANSPORT_SCHEMA_VALIDATION');
    expect(stage({ ...base, qualityContextFingerprint: 'f'.repeat(64) })).toBe('CONTEXT_BINDING');
    expect(stage({ ...base, narrativeFingerprint: 'e'.repeat(64) })).toBe('CONTEXT_BINDING');
    expect(stage({ ...base, dimensions: base.dimensions.slice(0, 7) })).toBe('DIMENSION_BINDING');
    expect(
      stage({
        ...base,
        dimensions: base.dimensions.map((result, index) =>
          index === 7 ? { ...result, dimension: 'FACTUAL_ENTAILMENT' } : result,
        ),
      }),
    ).toBe('DIMENSION_BINDING');

    const factualFailure = failDimension(base, 'FACTUAL_ENTAILMENT');
    const finding = {
      reasonCode: 'UNSUPPORTED_CLAIM' as const,
      severity: 'MAJOR' as const,
      blockSequences: [1],
      factIds: [quality.modelView.facts[0]!.factId],
    };
    expect(stage({ ...factualFailure, findings: [{ ...finding, severity: 'CRITICAL' }] })).toBe(
      'FINDING_BINDING',
    );
    expect(
      stage({
        ...factualFailure,
        findings: [{ ...finding, factIds: [`fact_${'f'.repeat(64)}`] }],
      }),
    ).toBe('FINDING_BINDING');
    expect(stage({ ...factualFailure, findings: [{ ...finding, blockSequences: [2] }] })).toBe(
      'FINDING_BINDING',
    );
    expect(stage({ ...factualFailure, findings: [] })).toBe('FINDING_BINDING');

    expect(stage({ ...factualFailure, findings: [{ ...finding, severity: 'WARNING' }] })).toBe(
      'TRANSPORT_SCHEMA_VALIDATION',
    );
    expect(
      stage({ ...factualFailure, findings: [{ ...finding, factIds: ['fact_invalid'] }] }),
    ).toBe('TRANSPORT_SCHEMA_VALIDATION');
  });

  it.each([
    ['UNSUPPORTED_CLAIM', 'FACTUAL_ENTAILMENT', 'CRITICAL'],
    ['MONEY_VALUE_MISMATCH', 'MONEY_DATE_TIME_FIDELITY', 'MAJOR'],
  ] as const)(
    'rejects severity outside the canonical reason rule: %s/%s',
    (reasonCode, dimension, severity) => {
      const quality = qualityContext();
      const output = failDimension(allPassOutput(quality), dimension);

      expect(() =>
        parseNarrativeJudgeOutput(
          {
            ...output,
            findings: [{ reasonCode, severity, blockSequences: [1], factIds: [] }],
          },
          quality,
        ),
      ).toThrowError(expect.objectContaining({ code: 'INVALID_STRUCTURED_OUTPUT' }));
    },
  );

  it.each([
    [
      'quality fingerprint',
      (output: Record<string, unknown>) => void (output.qualityContextFingerprint = 'f'.repeat(64)),
    ],
    [
      'narrative fingerprint',
      (output: Record<string, unknown>) => void (output.narrativeFingerprint = 'e'.repeat(64)),
    ],
    [
      'missing dimension',
      (output: Record<string, unknown>) => void (output.dimensions as unknown[]).pop(),
    ],
    [
      'duplicate dimension',
      (output: Record<string, unknown>) =>
        void ((output.dimensions as Array<Record<string, unknown>>)[7]!.dimension =
          'FACTUAL_ENTAILMENT'),
    ],
    [
      'unknown dimension',
      (output: Record<string, unknown>) =>
        void ((output.dimensions as Array<Record<string, unknown>>)[0]!.dimension = 'STYLE_SCORE'),
    ],
    [
      'unknown top-level field',
      (output: Record<string, unknown>) => void (output.verdict = 'PUBLISH'),
    ],
  ])('rejects non-strict output: %s', (_name, corrupt) => {
    const quality = qualityContext();
    const output = structuredClone(allPassOutput(quality)) as unknown as Record<string, unknown>;
    corrupt(output);
    expect(() => parseNarrativeJudgeOutput(output, quality)).toThrowError(
      expect.objectContaining({ code: 'INVALID_STRUCTURED_OUTPUT' }),
    );
  });

  it.each([
    ['unknown reason', { reasonCode: 'FREE_FORM_REASON' }],
    ['unknown severity', { severity: 'WARNING' }],
    ['zero block', { blockSequences: [0] }],
    ['missing block', { blockSequences: [2] }],
    ['duplicate block', { blockSequences: [1, 1] }],
    ['unknown fact', { factIds: [`fact_${'f'.repeat(64)}`] }],
    ['duplicate fact', { factIds: [] as string[] }],
    ['unknown finding field', { rationale: 'free prose' }],
  ])('rejects a malformed finding: %s', (name, findingChange) => {
    const quality = qualityContext();
    const factId = quality.modelView.facts[0]!.factId;
    const baseFinding: Record<string, unknown> = {
      reasonCode: 'UNSUPPORTED_CLAIM',
      severity: 'MAJOR',
      blockSequences: [1],
      factIds: [factId],
      ...findingChange,
    };
    if (name === 'duplicate fact') baseFinding.factIds = [factId, factId];
    const output = failDimension(allPassOutput(quality), 'FACTUAL_ENTAILMENT');

    expect(() =>
      parseNarrativeJudgeOutput({ ...output, findings: [baseFinding] }, quality),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_STRUCTURED_OUTPUT' }));
  });

  it('rejects every inconsistent finding/dimension combination', () => {
    const quality = qualityContext();
    const failedWithoutFinding = failDimension(allPassOutput(quality), 'FACTUAL_ENTAILMENT');
    const findingWithoutFailure = {
      ...allPassOutput(quality),
      findings: [
        {
          reasonCode: 'UNSUPPORTED_CLAIM',
          severity: 'MAJOR',
          blockSequences: [1],
          factIds: [],
        },
      ],
    };
    const wrongFinding = {
      ...failedWithoutFinding,
      findings: [
        {
          reasonCode: 'MONEY_VALUE_MISMATCH',
          severity: 'CRITICAL',
          blockSequences: [1],
          factIds: [],
        },
      ],
    };

    for (const output of [failedWithoutFinding, findingWithoutFailure, wrongFinding]) {
      expect(() => parseNarrativeJudgeOutput(output, quality)).toThrowError(
        expect.objectContaining({ code: 'INVALID_STRUCTURED_OUTPUT' }),
      );
    }
  });
});

describe('code-owned narrative publication policy', () => {
  it('publishes only exact all-pass with zero findings', () => {
    const quality = qualityContext();
    expect(decideNarrativePublication(allPassOutput(quality))).toBe('PUBLISH');
  });

  it('rejects any failed dimension, MAJOR or CRITICAL finding, and malformed dimension set', () => {
    const quality = qualityContext();
    const allPass = allPassOutput(quality);
    expect(decideNarrativePublication(failDimension(allPass, 'REFERENCE_RELEVANCE'))).toBe(
      'REJECT',
    );
    for (const severity of ['MAJOR', 'CRITICAL'] as const) {
      expect(
        decideNarrativePublication({
          ...allPass,
          findings: [
            {
              reasonCode: 'UNSUPPORTED_CLAIM',
              severity,
              blockSequences: [1],
              factIds: [],
            },
          ],
        }),
      ).toBe('REJECT');
    }
    expect(
      decideNarrativePublication({ ...allPass, dimensions: allPass.dimensions.slice(0, 7) }),
    ).toBe('REJECT');
    expect(
      decideNarrativePublication({
        ...allPass,
        dimensions: allPass.dimensions.map((result, index) =>
          index === 7 ? { ...result, dimension: 'FACTUAL_ENTAILMENT' } : result,
        ),
      }),
    ).toBe('REJECT');
  });
});
