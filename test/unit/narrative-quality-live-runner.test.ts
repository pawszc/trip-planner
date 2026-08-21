import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadAiConfig, type AiConfig } from '../../srv/ai/config.ts';
import { AiTaskType, createInputFingerprint, type AiCallResult } from '../../srv/ai/contracts.ts';
import { AiError } from '../../srv/ai/errors.ts';
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
      emptyPrices: false,
    },
    {
      name: 'missing gateway opt-in',
      environment: { ...enabledEnvironment, AI_ENABLED: 'false' },
      emptyPrices: false,
    },
    {
      name: 'unknown model pricing',
      environment: enabledEnvironment,
      emptyPrices: true,
    },
    {
      name: 'logical-call cap below the frozen plan',
      environment: { ...enabledEnvironment, AI_LIVE_EVAL_MAX_LOGICAL_CALLS: '45' },
      emptyPrices: false,
    },
  ])('blocks $name before constructing the executor', async ({ environment, emptyPrices }) => {
    const config = loadAiConfig(environment);
    let factoryCalls = 0;
    const priceSnapshot = emptyPrices
      ? parseAiPriceSnapshot({
          schemaVersion: 'ai-price-snapshot-schema-v1',
          priceCatalogVersion: NARRATIVE_PRICE_CATALOG_VERSION,
          currency: 'USD',
          tokenUnit: 1_000_000,
          models: [],
        })
      : configuredPriceSnapshot(config);

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
        providerCallMayHaveOccurred: true,
        attemptAccountingComplete: false,
        caseId: 'P01',
        taskType: 'JUDGE',
        logicalCallSequence: 1,
        underlyingCode: 'PROVIDER_UNAVAILABLE',
      });
    }

    expect(completed).toBe(false);
    expect(calls).toBe(1);
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
      plannedLogicalCalls: 46,
      plannedMaximumAttempts: 46,
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

  it('emits one safe failure and never creates an executor when opt-in is missing', async () => {
    const environment = { ...enabledEnvironment, AI_LIVE_EVAL_ENABLED: 'false' };
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
        providerCallMayHaveOccurred: false,
        attemptAccountingComplete: true,
      },
    ]);
  });
});

describe('versioned price catalog loader', () => {
  it('loads the checked-in strict catalog without inventing model prices', () => {
    const snapshot = loadAiPriceSnapshot();
    expect(snapshot).toMatchObject({
      priceCatalogVersion: NARRATIVE_PRICE_CATALOG_VERSION,
      currency: 'USD',
      tokenUnit: 1_000_000,
      models: [],
    });
  });

  it('fails closed for an unreadable catalog', () => {
    expect(() =>
      loadAiPriceSnapshot(new URL('../../evals/prices/does-not-exist.json', import.meta.url)),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_EVAL_INPUT' }));
  });
});
