import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { loadAiConfig, type AiConfig } from '../../srv/ai/config.ts';
import {
  AiProvider,
  AiTaskType,
  createInputFingerprint,
  type AiCallResult,
  type StructuredAiAdapter,
} from '../../srv/ai/contracts.ts';
import { AiError } from '../../srv/ai/errors.ts';
import { AiGateway } from '../../srv/ai/ai-gateway.ts';
import {
  OpenAiResponsesAdapter,
  createOpenAiSdkClient,
} from '../../srv/ai/adapters/openai-responses-adapter.ts';
import { PersistentAiRunRecorder } from '../../srv/ai/persistence/persistent-ai-run-recorder.ts';
import type {
  AiRunFailedUpdate,
  AiRunStartedRecord,
  AiRunStore,
  AiRunSucceededUpdate,
} from '../../srv/ai/persistence/ai-run-store.ts';
import type { AiRunRecorder, AiRunTelemetryEvent } from '../../srv/ai/telemetry.ts';
import { NARRATIVE_LIVE_BASELINE_OPERATION_PLAN } from '../../srv/evals/baseline.ts';
import {
  NARRATIVE_JUDGE_DIMENSIONS,
  type NarrativeJudgeOutput,
} from '../../srv/narratives/narrative-judge.ts';
import type { NarrativeModelView } from '../../srv/narratives/narrative-model-view.ts';
import type { NarrativeQualityContext } from '../../srv/narratives/narrative-quality-context.ts';
import type { OptionNarrativeOutput } from '../../srv/narratives/option-narrative.ts';
import { loadNarrativeQualityDataset } from '../../srv/evals/dataset.ts';
import {
  NARRATIVE_LIVE_EVAL_EXPECTED_GENERATE_CALLS,
  NARRATIVE_LIVE_EVAL_EXPECTED_JUDGE_CALLS,
  NARRATIVE_LIVE_EVAL_EXPECTED_LOGICAL_CALLS,
  NarrativeLiveEvalExecutionError,
  NarrativeLiveEvalPostProcessingError,
  createNarrativeQualityLiveEvalPlan,
  runNarrativeQualityLiveEvaluation,
  toSafeNarrativeLiveEvalFailure,
  type NarrativeLiveEvalCallDescriptor,
  type NarrativeLiveEvalExecutor,
} from '../../srv/evals/live-runner.ts';
import {
  NARRATIVE_PRICE_CATALOG_VERSION,
  loadAiPriceSnapshot,
  parseAiPriceSnapshot,
  requireVerifiedAiPriceSnapshot,
  type AiPriceSnapshot,
} from '../../srv/evals/price-snapshot.ts';
import { verifyEvalReportFingerprint } from '../../srv/evals/report.ts';
import { runNarrativeQualityLiveEvalScript } from '../../scripts/narrative-quality-eval-live.ts';

const enabledEnvironment = Object.freeze({
  AI_ENABLED: 'true',
  AI_LIVE_EVAL_ENABLED: 'true',
  AI_MAX_RETRIES: '0',
  OPENAI_API_KEY: 'offline-openai-placeholder',
  ANTHROPIC_API_KEY: 'offline-anthropic-placeholder',
});

function configuredPriceSnapshot(config: AiConfig): AiPriceSnapshot {
  const uniqueProfiles = [config.taskProfiles.GENERATE, config.taskProfiles.JUDGE].filter(
    (profile, index, profiles) =>
      profiles.findIndex(
        (candidate) => candidate.provider === profile.provider && candidate.model === profile.model,
      ) === index,
  );
  return parseAiPriceSnapshot({
    schemaVersion: 'ai-price-snapshot-schema-v1',
    priceCatalogVersion: NARRATIVE_PRICE_CATALOG_VERSION,
    pricingVerifiedAt: '2026-08-21',
    currency: 'USD',
    tokenUnit: 1_000_000,
    models: uniqueProfiles.map(({ provider, model }) => ({
      provider,
      model,
      inputUsdMicrosPerMillionTokens: 100,
      outputUsdMicrosPerMillionTokens: 200,
      cacheReadUsdMicrosPerMillionTokens: 50,
      cacheWriteUsdMicrosPerMillionTokens: 150,
      reasoningUsdMicrosPerMillionTokens: 300,
    })),
  });
}

function fakeGenerateOutput(
  descriptor: NarrativeLiveEvalCallDescriptor<unknown>,
): OptionNarrativeOutput {
  const view = descriptor.request.input as NarrativeModelView;
  const statusFacts = view.facts.filter(
    ({ status }) => status === 'UNKNOWN' || status === 'MISSING',
  );
  return {
    contextFingerprint: view.groundedContextFingerprint,
    blocks: [
      {
        kind: 'SUMMARY',
        text:
          descriptor.caseId === 'E03'
            ? 'Synthetic fixture: UNKNOWN values remain unknown; MISSING values remain missing.'
            : 'Synthetic evaluation summary.',
        factReferences:
          descriptor.caseId === 'E03'
            ? statusFacts.map(({ factId }) => factId)
            : [view.facts[0]!.factId],
      },
    ],
  };
}

const authoredById = new Map(
  loadNarrativeQualityDataset().cases.map((qualityCase) => [qualityCase.id, qualityCase]),
);

function fakeJudgeOutput(
  descriptor: NarrativeLiveEvalCallDescriptor<unknown>,
): NarrativeJudgeOutput {
  const quality = descriptor.request.input as NarrativeQualityContext;
  const authored =
    descriptor.pass === 'END_TO_END_JUDGE' ? undefined : authoredById.get(descriptor.caseId);
  const failed = new Set(authored?.expected.failedDimensions ?? []);
  return {
    qualityContextFingerprint: quality.fingerprint,
    narrativeFingerprint: quality.narrativeFingerprint,
    dimensions: NARRATIVE_JUDGE_DIMENSIONS.map((dimension) => ({
      dimension,
      status: failed.has(dimension) ? 'FAIL' : 'PASS',
    })),
    findings: (authored?.expected.requiredReasonCodes ?? []).map((reasonCode) => ({
      reasonCode,
      severity: authored?.expected.critical ? 'CRITICAL' : 'MAJOR',
      blockSequences: [1],
      factIds: [],
    })),
  };
}

function fakeResult<TOutput>(
  descriptor: NarrativeLiveEvalCallDescriptor<TOutput>,
  output: unknown,
): AiCallResult<TOutput> {
  return {
    aiRunId: randomUUID(),
    output: descriptor.request.outputSchema.parse(output),
    provider: descriptor.profile.provider,
    configuredModel: descriptor.profile.model,
    responseModel: `${descriptor.profile.model}-response-v1`,
    taskType: descriptor.request.taskType,
    promptVersion: descriptor.request.promptVersion,
    schemaVersion: descriptor.request.schemaVersion,
    inputFingerprint: createInputFingerprint(descriptor.request.input),
    usage: {
      inputTokens: 12,
      outputTokens: 8,
      totalTokens: 20,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
    },
    latencyMs: 5,
    attempts: 1,
    refusal: { refused: false },
  };
}

