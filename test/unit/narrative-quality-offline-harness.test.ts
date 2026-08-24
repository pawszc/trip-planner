import { describe, expect, it } from 'vitest';
import { AiProvider, AiTaskType } from '../../srv/ai/contracts.ts';
import {
  resolveNarrativeQualityDataset,
  type ResolvedNarrativeQualityCase,
  type ResolvedNarrativeQualityEndToEndCase,
} from '../../srv/evals/dataset.ts';
import {
  runDeterministicContractReplay,
  type OfflineEvaluationPass,
  type OfflineNarrativeEvalAdapter,
} from '../../srv/evals/offline-harness.ts';
import {
  NARRATIVE_LIVE_BASELINE_OPERATION_PLAN,
  NARRATIVE_QUALITY_BASELINE_MANIFEST_VERSION,
  validateNarrativeQualityBaseline,
} from '../../srv/evals/baseline.ts';
import { verifyEvalReportFingerprint, type EvalOperationEvidence } from '../../srv/evals/report.ts';
import {
  evalContractVersions,
  frozenNarrativeQualityDataset,
  passingEndToEndOutcome,
  perfectSemanticOutcome,
  syntheticGroundedFixtureResolver,
} from './eval-fixtures.ts';

function inMemoryAdapter(log: string[] = []): OfflineNarrativeEvalAdapter {
  return {
    async evaluateSemanticCase(
      qualityCase: ResolvedNarrativeQualityCase,
      pass: OfflineEvaluationPass,
    ) {
      log.push(`${pass}:${qualityCase.authored.id}`);
      const result = perfectSemanticOutcome(qualityCase.authored);
      return {
        actualDecision: result.actualDecision,
        actualStage: result.actualStage,
        failedDimensions: result.failedDimensions,
        reasonCodes: result.reasonCodes,
        strictJudgeOutputValid: result.strictJudgeOutputValid,
      };
    },
    async evaluateEndToEndCase(qualityCase: ResolvedNarrativeQualityEndToEndCase) {
      log.push(`E2E:${qualityCase.authored.id}`);
      const result = passingEndToEndOutcome(qualityCase.authored.id);
      return {
        generateLogicalCalls: result.generateLogicalCalls,
        judgeLogicalCalls: result.judgeLogicalCalls,
        generatedSchemaValid: result.generatedSchemaValid,
        exactReferencesValid: result.exactReferencesValid,
        actualDecision: result.actualDecision,
        requiredPropertyCatalogVersion: result.requiredPropertyCatalogVersion,
        requiredPropertyResults: result.requiredPropertyResults,
        generateAuditSucceeded: result.generateAuditSucceeded,
        judgeAuditSucceeded: result.judgeAuditSucceeded,
        publicationBundleLinkageValidInMemory: result.publicationBundleLinkageValidInMemory,
        deterministicStateUnchanged: result.deterministicStateUnchanged,
      };
    },
  };
}

const operations: readonly EvalOperationEvidence[] = Object.freeze([
  {
    logicalCallSequence: 1,
    caseId: 'E01',
    taskType: AiTaskType.GENERATE,
    provider: AiProvider.ANTHROPIC,
    configuredModel: 'generator-pinned-v1',
    responseModel: 'generator-response-pinned-v1',
    configuredEffort: 'low',
    configuredMaxOutputTokens: 1_600,
    inputTokens: 100,
    outputTokens: 40,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    latencyMs: 100,
    attempts: 1,
    refused: false,
    refusalCategory: null,
    estimatedCostUsdMicros: 100,
  },
  {
    logicalCallSequence: 2,
    caseId: 'E01',
    taskType: AiTaskType.JUDGE,
    provider: AiProvider.OPENAI,
    configuredModel: 'judge-pinned-v1',
    responseModel: 'judge-response-pinned-v1',
    configuredEffort: 'low',
    configuredMaxOutputTokens: 2_048,
    inputTokens: 120,
    outputTokens: 30,
    cacheReadTokens: 20,
    cacheWriteTokens: 0,
    reasoningTokens: 10,
    latencyMs: 200,
    attempts: 2,
    refused: false,
    refusalCategory: null,
    estimatedCostUsdMicros: 200,
  },
]);

