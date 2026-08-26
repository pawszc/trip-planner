import { describe, expect, it } from 'vitest';
import {
  AiProvider,
  AiTaskType,
  createInputFingerprint,
  type JsonValue,
} from '../../srv/ai/contracts.ts';
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
import {
  verifyEvalReportFingerprint,
  type EvalOperationEvidence,
  type NarrativeEvalReport,
} from '../../srv/evals/report.ts';
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
        actualFailedDimensions: result.actualFailedDimensions,
        actualReasonCodes: result.actualReasonCodes,
        judgeStructuredOutputValid: result.judgeStructuredOutputValid,
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
    terminalAuditStatus: 'SUCCEEDED',
    structuredOutputValid: true,
    validationFailureStage: null,
    exactAuditLinkageValid: true,
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
    terminalAuditStatus: 'SUCCEEDED',
    structuredOutputValid: true,
    validationFailureStage: null,
    exactAuditLinkageValid: true,
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
      configuredModel: generate ? 'claude-sonnet-5' : 'gpt-5.6-luna',
      responseModel: generate ? 'claude-sonnet-5-response-v1' : 'gpt-5.6-luna-response-v1',
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
      terminalAuditStatus: 'SUCCEEDED' as const,
      structuredOutputValid: true,
      validationFailureStage: null,
      exactAuditLinkageValid: true,
      estimatedCostUsdMicros: generate ? 540 : 60,
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
    expect(result.report.reportVersion).toBe('narrative-quality-eval-report-v3');
    expect(
      result.report.endToEnd.cases.map(
        ({ actualFailedDimensions, actualReasonCodes, judgeStructuredOutputValid }) => ({
          actualFailedDimensions,
          actualReasonCodes,
          judgeStructuredOutputValid,
        }),
      ),
    ).toEqual(
      Array.from({ length: 4 }, () => ({
        actualFailedDimensions: [],
        actualReasonCodes: [],
        judgeStructuredOutputValid: true,
      })),
    );
    expect(result.report.operationalSummary).toMatchObject({
      logicalCalls: 0,
      providerAttempts: 0,
      estimatedCostUsdMicros: 0,
    });
    verifyEvalReportFingerprint(result.report);
    const fingerprintTamperedReport = {
      ...result.report,
      endToEnd: {
        ...result.report.endToEnd,
        cases: result.report.endToEnd.cases.map((row) =>
          row.caseId === 'E01'
            ? { ...row, actualReasonCodes: ['UNSUPPORTED_CLAIM'] as const }
            : row,
        ),
      },
    };
    expect(() => verifyEvalReportFingerprint(fingerprintTamperedReport)).toThrowError(
      expect.objectContaining({ code: 'INVALID_EVAL_INPUT' }),
    );
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

  it('canonically reports all four E2E decision and structured-output paths', async () => {
    const dataset = frozenNarrativeQualityDataset();
    const adapter = inMemoryAdapter();
    adapter.evaluateEndToEndCase = async (qualityCase) => {
      const outcome = passingEndToEndOutcome(qualityCase.authored.id);
      if (qualityCase.authored.id === 'E02') {
        return {
          ...outcome,
          actualDecision: 'REJECT' as const,
          actualFailedDimensions: ['FACTUAL_ENTAILMENT'] as const,
          actualReasonCodes: ['UNSUPPORTED_CLAIM'] as const,
          publicationBundleLinkageValidInMemory: false,
        };
      }
      if (qualityCase.authored.id === 'E03') {
        return {
          ...outcome,
          actualDecision: 'REJECT' as const,
          actualFailedDimensions: [],
          actualReasonCodes: [],
          judgeStructuredOutputValid: false,
          judgeAuditSucceeded: false,
          publicationBundleLinkageValidInMemory: false,
        };
      }
      if (qualityCase.authored.id === 'E04') {
        return {
          ...outcome,
          judgeLogicalCalls: 0,
          actualDecision: 'REJECT' as const,
          actualFailedDimensions: ['SAFETY_INSTRUCTION_INTEGRITY'] as const,
          actualReasonCodes: ['UNTRUSTED_CONTENT_EXPOSED'] as const,
          judgeStructuredOutputValid: null,
          judgeAuditSucceeded: false,
          publicationBundleLinkageValidInMemory: false,
        };
      }
      return outcome;
    };

    const { report } = await runDeterministicContractReplay({
      resolvedDataset: resolveNarrativeQualityDataset(dataset, syntheticGroundedFixtureResolver),
      versions: evalContractVersions,
      adapter,
    });

    expect(
      report.endToEnd.cases.map(
        ({
          caseId,
          actualDecision,
          actualFailedDimensions,
          actualReasonCodes,
          judgeStructuredOutputValid,
          judgeLogicalCalls,
        }) => ({
          caseId,
          actualDecision,
          actualFailedDimensions,
          actualReasonCodes,
          judgeStructuredOutputValid,
          judgeLogicalCalls,
        }),
      ),
    ).toEqual([
      {
        caseId: 'E01',
        actualDecision: 'PUBLISH',
        actualFailedDimensions: [],
        actualReasonCodes: [],
        judgeStructuredOutputValid: true,
        judgeLogicalCalls: 1,
      },
      {
        caseId: 'E02',
        actualDecision: 'REJECT',
        actualFailedDimensions: ['FACTUAL_ENTAILMENT'],
        actualReasonCodes: ['UNSUPPORTED_CLAIM'],
        judgeStructuredOutputValid: true,
        judgeLogicalCalls: 1,
      },
      {
        caseId: 'E03',
        actualDecision: 'REJECT',
        actualFailedDimensions: [],
        actualReasonCodes: [],
        judgeStructuredOutputValid: false,
        judgeLogicalCalls: 1,
      },
      {
        caseId: 'E04',
        actualDecision: 'REJECT',
        actualFailedDimensions: ['SAFETY_INSTRUCTION_INTEGRITY'],
        actualReasonCodes: ['UNTRUSTED_CONTENT_EXPOSED'],
        judgeStructuredOutputValid: null,
        judgeLogicalCalls: 0,
      },
    ]);
    verifyEvalReportFingerprint(report);
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
      reportVersion: 'narrative-quality-eval-report-v3',
      datasetVersion: report.datasetVersion,
      datasetFingerprintBasisVersion: 'parsed-canonical-json-sha256-v1',
      datasetFingerprint: report.datasetFingerprint,
      dimensionMacroF1ConventionVersion: 'dimension-fail-positive-empty-agreement-one-v1',
      priceArithmeticVersion: 'usd-micros-ceil-each-token-class-v1',
      reportFingerprint: report.reportFingerprint,
      versions: evalContractVersions,
      profiles: {
        generate: {
          provider: AiProvider.ANTHROPIC,
          configuredModel: 'claude-sonnet-5',
          responseModel: 'claude-sonnet-5-response-v1',
          effort: 'low',
          maxOutputTokens: 1_600,
        },
        judge: {
          provider: AiProvider.OPENAI,
          configuredModel: 'gpt-5.6-luna',
          responseModel: 'gpt-5.6-luna-response-v1',
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
    expect(manifest.manifestVersion).toBe('narrative-quality-baseline-manifest-v3');
    expect(() =>
      validateNarrativeQualityBaseline({
        manifest: { ...manifest, manifestVersion: 'narrative-quality-baseline-manifest-v2' },
        report,
      }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_EVAL_INPUT' }));
    const { reportFingerprint: currentReportFingerprint, ...currentReportBasis } = report;
    expect(currentReportFingerprint).toBe(manifest.reportFingerprint);

    const rejectingEndToEndAdapter = inMemoryAdapter();
    rejectingEndToEndAdapter.evaluateEndToEndCase = async (qualityCase) => {
      const outcome = passingEndToEndOutcome(qualityCase.authored.id);
      return qualityCase.authored.id === 'E01'
        ? {
            ...outcome,
            actualDecision: 'REJECT' as const,
            actualFailedDimensions: ['FACTUAL_ENTAILMENT'] as const,
            actualReasonCodes: ['UNSUPPORTED_CLAIM'] as const,
            publicationBundleLinkageValidInMemory: false,
          }
        : outcome;
    };
    const { report: validRejectReport } = await runDeterministicContractReplay({
      resolvedDataset: resolveNarrativeQualityDataset(dataset, syntheticGroundedFixtureResolver),
      versions: evalContractVersions,
      adapter: rejectingEndToEndAdapter,
      operations: baselineOperations,
    });
    expect(validRejectReport.endToEnd.gates.passed).toBe(true);
    expect(validRejectReport.endToEnd.cases[0]).toMatchObject({
      actualDecision: 'REJECT',
      actualFailedDimensions: ['FACTUAL_ENTAILMENT'],
      actualReasonCodes: ['UNSUPPORTED_CLAIM'],
      judgeStructuredOutputValid: true,
    });
    expect(
      validateNarrativeQualityBaseline({
        manifest: { ...manifest, reportFingerprint: validRejectReport.reportFingerprint },
        report: validRejectReport,
      }),
    ).toMatchObject({ reportFingerprint: validRejectReport.reportFingerprint });

    const { reportFingerprint: validRejectFingerprint, ...validRejectBasis } = validRejectReport;
    expect(validRejectFingerprint).toBeTruthy();
    const staleEndToEndEvidenceBasis = {
      ...validRejectBasis,
      endToEnd: {
        ...validRejectReport.endToEnd,
        cases: validRejectReport.endToEnd.cases.map((row) =>
          row.caseId === 'E01' ? { ...row, actualReasonCodes: [] } : row,
        ),
      },
    };
    const staleEndToEndEvidenceReport = {
      ...staleEndToEndEvidenceBasis,
      reportFingerprint: createInputFingerprint(staleEndToEndEvidenceBasis as unknown as JsonValue),
    } as NarrativeEvalReport;
    expect(() =>
      validateNarrativeQualityBaseline({
        manifest: {
          ...manifest,
          reportFingerprint: staleEndToEndEvidenceReport.reportFingerprint,
        },
        report: staleEndToEndEvidenceReport,
      }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_EVAL_INPUT' }));

    const failingEndToEndAdapter = inMemoryAdapter();
    failingEndToEndAdapter.evaluateEndToEndCase = async (qualityCase) => {
      const outcome = passingEndToEndOutcome(qualityCase.authored.id);
      return qualityCase.authored.id === 'E01' || qualityCase.authored.id === 'E02'
        ? {
            ...outcome,
            actualDecision: 'REJECT' as const,
            actualFailedDimensions: ['FACTUAL_ENTAILMENT'] as const,
            actualReasonCodes: ['UNSUPPORTED_CLAIM'] as const,
            publicationBundleLinkageValidInMemory: false,
          }
        : outcome;
    };
    const { report: nonPassingReport } = await runDeterministicContractReplay({
      resolvedDataset: resolveNarrativeQualityDataset(dataset, syntheticGroundedFixtureResolver),
      versions: evalContractVersions,
      adapter: failingEndToEndAdapter,
      operations: baselineOperations,
    });
    expect(nonPassingReport.endToEnd.gates.passed).toBe(false);
    expect(() =>
      validateNarrativeQualityBaseline({
        manifest: { ...manifest, reportFingerprint: nonPassingReport.reportFingerprint },
        report: nonPassingReport,
      }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_EVAL_INPUT' }));
    const staleReportBasis = {
      ...currentReportBasis,
      reportVersion: 'narrative-quality-eval-report-v2',
    };
    const staleReport = {
      ...staleReportBasis,
      reportFingerprint: createInputFingerprint(staleReportBasis as unknown as JsonValue),
    } as unknown as NarrativeEvalReport;
    expect(() =>
      validateNarrativeQualityBaseline({
        manifest: { ...manifest, reportFingerprint: staleReport.reportFingerprint },
        report: staleReport,
      }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_EVAL_INPUT' }));

    const criticalRejectCaseId = report.cases.find(
      (row) => row.critical && row.expectedDecision === 'REJECT',
    )!.caseId;
    const forgedDerivedBasis = {
      ...currentReportBasis,
      cases: report.cases.map((row) =>
        row.caseId === criticalRejectCaseId ? { ...row, actualDecision: 'PUBLISH' as const } : row,
      ),
      operations: report.operations.map((operation) => ({
        ...operation,
        estimatedCostUsdMicros: 3_000_000,
      })),
      // The forged metrics, gates and summary deliberately remain the original passing values.
    };
    const forgedDerivedReport = {
      ...forgedDerivedBasis,
      reportFingerprint: createInputFingerprint(forgedDerivedBasis as unknown as JsonValue),
    } as NarrativeEvalReport;
    expect(() =>
      validateNarrativeQualityBaseline({
        manifest: { ...manifest, reportFingerprint: forgedDerivedReport.reportFingerprint },
        report: forgedDerivedReport,
      }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_EVAL_INPUT' }));

    const shiftedEndToEndAdapter = inMemoryAdapter();
    shiftedEndToEndAdapter.evaluateEndToEndCase = async (qualityCase) => {
      const outcome = passingEndToEndOutcome(qualityCase.authored.id);
      return {
        ...outcome,
        generateLogicalCalls:
          qualityCase.authored.id === 'E01' ? 0 : qualityCase.authored.id === 'E02' ? 2 : 1,
      };
    };
    const { report: shiftedEndToEndReport } = await runDeterministicContractReplay({
      resolvedDataset: resolveNarrativeQualityDataset(dataset, syntheticGroundedFixtureResolver),
      versions: evalContractVersions,
      adapter: shiftedEndToEndAdapter,
      operations: baselineOperations,
    });
    expect(shiftedEndToEndReport.endToEnd.gates.passed).toBe(true);
    expect(() =>
      validateNarrativeQualityBaseline({
        manifest: {
          ...manifest,
          reportFingerprint: shiftedEndToEndReport.reportFingerprint,
        },
        report: shiftedEndToEndReport,
      }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_EVAL_INPUT' }));

    const { report: underpricedReport } = await runDeterministicContractReplay({
      resolvedDataset: resolveNarrativeQualityDataset(dataset, syntheticGroundedFixtureResolver),
      versions: evalContractVersions,
      adapter: inMemoryAdapter(),
      operations: baselineOperations.map((operation, index) =>
        index === 0
          ? {
              ...operation,
              inputTokens: 800_000,
              outputTokens: 800_000,
              estimatedCostUsdMicros: 0,
            }
          : operation,
      ),
    });
    expect(underpricedReport.operationalSummary.estimatedCostUsdMicros).toBeLessThan(
      report.operationalSummary.estimatedCostUsdMicros,
    );
    expect(() =>
      validateNarrativeQualityBaseline({
        manifest: { ...manifest, reportFingerprint: underpricedReport.reportFingerprint },
        report: underpricedReport,
      }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_EVAL_INPUT' }));

    const unsafeReportBasis = {
      ...currentReportBasis,
      rawOutput: 'RAW_BASELINE_REPORT_SENTINEL',
    };
    const unsafeReport = {
      ...unsafeReportBasis,
      reportFingerprint: createInputFingerprint(unsafeReportBasis as unknown as JsonValue),
    } as unknown as NarrativeEvalReport;
    expect(() =>
      validateNarrativeQualityBaseline({
        manifest: { ...manifest, reportFingerprint: unsafeReport.reportFingerprint },
        report: unsafeReport,
      }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_EVAL_INPUT' }));

    const nestedUnsafeReportBasis = {
      ...currentReportBasis,
      cases: report.cases.map((row) =>
        row.caseId === 'R02' ? { ...row, actualDecision: 'RAW_REPORT_DECISION_SENTINEL' } : row,
      ),
    };
    const nestedUnsafeReport = {
      ...nestedUnsafeReportBasis,
      reportFingerprint: createInputFingerprint(nestedUnsafeReportBasis as unknown as JsonValue),
    } as unknown as NarrativeEvalReport;
    expect(() =>
      validateNarrativeQualityBaseline({
        manifest: { ...manifest, reportFingerprint: nestedUnsafeReport.reportFingerprint },
        report: nestedUnsafeReport,
      }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_EVAL_INPUT' }));

    const unsafePropertyReportBasis = {
      ...currentReportBasis,
      endToEnd: {
        ...report.endToEnd,
        cases: report.endToEnd.cases.map((row, index) =>
          index === 0
            ? {
                ...row,
                requiredPropertyResults: row.requiredPropertyResults.map((result, resultIndex) =>
                  resultIndex === 0
                    ? { ...result, rawOutput: 'RAW_E2E_PROPERTY_SENTINEL' }
                    : result,
                ),
              }
            : row,
        ),
      },
    };
    const unsafePropertyReport = {
      ...unsafePropertyReportBasis,
      reportFingerprint: createInputFingerprint(unsafePropertyReportBasis as unknown as JsonValue),
    } as unknown as NarrativeEvalReport;
    expect(() =>
      validateNarrativeQualityBaseline({
        manifest: { ...manifest, reportFingerprint: unsafePropertyReport.reportFingerprint },
        report: unsafePropertyReport,
      }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_EVAL_INPUT' }));
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

    const { report: failedAuditReport } = await runDeterministicContractReplay({
      resolvedDataset: resolveNarrativeQualityDataset(dataset, syntheticGroundedFixtureResolver),
      versions: evalContractVersions,
      adapter: inMemoryAdapter(),
      operations: baselineOperations.map((operation, index) =>
        index === 0
          ? {
              ...operation,
              terminalAuditStatus: 'FAILED' as const,
              structuredOutputValid: false,
              validationFailureStage: 'CONTEXT_BINDING' as const,
            }
          : operation,
      ),
    });
    expect(failedAuditReport.semantic.gates.passed).toBe(true);
    expect(() =>
      validateNarrativeQualityBaseline({
        manifest: {
          ...manifest,
          reportFingerprint: failedAuditReport.reportFingerprint,
        },
        report: failedAuditReport,
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

  it('rejects raw or non-catalog E2E evidence before a report can be produced', async () => {
    const dataset = frozenNarrativeQualityDataset();
    const rawAdapter = inMemoryAdapter();
    rawAdapter.evaluateEndToEndCase = async (qualityCase) =>
      ({
        ...passingEndToEndOutcome(qualityCase.authored.id),
        rawNarrative: dataset.cases[0]!.candidate.blocks[0]!.text,
      }) as never;

    await expect(
      runDeterministicContractReplay({
        resolvedDataset: resolveNarrativeQualityDataset(dataset, syntheticGroundedFixtureResolver),
        versions: evalContractVersions,
        adapter: rawAdapter,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_EVAL_INPUT' });

    const nonCatalogAdapter = inMemoryAdapter();
    nonCatalogAdapter.evaluateEndToEndCase = async (qualityCase) =>
      ({
        ...passingEndToEndOutcome(qualityCase.authored.id),
        actualReasonCodes: ['RAW_PROVIDER_REPORT_SENTINEL'],
      }) as never;
    await expect(
      runDeterministicContractReplay({
        resolvedDataset: resolveNarrativeQualityDataset(dataset, syntheticGroundedFixtureResolver),
        versions: evalContractVersions,
        adapter: nonCatalogAdapter,
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