function accountedInvalidJudgeError(
  descriptor: NarrativeLiveEvalCallDescriptor<unknown>,
  validationFailureStage:
    | 'RESPONSE_JSON_PARSE'
    | 'TRANSPORT_SCHEMA_VALIDATION'
    | 'CONTEXT_BINDING'
    | 'DIMENSION_BINDING'
    | 'FINDING_BINDING' = 'CONTEXT_BINDING',
  durableFailedAuditLinked = true,
): AiError {
  return new AiError('INVALID_STRUCTURED_OUTPUT', 'Controlled invalid structured output.', {
    provider: descriptor.profile.provider,
    model: descriptor.profile.model,
    retryable: false,
    details: durableFailedAuditLinked ? { aiRunId: randomUUID() } : {},
    executionEvidence: {
      provider: descriptor.profile.provider,
      configuredModel: descriptor.profile.model,
      providerCallAttempted: true,
      validationFailureStage,
      responseModel: `${descriptor.profile.model}-response-v1`,
      providerResponseStatus: 'COMPLETED',
      providerRequestId: `req_${descriptor.plannedSequence}`,
      providerResponseId: `resp_${descriptor.plannedSequence}`,
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 5,
      },
      attempts: 1,
      latencyMs: 25,
    },
    cause: new Error(
      'RAW_INVALID_OUTPUT_SENTINEL PROMPT_REPORT_SENTINEL CANDIDATE_REPORT_SENTINEL ' +
        'CONTEXT_REPORT_SENTINEL https://private.example.test/report private@example.test ' +
        'sk-proj-report-secret RAW_PROVIDER_REPORT_SENTINEL PROVIDER_STACK_SENTINEL',
    ),
  });
}

class SuccessfulOfflineExecutor implements NarrativeLiveEvalExecutor {
  readonly calls: NarrativeLiveEvalCallDescriptor<unknown>[] = [];

  async call<TOutput>(descriptor: NarrativeLiveEvalCallDescriptor<TOutput>) {
    this.calls.push(descriptor as NarrativeLiveEvalCallDescriptor<unknown>);
    const output =
      descriptor.request.taskType === AiTaskType.GENERATE
        ? fakeGenerateOutput(descriptor as NarrativeLiveEvalCallDescriptor<unknown>)
        : fakeJudgeOutput(descriptor as NarrativeLiveEvalCallDescriptor<unknown>);
    return { result: fakeResult(descriptor, output), auditSucceeded: true as const };
  }
}

class RecordingAiRunStore implements AiRunStore {
  readonly started: AiRunStartedRecord[] = [];
  readonly succeeded: { readonly ID: string; readonly update: AiRunSucceededUpdate }[] = [];
  readonly failed: { readonly ID: string; readonly update: AiRunFailedUpdate }[] = [];

  async insertStarted(record: AiRunStartedRecord): Promise<void> {
    this.started.push(record);
  }

  async completeSucceeded(ID: string, update: AiRunSucceededUpdate): Promise<void> {
    this.succeeded.push({ ID, update });
  }

  async completeFailed(ID: string, update: AiRunFailedUpdate): Promise<void> {
    this.failed.push({ ID, update });
  }

  async deleteExpired(): Promise<number> {
    return 0;
  }
}

describe('narrative live-eval plan and preflight', () => {
  it('builds the exact synthetic 46-call plan with retries disabled', () => {
    const config = loadAiConfig(enabledEnvironment);
    const plan = createNarrativeQualityLiveEvalPlan({
      config,
    });

    expect(plan).toMatchObject({
      syntheticOnly: true,
      semanticCases: 32,
      precheckCases: 2,
      repeatedSentinels: 8,
      endToEndCases: 4,
      plannedLogicalCalls: NARRATIVE_LIVE_EVAL_EXPECTED_LOGICAL_CALLS,
      plannedMaximumAttempts: NARRATIVE_LIVE_EVAL_EXPECTED_LOGICAL_CALLS,
    });
    expect(plan.calls.filter(({ taskType }) => taskType === 'GENERATE')).toHaveLength(
      NARRATIVE_LIVE_EVAL_EXPECTED_GENERATE_CALLS,
    );
    expect(plan.calls.filter(({ taskType }) => taskType === 'JUDGE')).toHaveLength(
      NARRATIVE_LIVE_EVAL_EXPECTED_JUDGE_CALLS,
    );
    expect(
      plan.calls
        .filter(({ taskType }) => taskType === 'JUDGE')
        .every(
          ({ configuredModel, configuredMaxOutputTokens, maximumOutputTokensPerAttempt }) =>
            configuredModel === 'gpt-5.6-luna' &&
            configuredMaxOutputTokens === 2_048 &&
            maximumOutputTokensPerAttempt === 2_048,
        ),
    ).toBe(true);
    expect(plan.calls[0]).toMatchObject({
      plannedSequence: 1,
      caseId: 'P01',
      pass: 'PRIMARY',
      taskType: 'JUDGE',
      maximumAttempts: 1,
    });
    expect(plan.calls[29]).toMatchObject({ caseId: 'R19', pass: 'PRIMARY' });
    expect(plan.calls[30]).toMatchObject({ caseId: 'P10', pass: 'STABILITY_REPEAT' });
    expect(plan.calls[38]).toMatchObject({
      plannedSequence: 39,
      caseId: 'E01',
      pass: 'END_TO_END_GENERATE',
    });
    expect(plan.calls.at(-1)).toMatchObject({
      plannedSequence: 46,
      caseId: 'E04',
      pass: 'END_TO_END_JUDGE',
    });
    expect(
      plan.calls.map(({ plannedSequence, caseId, taskType }) => ({
        logicalCallSequence: plannedSequence,
        caseId,
        taskType,
      })),
    ).toEqual(NARRATIVE_LIVE_BASELINE_OPERATION_PLAN);
  });

  it.each([
    {
      name: 'missing live opt-in',
      environment: { ...enabledEnvironment, AI_LIVE_EVAL_ENABLED: 'false' },
      priceMode: 'configured',
    },
    {
      name: 'missing gateway opt-in',
      environment: { ...enabledEnvironment, AI_ENABLED: 'false' },
      priceMode: 'configured',
    },
    {
      name: 'missing OpenAI credential',
      environment: { ...enabledEnvironment, OPENAI_API_KEY: undefined },
      priceMode: 'configured',
    },
    {
      name: 'missing Anthropic credential',
      environment: { ...enabledEnvironment, ANTHROPIC_API_KEY: undefined },
      priceMode: 'configured',
    },
    {
      name: 'unknown model pricing',
      environment: enabledEnvironment,
      priceMode: 'empty',
    },
    {
      name: 'logical-call cap below the frozen plan',
      environment: { ...enabledEnvironment, AI_LIVE_EVAL_MAX_LOGICAL_CALLS: '45' },
      priceMode: 'configured',
    },
    {
      name: 'missing pricing verification date',
      environment: enabledEnvironment,
      priceMode: 'legacy',
    },
    {
      name: 'invalid pricing verification date',
      environment: enabledEnvironment,
      priceMode: 'invalid-date',
    },
  ])('blocks $name before constructing the executor', async ({ environment, priceMode }) => {
    const config = loadAiConfig(environment);
    let factoryCalls = 0;
    const configuredSnapshot = configuredPriceSnapshot(config);
    let priceSnapshot: AiPriceSnapshot;
    if (priceMode === 'empty') {
      priceSnapshot = parseAiPriceSnapshot({
        schemaVersion: 'ai-price-snapshot-schema-v1',
        priceCatalogVersion: NARRATIVE_PRICE_CATALOG_VERSION,
        pricingVerifiedAt: '2026-08-21',
        currency: 'USD',
        tokenUnit: 1_000_000,
        models: [],
      });
    } else if (priceMode === 'legacy') {
      const legacyInput: Record<string, unknown> = { ...configuredSnapshot };
      delete legacyInput.pricingVerifiedAt;
      priceSnapshot = parseAiPriceSnapshot(legacyInput);
    } else if (priceMode === 'invalid-date') {
      priceSnapshot = { ...configuredSnapshot, pricingVerifiedAt: '2026-02-30' };
    } else {
      priceSnapshot = configuredSnapshot;
    }

    await expect(
      runNarrativeQualityLiveEvaluation({
        env: environment,
        config,
        priceSnapshot,
        createExecutor: async () => {
          factoryCalls += 1;
          return new SuccessfulOfflineExecutor();
        },
      }),
    ).rejects.toMatchObject({ code: 'LIVE_EVAL_BLOCKED' });
    expect(factoryCalls).toBe(0);
  });

  it('blocks the default one-retry gateway plan because 92 attempts exceed the hard cap', async () => {
    const environment = { ...enabledEnvironment, AI_MAX_RETRIES: '1' };
    const config = loadAiConfig(environment);
    let factoryCalls = 0;
    const plan = createNarrativeQualityLiveEvalPlan({ config });

    expect(plan.plannedMaximumAttempts).toBe(92);
    expect(plan.calls.every(({ maximumAttempts }) => maximumAttempts === 2)).toBe(true);

    await expect(
      runNarrativeQualityLiveEvaluation({
        env: environment,
        config,
        priceSnapshot: configuredPriceSnapshot(config),
        createExecutor: async () => {
          factoryCalls += 1;
          return new SuccessfulOfflineExecutor();
        },
      }),
    ).rejects.toMatchObject({ code: 'LIVE_EVAL_BLOCKED' });
    expect(factoryCalls).toBe(0);
  });
});