const baselineOperations: readonly EvalOperationEvidence[] = Object.freeze(
  NARRATIVE_LIVE_BASELINE_OPERATION_PLAN.map(({ logicalCallSequence, caseId, taskType }) => {
    const generate = taskType === AiTaskType.GENERATE;
    return {
      logicalCallSequence,
      caseId,
      taskType,
      provider: generate ? AiProvider.ANTHROPIC : AiProvider.OPENAI,
      configuredModel: generate ? 'generator-pinned-v1' : 'judge-pinned-v1',
      responseModel: generate ? 'generator-response-pinned-v1' : 'judge-response-pinned-v1',
      configuredEffort: 'low' as const,
      configuredMaxOutputTokens: generate ? 1_600 : 2_048,
      inputTokens: 120,
      outputTokens: 30,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      latencyMs: 100,
      attempts: 1,
      refused: false,
      refusalCategory: null,
      estimatedCostUsdMicros: 100,
    };
  }),
);

describe('deterministic offline narrative eval harness', () => {
  it('runs 32 primary, eight exact sentinel repeats and four E2E contexts in stable order', async () => {
    const log: string[] = [];
    const dataset = frozenNarrativeQualityDataset();
    const result = await runDeterministicContractReplay({
      resolvedDataset: resolveNarrativeQualityDataset(dataset, syntheticGroundedFixtureResolver),
      versions: evalContractVersions,
      adapter: inMemoryAdapter(log),
    });

    expect(result.primaryOutcomes).toHaveLength(32);
    expect(result.repeatedSentinelOutcomes.map(({ caseId }) => caseId)).toEqual([
      'P10',
      'P12',
      'R01',
      'R05',
      'R07',
      'R10',
      'R13',
      'R18',
    ]);
    expect(result.endToEndOutcomes).toHaveLength(4);
    expect(log).toHaveLength(44);
    expect(log[0]).toBe('PRIMARY:P01');
    expect(log[31]).toBe('PRIMARY:R20');
    expect(log[32]).toBe('STABILITY_REPEAT:P10');
    expect(log[40]).toBe('E2E:E01');
    expect(result.report.semantic.gates.passed).toBe(true);
    expect(result.report.stability.gates.passed).toBe(true);
    expect(result.report.endToEnd.gates.passed).toBe(true);
    expect(result.report.operationalSummary).toMatchObject({
      logicalCalls: 0,
      providerAttempts: 0,
      estimatedCostUsdMicros: 0,
    });
    verifyEvalReportFingerprint(result.report);
  });

  it('produces byte-stable privacy-safe reports and never includes authored narrative content', async () => {
    const dataset = frozenNarrativeQualityDataset();
    const resolvedDataset = resolveNarrativeQualityDataset(
      dataset,
      syntheticGroundedFixtureResolver,
    );
    const first = await runDeterministicContractReplay({
      resolvedDataset,
      versions: evalContractVersions,
      adapter: inMemoryAdapter(),
      operations,
    });
    const second = await runDeterministicContractReplay({
      resolvedDataset,
      versions: evalContractVersions,
      adapter: inMemoryAdapter(),
      operations: [...operations].reverse(),
    });

    expect(second.report.reportFingerprint).toBe(first.report.reportFingerprint);
    expect(JSON.stringify(second.report)).toBe(JSON.stringify(first.report));
    expect(first.report.operationalSummary).toMatchObject({
      logicalCalls: 2,
      providerAttempts: 3,
      latencyP50Ms: 100,
      latencyP95Ms: 200,
      inputTokens: 220,
      outputTokens: 70,
      estimatedCostUsdMicros: 300,
    });
    const serialized = JSON.stringify(first.report);
    expect(serialized).not.toContain(dataset.cases[0]!.candidate.blocks[0]!.text);
    expect(serialized).not.toContain('factReferences');
    expect(serialized).not.toContain('sourceUrl');
    expect(serialized).not.toContain('externalItemId');
    expect(serialized).not.toContain('instructions');
    expect(serialized).not.toContain('rawOutput');
  });

  it('validates an exact passing baseline manifest and rejects any model/profile drift', async () => {
    const dataset = frozenNarrativeQualityDataset();
    const { report } = await runDeterministicContractReplay({
      resolvedDataset: resolveNarrativeQualityDataset(dataset, syntheticGroundedFixtureResolver),
      versions: evalContractVersions,
      adapter: inMemoryAdapter(),
      operations: baselineOperations,
    });
    const manifest = {
      manifestVersion: NARRATIVE_QUALITY_BASELINE_MANIFEST_VERSION,
      baselineId: 'narrative-quality-baseline-test-v1',
      accepted: true,
      reportVersion: 'narrative-quality-eval-report-v1',
      datasetVersion: 'narrative-quality-v1',
      datasetFingerprintBasisVersion: 'parsed-canonical-json-sha256-v1',
      datasetFingerprint: report.datasetFingerprint,
      dimensionMacroF1ConventionVersion: 'dimension-fail-positive-empty-agreement-one-v1',
      priceArithmeticVersion: 'usd-micros-ceil-each-token-class-v1',
      reportFingerprint: report.reportFingerprint,
      versions: evalContractVersions,
      profiles: {
        generate: {
          provider: AiProvider.ANTHROPIC,
          configuredModel: 'generator-pinned-v1',
          responseModel: 'generator-response-pinned-v1',
          effort: 'low',
          maxOutputTokens: 1_600,
        },
        judge: {
          provider: AiProvider.OPENAI,
          configuredModel: 'judge-pinned-v1',
          responseModel: 'judge-response-pinned-v1',
          effort: 'low',
          maxOutputTokens: 2_048,
        },
      },
      allQualityGatesPassed: true,
    } as const;

    expect(validateNarrativeQualityBaseline({ manifest, report })).toMatchObject({
      baselineId: manifest.baselineId,
      reportFingerprint: report.reportFingerprint,
    });
    expect(() =>
      validateNarrativeQualityBaseline({
        manifest: {
          ...manifest,
          profiles: {
            ...manifest.profiles,
            judge: { ...manifest.profiles.judge, responseModel: 'silent-alias-v2' },
          },
        },
        report,
      }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_EVAL_INPUT' }));

    const { report: incompleteReport } = await runDeterministicContractReplay({
      resolvedDataset: resolveNarrativeQualityDataset(dataset, syntheticGroundedFixtureResolver),
      versions: evalContractVersions,
      adapter: inMemoryAdapter(),
      operations,
    });
    expect(() =>
      validateNarrativeQualityBaseline({
        manifest: {
          ...manifest,
          reportFingerprint: incompleteReport.reportFingerprint,
        },
        report: incompleteReport,
      }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_EVAL_INPUT' }));
  });

  it('rejects unsafe operational fields rather than serializing raw provider-shaped data', async () => {
    const dataset = frozenNarrativeQualityDataset();
    const unsafeOperation = {
      ...operations[0]!,
      rawOutput: dataset.cases[0]!.candidate.blocks[0]!.text,
    };

    await expect(
      runDeterministicContractReplay({
        resolvedDataset: resolveNarrativeQualityDataset(dataset, syntheticGroundedFixtureResolver),
        versions: evalContractVersions,
        adapter: inMemoryAdapter(),
        operations: [unsafeOperation],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_EVAL_INPUT' });
  });

  it('propagates an in-memory adapter failure without creating a partial report', async () => {
    const dataset = frozenNarrativeQualityDataset();
    const adapter = inMemoryAdapter();
    adapter.evaluateSemanticCase = async () => {
      throw new Error('synthetic offline failure');
    };

    await expect(
      runDeterministicContractReplay({
        resolvedDataset: resolveNarrativeQualityDataset(dataset, syntheticGroundedFixtureResolver),
        versions: evalContractVersions,
        adapter,
      }),
    ).rejects.toThrow('synthetic offline failure');
  });
});