describe('narrative live-eval execution without provider calls', () => {
  it('runs all cases through a fake executor and emits only privacy-safe evidence', async () => {
    const config = loadAiConfig(enabledEnvironment);
    const executor = new SuccessfulOfflineExecutor();
    const result = await runNarrativeQualityLiveEvaluation({
      env: enabledEnvironment,
      config,
      priceSnapshot: configuredPriceSnapshot(config),
      createExecutor: async () => executor,
    });

    expect(executor.calls).toHaveLength(NARRATIVE_LIVE_EVAL_EXPECTED_LOGICAL_CALLS);
    expect(
      executor.calls.filter(({ caseId, pass }) => pass === 'PRIMARY' && caseId === 'R09'),
    ).toHaveLength(0);
    expect(
      executor.calls.filter(({ caseId, pass }) => pass === 'PRIMARY' && caseId === 'R20'),
    ).toHaveLength(0);
    expect(result.primaryOutcomes).toHaveLength(32);
    expect(result.repeatedSentinelOutcomes).toHaveLength(8);
    expect(result.endToEndOutcomes).toHaveLength(4);
    expect(result.report.semantic.metrics.criticalFalseAccepts).toBe(0);
    expect(result.report.semantic.metrics.strictJudgeOutputValidity.value).toBe(1);
    expect(result.report.stability.gates.passed).toBe(true);
    expect(result.report.endToEnd.gates.passed).toBe(true);
    expect(result.report.endToEnd.requiredPropertyCatalogVersion).toBe(
      'narrative-e2e-required-properties-v1',
    );
    expect(
      result.report.endToEnd.cases.flatMap(({ requiredPropertyResults }) =>
        requiredPropertyResults.map(({ passed }) => passed),
      ),
    ).toEqual(Array.from({ length: 16 }, () => true));
    expect(result.report.operationalSummary).toMatchObject({
      logicalCalls: 46,
      providerAttempts: 46,
      refusals: 0,
    });
    verifyEvalReportFingerprint(result.report);

    const serialized = JSON.stringify(result.report);
    expect(serialized).not.toContain('Synthetic evaluation summary.');
    expect(serialized).not.toContain('factReferences');
    expect(serialized).not.toContain('sourceUrl');
    expect(serialized).not.toContain('externalItemId');
    expect(serialized).not.toContain('You write concise narrative blocks');
  });

  it('preserves complete settled accounting when deterministic report construction fails', async () => {
    const config = loadAiConfig(enabledEnvironment);
    const executor = new SuccessfulOfflineExecutor();
    let failure: unknown;
    try {
      await runNarrativeQualityLiveEvaluation({
        env: enabledEnvironment,
        config,
        priceSnapshot: configuredPriceSnapshot(config),
        createExecutor: async () => executor,
        buildReport: () => {
          throw Object.assign(new Error('RAW_POST_PROCESSING_SENTINEL'), {
            code: 'POST_PROCESSING_FAILED',
            stack: 'PRIVATE_POST_PROCESSING_STACK_SENTINEL',
          });
        },
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(NarrativeLiveEvalPostProcessingError);
    expect(executor.calls).toHaveLength(NARRATIVE_LIVE_EVAL_EXPECTED_LOGICAL_CALLS);
    const safeFailure = toSafeNarrativeLiveEvalFailure(failure);
    expect(safeFailure).toMatchObject({
      status: 'FAILED',
      code: 'LIVE_EVAL_RUNNER_FAILED',
      reportProduced: false,
      providerCallAttempted: true,
      attemptAccountingComplete: true,
      completedLogicalCalls: NARRATIVE_LIVE_EVAL_EXPECTED_LOGICAL_CALLS,
      underlyingCode: 'UNKNOWN',
      knownCumulativeProviderAttempts: NARRATIVE_LIVE_EVAL_EXPECTED_LOGICAL_CALLS,
    });
    expect(safeFailure.knownCumulativeEstimatedCostUsdMicros).toBeGreaterThan(0);
    expect(JSON.stringify(safeFailure)).not.toMatch(
      /RAW_POST_PROCESSING_SENTINEL|PRIVATE_POST_PROCESSING_STACK_SENTINEL/,
    );
  });

  it('continues after one completely accounted invalid primary JUDGE and produces a FAIL report', async () => {
    const config = loadAiConfig(enabledEnvironment);
    const successful = new SuccessfulOfflineExecutor();
    const attemptedSequences: number[] = [];
    const result = await runNarrativeQualityLiveEvaluation({
      env: enabledEnvironment,
      config,
      priceSnapshot: configuredPriceSnapshot(config),
      createExecutor: async () => ({
        async call<TOutput>(descriptor: NarrativeLiveEvalCallDescriptor<TOutput>) {
          attemptedSequences.push(descriptor.plannedSequence);
          if (descriptor.caseId === 'P01' && descriptor.pass === 'PRIMARY') {
            throw accountedInvalidJudgeError(
              descriptor as NarrativeLiveEvalCallDescriptor<unknown>,
              'CONTEXT_BINDING',
            );
          }
          return successful.call(descriptor);
        },
      }),
    });

    expect(attemptedSequences).toHaveLength(46);
    expect(attemptedSequences.slice(0, 2)).toEqual([1, 2]);
    expect(result.primaryOutcomes[0]).toEqual({
      caseId: 'P01',
      actualDecision: 'REJECT',
      actualStage: 'JUDGE',
      failedDimensions: [],
      reasonCodes: [],
      strictJudgeOutputValid: false,
    });
    expect(result.report.semantic.metrics.strictJudgeOutputValidity).toMatchObject({
      numerator: 29,
      denominator: 30,
    });
    expect(result.report.semantic.gates.failures).toContain('STRICT_JUDGE_OUTPUT_VALIDITY');
    expect(result.report.operations[0]).toMatchObject({
      logicalCallSequence: 1,
      caseId: 'P01',
      terminalAuditStatus: 'FAILED',
      structuredOutputValid: false,
      validationFailureStage: 'CONTEXT_BINDING',
      exactAuditLinkageValid: true,
      attempts: 1,
    });
    expect(result.report.operations[1]).toMatchObject({
      logicalCallSequence: 2,
      terminalAuditStatus: 'SUCCEEDED',
      structuredOutputValid: true,
      validationFailureStage: null,
      exactAuditLinkageValid: true,
    });
    expect(JSON.stringify(result.report)).not.toMatch(
      /RAW_INVALID_OUTPUT_SENTINEL|PROMPT_REPORT_SENTINEL|CANDIDATE_REPORT_SENTINEL|CONTEXT_REPORT_SENTINEL|private\.example\.test|private@example\.test|sk-proj-report-secret|RAW_PROVIDER_REPORT_SENTINEL|PROVIDER_STACK_SENTINEL|aiRunId|req_1|resp_1/,
    );
  });

  it('continues through accounted repeat and E2E JUDGE invalid outputs without inflating validity gates', async () => {
    const config = loadAiConfig(enabledEnvironment);
    const successful = new SuccessfulOfflineExecutor();
    let calls = 0;
    const result = await runNarrativeQualityLiveEvaluation({
      env: enabledEnvironment,
      config,
      priceSnapshot: configuredPriceSnapshot(config),
      createExecutor: async () => ({
        async call<TOutput>(descriptor: NarrativeLiveEvalCallDescriptor<TOutput>) {
          calls += 1;
          if (descriptor.caseId === 'R01' && descriptor.pass === 'STABILITY_REPEAT') {
            throw accountedInvalidJudgeError(
              descriptor as NarrativeLiveEvalCallDescriptor<unknown>,
              'DIMENSION_BINDING',
            );
          }
          if (descriptor.caseId === 'E01' && descriptor.pass === 'END_TO_END_JUDGE') {
            throw accountedInvalidJudgeError(
              descriptor as NarrativeLiveEvalCallDescriptor<unknown>,
              'FINDING_BINDING',
            );
          }
          return successful.call(descriptor);
        },
      }),
    });

    expect(calls).toBe(46);
    expect(result.report.stability.metrics.repeatJudgeOutputValidity).toMatchObject({
      numerator: 7,
      denominator: 8,
    });
    expect(result.report.stability.metrics.exactDecisionAgreement).toMatchObject({
      numerator: 7,
      denominator: 8,
    });
    expect(result.report.stability.gates.failures).toContain('REPEAT_JUDGE_OUTPUT_VALIDITY');
    expect(result.report.endToEnd.metrics.judgeStructuredOutputValidity).toMatchObject({
      numerator: 3,
      denominator: 4,
    });
    expect(result.report.endToEnd.gates.failures).toContain('JUDGE_STRUCTURED_OUTPUT_VALIDITY');
    expect(result.endToEndOutcomes[0]).toMatchObject({
      caseId: 'E01',
      actualDecision: 'REJECT',
      judgeStructuredOutputValid: false,
      judgeAuditSucceeded: false,
      publicationBundleLinkageValidInMemory: false,
    });
  });

  it('stops an otherwise accounted invalid JUDGE when durable FAILED audit linkage is absent', async () => {
    const config = loadAiConfig(enabledEnvironment);
    let calls = 0;
    let failure: unknown;
    try {
      await runNarrativeQualityLiveEvaluation({
        env: enabledEnvironment,
        config,
        priceSnapshot: configuredPriceSnapshot(config),
        createExecutor: async () => ({
          async call(descriptor) {
            calls += 1;
            throw accountedInvalidJudgeError(
              descriptor as NarrativeLiveEvalCallDescriptor<unknown>,
              'RESPONSE_JSON_PARSE',
              false,
            );
          },
        }),
      });
    } catch (error) {
      failure = error;
    }

    expect(calls).toBe(1);
    expect(toSafeNarrativeLiveEvalFailure(failure)).toMatchObject({
      status: 'FAILED',
      reportProduced: false,
      providerCallAttempted: true,
      attemptAccountingComplete: true,
      logicalCallSequence: 1,
      completedLogicalCalls: 0,
      underlyingCode: 'INVALID_STRUCTURED_OUTPUT',
      validationFailureStage: 'RESPONSE_JSON_PARSE',
      knownCumulativeProviderAttempts: 1,
    });
    expect(JSON.stringify(toSafeNarrativeLiveEvalFailure(failure))).not.toContain('aiRunId');
  });

  it('classifies schema construction as a complete zero-provider-attempt fatal failure', async () => {
    const config = loadAiConfig(enabledEnvironment);
    let calls = 0;
    let failure: unknown;
    try {
      await runNarrativeQualityLiveEvaluation({
        env: enabledEnvironment,
        config,
        priceSnapshot: configuredPriceSnapshot(config),
        createExecutor: async () => ({
          async call(descriptor) {
            calls += 1;
            throw new AiError(
              'INVALID_STRUCTURED_OUTPUT',
              'Controlled schema construction failure.',
              {
                provider: descriptor.profile.provider,
                model: descriptor.profile.model,
                details: { aiRunId: randomUUID() },
                executionEvidence: {
                  provider: descriptor.profile.provider,
                  configuredModel: descriptor.profile.model,
                  providerCallAttempted: false,
                  validationFailureStage: 'SCHEMA_CONSTRUCTION',
                  attempts: 0,
                  latencyMs: 1,
                },
              },
            );
          },
        }),
      });
    } catch (error) {
      failure = error;
    }

    expect(calls).toBe(1);
    expect(toSafeNarrativeLiveEvalFailure(failure)).toMatchObject({
      status: 'FAILED',
      reportProduced: false,
      providerCallAttempted: false,
      attemptAccountingComplete: true,
      logicalCallSequence: 1,
      attempts: 0,
      validationFailureStage: 'SCHEMA_CONSTRUCTION',
      knownCumulativeProviderAttempts: 0,
      knownCumulativeEstimatedCostUsdMicros: 0,
    });
  });

  it('keeps a real gateway STARTED audit failure at complete zero-call accounting', async () => {
    const config = loadAiConfig(enabledEnvironment);
    let adapterCalls = 0;
    let executorCalls = 0;
    const adapter: StructuredAiAdapter = {
      provider: AiProvider.OPENAI,
      async call<TOutput>(): Promise<AiCallResult<TOutput>> {
        adapterCalls += 1;
        throw new Error('The adapter must remain unreachable.');
      },
    };
    const recorder: AiRunRecorder = {
      async record() {
        throw new Error('RAW_STARTED_AUDIT_FAILURE_SENTINEL');
      },
    };
    const gateway = new AiGateway(config, [adapter], recorder);
    let failure: unknown;
    try {
      await runNarrativeQualityLiveEvaluation({
        env: enabledEnvironment,
        config,
        priceSnapshot: configuredPriceSnapshot(config),
        createExecutor: async () => ({
          async call<TOutput>(descriptor: NarrativeLiveEvalCallDescriptor<TOutput>) {
            executorCalls += 1;
            return {
              result: await gateway.call(descriptor.request),
              auditSucceeded: true as const,
            };
          },
        }),
      });
    } catch (error) {
      failure = error;
    }

    const safeFailure = toSafeNarrativeLiveEvalFailure(failure);
    expect(executorCalls).toBe(1);
    expect(adapterCalls).toBe(0);
    expect(safeFailure).toMatchObject({
      status: 'FAILED',
      reportProduced: false,
      providerCallAttempted: false,
      attemptAccountingComplete: true,
      logicalCallSequence: 1,
      completedLogicalCalls: 0,
      underlyingCode: 'AI_AUDIT_FAILED',
      provider: 'OPENAI',
      configuredModel: 'gpt-5.6-luna',
      attempts: 0,
      knownCumulativeProviderAttempts: 0,
      knownCumulativeEstimatedCostUsdMicros: 0,
    });
    expect(JSON.stringify(safeFailure)).not.toContain('RAW_STARTED_AUDIT_FAILURE_SENTINEL');
  });

  it('keeps pre-request accounting incomplete when failure evidence does not match the profile', async () => {
    const config = loadAiConfig(enabledEnvironment);
    let failure: unknown;
    try {
      await runNarrativeQualityLiveEvaluation({
        env: enabledEnvironment,
        config,
        priceSnapshot: configuredPriceSnapshot(config),
        createExecutor: async () => ({
          async call(descriptor) {
            throw new AiError(
              'INVALID_STRUCTURED_OUTPUT',
              'Controlled mismatched schema-construction evidence.',
              {
                provider: descriptor.profile.provider,
                model: descriptor.profile.model,
                executionEvidence: {
                  provider: descriptor.profile.provider,
                  configuredModel: `${descriptor.profile.model}-mismatch`,
                  providerCallAttempted: false,
                  validationFailureStage: 'SCHEMA_CONSTRUCTION',
                  attempts: 0,
                  latencyMs: 1,
                },
              },
            );
          },
        }),
      });
    } catch (error) {
      failure = error;
    }

    expect(toSafeNarrativeLiveEvalFailure(failure)).toMatchObject({
      status: 'FAILED',
      reportProduced: false,
      providerCallAttempted: false,
      attemptAccountingComplete: false,
      logicalCallSequence: 1,
      attempts: 0,
      knownCumulativeProviderAttempts: 0,
      knownCumulativeEstimatedCostUsdMicros: 0,
    });
  });

  it('stops a post-response invalid output when usage accounting is incomplete', async () => {
    const config = loadAiConfig(enabledEnvironment);
    let calls = 0;
    let failure: unknown;
    try {
      await runNarrativeQualityLiveEvaluation({
        env: enabledEnvironment,
        config,
        priceSnapshot: configuredPriceSnapshot(config),
        createExecutor: async () => ({
          async call(descriptor) {
            calls += 1;
            throw new AiError('INVALID_STRUCTURED_OUTPUT', 'Controlled missing usage.', {
              provider: descriptor.profile.provider,
              model: descriptor.profile.model,
              details: { aiRunId: randomUUID() },
              executionEvidence: {
                provider: descriptor.profile.provider,
                configuredModel: descriptor.profile.model,
                providerCallAttempted: true,
                validationFailureStage: 'TRANSPORT_SCHEMA_VALIDATION',
                responseModel: `${descriptor.profile.model}-response-v1`,
                providerResponseStatus: 'COMPLETED',
                providerRequestId: 'req_missing_usage',
                providerResponseId: 'resp_missing_usage',
                attempts: 1,
                latencyMs: 5,
              },
            });
          },
        }),
      });
    } catch (error) {
      failure = error;
    }

    expect(calls).toBe(1);
    expect(toSafeNarrativeLiveEvalFailure(failure)).toMatchObject({
      status: 'FAILED',
      reportProduced: false,
      providerCallAttempted: true,
      attemptAccountingComplete: false,
      logicalCallSequence: 1,
      completedLogicalCalls: 0,
      validationFailureStage: 'TRANSPORT_SCHEMA_VALIDATION',
      knownCumulativeProviderAttempts: 0,
      knownCumulativeEstimatedCostUsdMicros: 0,
    });
  });

  it('fails the E2E gate on an independent property despite an all-PASS JUDGE', async () => {
    const config = loadAiConfig(enabledEnvironment);
    const result = await runNarrativeQualityLiveEvaluation({
      env: enabledEnvironment,
      config,
      priceSnapshot: configuredPriceSnapshot(config),
      createExecutor: async () => ({
        async call<TOutput>(descriptor: NarrativeLiveEvalCallDescriptor<TOutput>) {
          let output: unknown;
          if (descriptor.request.taskType === AiTaskType.JUDGE) {
            output = fakeJudgeOutput(descriptor as NarrativeLiveEvalCallDescriptor<unknown>);
          } else if (descriptor.caseId === 'E02') {
            const view = descriptor.request.input as NarrativeModelView;
            output = {
              contextFingerprint: view.groundedContextFingerprint,
              blocks: [
                {
                  kind: 'SUMMARY',
                  text: 'Synthetic cached offer is currently available.',
                  factReferences: [view.facts[0]!.factId],
                },
              ],
            };
          } else {
            output = fakeGenerateOutput(descriptor as NarrativeLiveEvalCallDescriptor<unknown>);
          }
          return { result: fakeResult(descriptor, output), auditSucceeded: true as const };
        },
      }),
    });

    const vienna = result.endToEndOutcomes.find(({ caseId }) => caseId === 'E02')!;
    expect(vienna.actualDecision).toBe('PUBLISH');
    expect(
      vienna.requiredPropertyResults.find(({ propertyId }) => propertyId === 'cached-not-live'),
    ).toEqual({
      propertyId: 'cached-not-live',
      passed: false,
      failureCode: 'CACHED_SOURCE_PRESENTED_AS_LIVE',
    });
    expect(result.report.endToEnd.gates).toEqual({
      passed: false,
      failures: ['REQUIRED_PROPERTY_FAILURE'],
    });
    const serialized = JSON.stringify(result.report);
    expect(serialized).toContain('CACHED_SOURCE_PRESENTED_AS_LIVE');
    expect(serialized).not.toContain('Synthetic cached offer is currently available.');
  });

  it('stops after the first thrown provider failure and exposes no partial report', async () => {
    const config = loadAiConfig(enabledEnvironment);
    let calls = 0;
    let completed = false;

    try {
      await runNarrativeQualityLiveEvaluation({
        env: enabledEnvironment,
        config,
        priceSnapshot: configuredPriceSnapshot(config),
        createExecutor: async () => ({
          async call() {
            calls += 1;
            throw new AiError('PROVIDER_UNAVAILABLE', 'controlled offline failure', {
              retryable: true,
            });
          },
        }),
      });
      completed = true;
    } catch (error) {
      expect(error).toBeInstanceOf(NarrativeLiveEvalExecutionError);
      expect(toSafeNarrativeLiveEvalFailure(error)).toEqual({
        status: 'FAILED',
        code: 'LIVE_EVAL_EXECUTION_FAILED',
        reportProduced: false,
        providerCallAttempted: true,
        attemptAccountingComplete: false,
        caseId: 'P01',
        taskType: 'JUDGE',
        logicalCallSequence: 1,
        completedLogicalCalls: 0,
        underlyingCode: 'PROVIDER_UNAVAILABLE',
        knownCumulativeProviderAttempts: 0,
        knownCumulativeEstimatedCostUsdMicros: 0,
      });
    }

    expect(completed).toBe(false);
    expect(calls).toBe(1);
  });

  it('settles incomplete max-output evidence and stops without retry, resume, continuation or fallback', async () => {
    const config = loadAiConfig(enabledEnvironment);
    let calls = 0;
    let failure: unknown;

    try {
      await runNarrativeQualityLiveEvaluation({
        env: enabledEnvironment,
        config,
        priceSnapshot: configuredPriceSnapshot(config),
        createExecutor: async () => ({
          async call(descriptor) {
            calls += 1;
            throw new AiError(
              'INCOMPLETE_MODEL_OUTPUT',
              'Controlled terminal incomplete response.',
              {
                provider: descriptor.profile.provider,
                model: descriptor.profile.model,
                retryable: false,
                executionEvidence: {
                  provider: descriptor.profile.provider,
                  configuredModel: descriptor.profile.model,
                  providerCallAttempted: true,
                  responseModel: `${descriptor.profile.model}-response-v1`,
                  providerResponseStatus: 'INCOMPLETE',
                  providerIncompleteReason: 'MAX_OUTPUT_TOKENS',
                  providerRequestId: 'req_live_runner',
                  providerResponseId: 'resp_live_runner',
                  usage: {
                    inputTokens: 100,
                    outputTokens: 20,
                    totalTokens: 120,
                    cacheReadTokens: 0,
                    cacheWriteTokens: 80,
                    reasoningTokens: 5,
                  },
                  attempts: 1,
                  latencyMs: 250,
                },
                cause: new Error(
                  'sk-proj-private PROMPT_SENTINEL CANDIDATE_SENTINEL RAW_PROVIDER_MESSAGE',
                ),
              },
            );
          },
        }),
      });
    } catch (error) {
      failure = error;
    }

    expect(calls).toBe(1);
    expect(toSafeNarrativeLiveEvalFailure(failure)).toEqual({
      status: 'FAILED',
      code: 'LIVE_EVAL_EXECUTION_FAILED',
      reportProduced: false,
      providerCallAttempted: true,
      attemptAccountingComplete: true,
      caseId: 'P01',
      taskType: 'JUDGE',
      logicalCallSequence: 1,
      completedLogicalCalls: 0,
      underlyingCode: 'INCOMPLETE_MODEL_OUTPUT',
      provider: 'OPENAI',
      configuredModel: 'gpt-5.6-luna',
      responseModel: 'gpt-5.6-luna-response-v1',
      providerResponseStatus: 'INCOMPLETE',
      providerIncompleteReason: 'MAX_OUTPUT_TOKENS',
      providerRequestId: 'req_live_runner',
      providerResponseId: 'resp_live_runner',
      attempts: 1,
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120,
        cacheReadTokens: 0,
        cacheWriteTokens: 80,
        reasoningTokens: 5,
      },
      latencyMs: 250,
      knownCumulativeProviderAttempts: 1,
      knownCumulativeEstimatedCostUsdMicros: 4,
    });
    expect(JSON.stringify(toSafeNarrativeLiveEvalFailure(failure))).not.toMatch(
      /sk-proj-private|PROMPT_SENTINEL|CANDIDATE_SENTINEL|RAW_PROVIDER_MESSAGE/,
    );
  });

  it('fails closed on fake configured-model drift after one logical call', async () => {
    const config = loadAiConfig(enabledEnvironment);
    let calls = 0;
    await expect(
      runNarrativeQualityLiveEvaluation({
        env: enabledEnvironment,
        config,
        priceSnapshot: configuredPriceSnapshot(config),
        createExecutor: async () => ({
          async call<TOutput>(descriptor: NarrativeLiveEvalCallDescriptor<TOutput>) {
            calls += 1;
            const output = fakeJudgeOutput(descriptor as NarrativeLiveEvalCallDescriptor<unknown>);
            return {
              result: {
                ...fakeResult(descriptor, output),
                configuredModel: 'drifted-model',
              },
              auditSucceeded: true as const,
            };
          },
        }),
      }),
    ).rejects.toMatchObject({
      code: 'LIVE_EVAL_EXECUTION_FAILED',
      caseId: 'P01',
      logicalCallSequence: 1,
    });
    expect(calls).toBe(1);
  });
});

describe('narrative live-eval CLI boundary', () => {
  it('emits allow-listed preflight and report lines with an injected offline executor', async () => {
    const config = loadAiConfig(enabledEnvironment);
    const executor = new SuccessfulOfflineExecutor();
    const lines: string[] = [];

    const exitCode = await runNarrativeQualityLiveEvalScript(
      enabledEnvironment,
      (line) => lines.push(line),
      {
        loadPriceSnapshot: () => configuredPriceSnapshot(config),
        createExecutor: async () => executor,
      },
    );

    expect(exitCode).toBe(0);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      status: 'PREFLIGHT_PASSED',
      planVersion: 'narrative-quality-live-plan-v1',
      tokenCeilingVersion: 'utf8-wire-bytes-plus-4096-protocol-tokens-v1',
      costCeilingVersion: 'full-ceiling-each-token-class-v1',
      retryPolicyVersion: 'zero-retry-with-terminal-failure-accounting-v2',
      executionContractVersion: 'narrative-quality-live-execution-v2',
      failureAccountingVersion: 'post-response-failure-accounting-v3',
      workloadFingerprint: '2daba2bbc43db32e86bb29ec0bc5e5bd8bb0a9226189f246e240d8f437b61c6b',
      plannedLogicalCalls: 46,
      plannedMaximumAttempts: 46,
      plannedMaximumCostUsdMicros: expect.any(Number),
      priceCatalogVersion: 'narrative-quality-price-catalog-v1',
      pricingVerifiedAt: '2026-08-21',
      limits: {
        maxLogicalCalls: 48,
        maxProviderAttempts: 56,
        maxEstimatedCostUsdMicros: 3_000_000,
      },
      profiles: [
        {
          taskType: 'GENERATE',
          provider: 'ANTHROPIC',
          configuredModel: 'claude-sonnet-5',
          configuredEffort: 'low',
          configuredMaxOutputTokens: 1_600,
        },
        {
          taskType: 'JUDGE',
          provider: 'OPENAI',
          configuredModel: 'gpt-5.6-luna',
          configuredEffort: 'low',
          configuredMaxOutputTokens: 2_048,
        },
      ],
      syntheticOnly: true,
    });
    expect(JSON.parse(lines[1]!)).toMatchObject({
      status: 'PASS',
      report: { operationalSummary: { logicalCalls: 46, providerAttempts: 46 } },
    });
    expect(lines.join('\n')).not.toMatch(
      /Synthetic evaluation summary|factReferences|sourceUrl|externalItemId|api[_-]?key/iu,
    );
  });

  it('emits only allow-listed settled failure accounting and no raw sentinels', async () => {
    const config = loadAiConfig(enabledEnvironment);
    const lines: string[] = [];
    let calls = 0;
    const sentinels = [
      'sk-proj-stdout-sentinel',
      'PROMPT_STDOUT_SENTINEL',
      'CANDIDATE_STDOUT_SENTINEL',
      'RAW_PROVIDER_STDOUT_SENTINEL',
      'CONTEXT_STDOUT_SENTINEL',
      'https://private.example.test/source',
      'private@example.test',
      'EXTERNAL_ITEM_STDOUT_SENTINEL',
      'PROVIDER_STACK_SENTINEL',
    ];

    const exitCode = await runNarrativeQualityLiveEvalScript(
      enabledEnvironment,
      (line) => lines.push(line),
      {
        loadPriceSnapshot: () => configuredPriceSnapshot(config),
        createExecutor: async () => ({
          async call(descriptor) {
            calls += 1;
            throw new AiError('INCOMPLETE_MODEL_OUTPUT', 'Controlled terminal failure.', {
              provider: descriptor.profile.provider,
              model: descriptor.profile.model,
              executionEvidence: {
                provider: descriptor.profile.provider,
                configuredModel: descriptor.profile.model,
                providerCallAttempted: true,
                responseModel: `${descriptor.profile.model}-response-v1`,
                providerResponseStatus: 'INCOMPLETE',
                providerIncompleteReason: 'MAX_OUTPUT_TOKENS',
                usage: {
                  inputTokens: 100,
                  outputTokens: 20,
                  totalTokens: 120,
                  cacheReadTokens: 0,
                  cacheWriteTokens: 80,
                  reasoningTokens: 5,
                },
                attempts: 1,
                latencyMs: 250,
              },
              cause: new Error(sentinels.join(' ')),
            });
          },
        }),
      },
    );

    expect(exitCode).toBe(1);
    expect(calls).toBe(1);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1]!)).toMatchObject({
      status: 'FAILED',
      code: 'LIVE_EVAL_EXECUTION_FAILED',
      underlyingCode: 'INCOMPLETE_MODEL_OUTPUT',
      logicalCallSequence: 1,
      completedLogicalCalls: 0,
      providerCallAttempted: true,
      provider: 'OPENAI',
      configuredModel: 'gpt-5.6-luna',
      responseModel: 'gpt-5.6-luna-response-v1',
      providerResponseStatus: 'INCOMPLETE',
      providerIncompleteReason: 'MAX_OUTPUT_TOKENS',
      attempts: 1,
      latencyMs: 250,
      knownCumulativeProviderAttempts: 1,
      knownCumulativeEstimatedCostUsdMicros: 4,
      attemptAccountingComplete: true,
      reportProduced: false,
    });
    const stdout = lines.join('\n');
    for (const sentinel of sentinels) expect(stdout).not.toContain(sentinel);
  });

  it('preserves complete zero-attempt accounting through adapter, gateway and an active reservation when client initialization fails before fetch', async () => {
    const config = loadAiConfig(enabledEnvironment);
    const rawMessage =
      'RAW_PRE_FETCH_LIVE_RUNNER_SENTINEL sk-proj-pre-fetch-live private@example.test';
    const lines: string[] = [];
    const telemetryEvents: AiRunTelemetryEvent[] = [];
    const store = new RecordingAiRunStore();
    const persistentRecorder = new PersistentAiRunRecorder(store, 30);
    const recorder: AiRunRecorder = {
      async record(event) {
        telemetryEvents.push(event);
        await persistentRecorder.record(event);
      },
    };
    let fetchCalls = 0;
    let executorCalls = 0;
    const adapter = new OpenAiResponsesAdapter(
      config,
      (options) => {
        createOpenAiSdkClient({
          ...options,
          fetchImplementation: async () => {
            fetchCalls += 1;
            throw new Error('Controlled fetch must remain unreachable.');
          },
        });
        throw new Error(rawMessage);
      },
      (() => {
        const times = [100, 101];
        return () => times.shift() ?? 101;
      })(),
    );
    const gateway = new AiGateway(
      config,
      [adapter],
      recorder,
      () => '00000000-0000-4000-8000-000000000016',
      () => new Date('2026-08-25T12:00:00.000Z'),
    );
    const consoleSpies = [
      vi.spyOn(console, 'debug').mockImplementation(() => undefined),
      vi.spyOn(console, 'info').mockImplementation(() => undefined),
      vi.spyOn(console, 'warn').mockImplementation(() => undefined),
      vi.spyOn(console, 'error').mockImplementation(() => undefined),
    ];

    try {
      const exitCode = await runNarrativeQualityLiveEvalScript(
        enabledEnvironment,
        (line) => lines.push(line),
        {
          loadPriceSnapshot: () => configuredPriceSnapshot(config),
          createExecutor: async () => ({
            async call<TOutput>(descriptor: NarrativeLiveEvalCallDescriptor<TOutput>) {
              executorCalls += 1;
              return {
                result: await gateway.call(descriptor.request),
                auditSucceeded: true as const,
              };
            },
          }),
        },
      );

      expect(exitCode).toBe(1);
      expect(executorCalls).toBe(1);
      expect(fetchCalls).toBe(0);
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0]!)).toMatchObject({ status: 'PREFLIGHT_PASSED' });
      const safeFailure = JSON.parse(lines[1]!) as Record<string, unknown>;
      expect(safeFailure).toMatchObject({
        status: 'FAILED',
        code: 'LIVE_EVAL_EXECUTION_FAILED',
        underlyingCode: 'PROVIDER_ERROR',
        reportProduced: false,
        providerCallAttempted: false,
        attemptAccountingComplete: true,
        logicalCallSequence: 1,
        completedLogicalCalls: 0,
        provider: 'OPENAI',
        configuredModel: 'gpt-5.6-luna',
        attempts: 0,
        knownCumulativeProviderAttempts: 0,
        knownCumulativeEstimatedCostUsdMicros: 0,
      });
      for (const field of [
        'usage',
        'providerRequestId',
        'providerResponseId',
        'responseModel',
        'providerResponseStatus',
        'providerIncompleteReason',
        'report',
        'baselineManifest',
      ]) {
        expect(safeFailure).not.toHaveProperty(field);
      }
      expect(store.started).toHaveLength(1);
      expect(store.succeeded).toHaveLength(0);
      expect(store.failed).toHaveLength(1);
      expect(store.failed[0]?.update).toMatchObject({
        status: 'FAILED',
        providerCallAttempted: false,
        attempts: 0,
        refusal: { refused: false },
        errorCode: 'PROVIDER_ERROR',
      });
      for (const field of [
        'usage',
        'providerRequestId',
        'providerResponseId',
        'responseModel',
        'providerResponseStatus',
        'providerIncompleteReason',
      ]) {
        expect(store.failed[0]?.update).not.toHaveProperty(field);
      }
      expect(telemetryEvents).toHaveLength(2);
      expect(JSON.stringify(telemetryEvents)).not.toContain(rawMessage);
      expect(JSON.stringify(store)).not.toContain(rawMessage);
      expect(lines.join('\n')).not.toContain(rawMessage);
      for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of consoleSpies) spy.mockRestore();
    }
  });

  it.each([
    {
      name: 'live-eval opt-in',
      environment: { ...enabledEnvironment, AI_LIVE_EVAL_ENABLED: 'false' },
    },
    { name: 'gateway opt-in', environment: { ...enabledEnvironment, AI_ENABLED: 'false' } },
    {
      name: 'OpenAI credential',
      environment: { ...enabledEnvironment, OPENAI_API_KEY: undefined },
    },
    {
      name: 'Anthropic credential',
      environment: { ...enabledEnvironment, ANTHROPIC_API_KEY: undefined },
    },
  ])('requires $name before the live CLI creates an executor', async ({ environment }) => {
    const config = loadAiConfig(environment);
    const lines: string[] = [];
    let executorFactories = 0;

    const exitCode = await runNarrativeQualityLiveEvalScript(
      environment,
      (line) => lines.push(line),
      {
        loadPriceSnapshot: () => configuredPriceSnapshot(config),
        createExecutor: async () => {
          executorFactories += 1;
          return new SuccessfulOfflineExecutor();
        },
      },
    );

    expect(exitCode).toBe(1);
    expect(executorFactories).toBe(0);
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      {
        status: 'FAILED',
        code: 'LIVE_EVAL_BLOCKED',
        reportProduced: false,
        providerCallAttempted: false,
        attemptAccountingComplete: true,
      },
    ]);
  });
});

describe('versioned price catalog loader', () => {
  it('loads the exact checked-in verified API prices', () => {
    const snapshot = loadAiPriceSnapshot();
    expect(requireVerifiedAiPriceSnapshot(snapshot)).toEqual(snapshot);
    expect(snapshot).toEqual({
      schemaVersion: 'ai-price-snapshot-schema-v1',
      priceCatalogVersion: NARRATIVE_PRICE_CATALOG_VERSION,
      pricingVerifiedAt: '2026-08-21',
      currency: 'USD',
      tokenUnit: 1_000_000,
      models: [
        {
          provider: 'ANTHROPIC',
          model: 'claude-sonnet-5',
          inputUsdMicrosPerMillionTokens: 2_000_000,
          outputUsdMicrosPerMillionTokens: 10_000_000,
          cacheReadUsdMicrosPerMillionTokens: 200_000,
          cacheWriteUsdMicrosPerMillionTokens: 2_500_000,
          reasoningUsdMicrosPerMillionTokens: 10_000_000,
        },
        {
          provider: 'OPENAI',
          model: 'gpt-5.6-terra',
          inputUsdMicrosPerMillionTokens: 2_000_000,
          outputUsdMicrosPerMillionTokens: 12_000_000,
          cacheReadUsdMicrosPerMillionTokens: 200_000,
          cacheWriteUsdMicrosPerMillionTokens: 2_500_000,
          reasoningUsdMicrosPerMillionTokens: 12_000_000,
        },
        {
          provider: 'OPENAI',
          model: 'gpt-5.6-luna',
          inputUsdMicrosPerMillionTokens: 200_000,
          outputUsdMicrosPerMillionTokens: 1_200_000,
          cacheReadUsdMicrosPerMillionTokens: 20_000,
          cacheWriteUsdMicrosPerMillionTokens: 250_000,
          reasoningUsdMicrosPerMillionTokens: 1_200_000,
        },
      ],
    });
  });

  it('fails closed for an unreadable catalog', () => {
    expect(() =>
      loadAiPriceSnapshot(new URL('../../evals/prices/does-not-exist.json', import.meta.url)),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_EVAL_INPUT' }));
  });
});
