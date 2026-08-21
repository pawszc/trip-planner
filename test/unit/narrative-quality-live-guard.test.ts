import { describe, expect, it } from 'vitest';
import { AiProvider } from '../../srv/ai/contracts.ts';
import {
  LIVE_EVAL_HARD_CAPS,
  LiveEvalBudgetGuard,
  preflightLiveEvaluation,
  readLiveEvalLimits,
  type LogicalCallBudget,
} from '../../srv/evals/live-guard.ts';
import {
  AI_PRICE_ARITHMETIC_VERSION,
  NARRATIVE_PRICE_CATALOG_VERSION,
  estimateCallCostUsdMicros,
  formatUsdMicros,
  parseAiPriceSnapshot,
  requireVerifiedAiPriceSnapshot,
  type AiModelPrice,
} from '../../srv/evals/price-snapshot.ts';

const modelPrice = Object.freeze({
  provider: AiProvider.OPENAI,
  model: 'judge-test-v1',
  inputUsdMicrosPerMillionTokens: 1_000_000,
  outputUsdMicrosPerMillionTokens: 2_000_000,
  cacheReadUsdMicrosPerMillionTokens: 500_000,
  cacheWriteUsdMicrosPerMillionTokens: 1_500_000,
  reasoningUsdMicrosPerMillionTokens: 3_000_000,
});

function priceSnapshot(price: AiModelPrice = modelPrice) {
  return {
    schemaVersion: 'ai-price-snapshot-schema-v1' as const,
    priceCatalogVersion: NARRATIVE_PRICE_CATALOG_VERSION,
    pricingVerifiedAt: '2026-08-21',
    currency: 'USD' as const,
    tokenUnit: 1_000_000 as const,
    models: [price],
  };
}

function callBudget(overrides: Partial<LogicalCallBudget> = {}): LogicalCallBudget {
  return {
    provider: AiProvider.OPENAI,
    configuredModel: 'judge-test-v1',
    maxAttempts: 2,
    maximumUsagePerAttempt: {
      inputTokens: 10,
      outputTokens: 7,
      cacheReadTokens: 2,
      cacheWriteTokens: 3,
      reasoningTokens: 2,
    },
    ...overrides,
  };
}

const enabledEnv = Object.freeze({ AI_LIVE_EVAL_ENABLED: 'true' });

describe('integer price snapshot arithmetic', () => {
  it('prices disjoint token classes in integer USD micros with conservative per-class ceilings', () => {
    const parsed = parseAiPriceSnapshot(priceSnapshot());
    const estimate = estimateCallCostUsdMicros(parsed.models[0]!, {
      inputTokens: 10,
      outputTokens: 7,
      cacheReadTokens: 2,
      cacheWriteTokens: 3,
      reasoningTokens: 2,
    });

    // 5 uncached input + 1 cache-read + 5 cache-write + 10 visible output + 6 reasoning.
    expect(estimate).toMatchObject({
      arithmeticVersion: AI_PRICE_ARITHMETIC_VERSION,
      usdMicros: 27,
    });
    expect(Object.isFrozen(parsed.models)).toBe(true);
    expect(Object.isFrozen(parsed.models[0])).toBe(true);
    expect(formatUsdMicros(3_000_000)).toBe('3.000000 USD');
  });

  it('rounds a non-zero sub-micro token class up and rejects overlapping usage classes', () => {
    expect(
      estimateCallCostUsdMicros(modelPrice, {
        inputTokens: 1,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
      }).usdMicros,
    ).toBe(1);
    expect(() =>
      estimateCallCostUsdMicros(modelPrice, {
        inputTokens: 1,
        outputTokens: 0,
        cacheReadTokens: 1,
        cacheWriteTokens: 1,
        reasoningTokens: 0,
      }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_EVAL_INPUT' }));
  });

  it('rejects duplicate provider/model prices and non-integer rates', () => {
    expect(() =>
      parseAiPriceSnapshot({
        ...priceSnapshot(),
        models: [modelPrice, modelPrice],
      }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_EVAL_INPUT' }));
    expect(() =>
      parseAiPriceSnapshot({
        ...priceSnapshot(),
        models: [{ ...modelPrice, inputUsdMicrosPerMillionTokens: 0.5 }],
      }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_EVAL_INPUT' }));
  });

  it('keeps legacy v1 compatible while the verified preflight contract requires a valid date', () => {
    const withoutVerificationDate: Record<string, unknown> = { ...priceSnapshot() };
    delete withoutVerificationDate.pricingVerifiedAt;
    const legacySnapshot = parseAiPriceSnapshot(withoutVerificationDate);
    expect(legacySnapshot.pricingVerifiedAt).toBeUndefined();
    expect(() => requireVerifiedAiPriceSnapshot(legacySnapshot)).toThrowError(
      expect.objectContaining({ code: 'LIVE_EVAL_BLOCKED' }),
    );
    expect(() =>
      parseAiPriceSnapshot({ ...priceSnapshot(), pricingVerifiedAt: '2026-02-30' }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_EVAL_INPUT' }));
    expect(() =>
      requireVerifiedAiPriceSnapshot({ ...priceSnapshot(), pricingVerifiedAt: '2026-02-30' }),
    ).toThrowError(expect.objectContaining({ code: 'LIVE_EVAL_BLOCKED' }));
    expect(requireVerifiedAiPriceSnapshot(priceSnapshot()).pricingVerifiedAt).toBe('2026-08-21');
    expect(() =>
      parseAiPriceSnapshot({ ...priceSnapshot(), pricingValidThrough: '2026-08-31' }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_EVAL_INPUT' }));
  });
});

describe('live eval preflight and stop-before-next-call guard', () => {
  it.each([undefined, 'false'])('is disabled by default or explicit false (%s)', (enabled) => {
    expect(() =>
      preflightLiveEvaluation({
        env: { AI_LIVE_EVAL_ENABLED: enabled },
        aiEnabled: true,
        credentialsConfigured: true,
        priceSnapshot: priceSnapshot(),
        plannedCalls: [callBudget()],
      }),
    ).toThrowError(expect.objectContaining({ code: 'LIVE_EVAL_BLOCKED' }));
  });

  it('requires exact opt-in syntax, the gateway opt-in and configured credentials', () => {
    const base = {
      env: enabledEnv,
      aiEnabled: true,
      credentialsConfigured: true,
      priceSnapshot: priceSnapshot(),
      plannedCalls: [callBudget()],
    };
    expect(() =>
      preflightLiveEvaluation({ ...base, env: { AI_LIVE_EVAL_ENABLED: 'TRUE' } }),
    ).toThrow();
    expect(() => preflightLiveEvaluation({ ...base, aiEnabled: false })).toThrow();
    expect(() => preflightLiveEvaluation({ ...base, credentialsConfigured: false })).toThrow();
  });

  it('accepts the exact 48 logical / 56 attempt phase boundary', () => {
    const plannedCalls = Array.from({ length: 48 }, (_, index) =>
      callBudget({ maxAttempts: index < 8 ? 2 : 1 }),
    );
    const preflight = preflightLiveEvaluation({
      env: enabledEnv,
      aiEnabled: true,
      credentialsConfigured: true,
      priceSnapshot: priceSnapshot(),
      plannedCalls,
    });

    expect(preflight.plannedLogicalCalls).toBe(48);
    expect(preflight.plannedMaximumAttempts).toBe(56);
    expect(preflight.limits).toEqual({
      maxLogicalCalls: LIVE_EVAL_HARD_CAPS.logicalCalls,
      maxProviderAttempts: LIVE_EVAL_HARD_CAPS.providerAttempts,
      maxEstimatedCostUsdMicros: LIVE_EVAL_HARD_CAPS.estimatedCostUsdMicros,
    });
  });

  it('accepts exactly USD 3.00 and blocks one micro above before the first call', () => {
    const exactPrice = {
      ...modelPrice,
      inputUsdMicrosPerMillionTokens: 3_000_000,
      outputUsdMicrosPerMillionTokens: 0,
      cacheReadUsdMicrosPerMillionTokens: 0,
      cacheWriteUsdMicrosPerMillionTokens: 0,
      reasoningUsdMicrosPerMillionTokens: 0,
    };
    const exactCall = callBudget({
      maxAttempts: 1,
      maximumUsagePerAttempt: {
        inputTokens: 1_000_000,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
      },
    });
    expect(
      preflightLiveEvaluation({
        env: enabledEnv,
        aiEnabled: true,
        credentialsConfigured: true,
        priceSnapshot: priceSnapshot(exactPrice),
        plannedCalls: [exactCall],
      }).plannedMaximumCostUsdMicros,
    ).toBe(3_000_000);

    expect(() =>
      preflightLiveEvaluation({
        env: enabledEnv,
        aiEnabled: true,
        credentialsConfigured: true,
        priceSnapshot: priceSnapshot({
          ...exactPrice,
          inputUsdMicrosPerMillionTokens: 3_000_001,
        }),
        plannedCalls: [exactCall],
      }),
    ).toThrowError(expect.objectContaining({ code: 'LIVE_EVAL_BLOCKED' }));
  });

  it('blocks unknown pricing and any configured cap above the immutable hard maximum', () => {
    expect(() =>
      preflightLiveEvaluation({
        env: enabledEnv,
        aiEnabled: true,
        credentialsConfigured: true,
        priceSnapshot: { ...priceSnapshot(), models: [] },
        plannedCalls: [callBudget()],
      }),
    ).toThrowError(expect.objectContaining({ code: 'LIVE_EVAL_BLOCKED' }));
    expect(() => readLiveEvalLimits({ AI_LIVE_EVAL_MAX_LOGICAL_CALLS: '49' })).toThrowError(
      expect.objectContaining({ code: 'LIVE_EVAL_BLOCKED' }),
    );
    expect(() => readLiveEvalLimits({ AI_LIVE_EVAL_MAX_PROVIDER_ATTEMPTS: '57' })).toThrowError(
      expect.objectContaining({ code: 'LIVE_EVAL_BLOCKED' }),
    );
    expect(() =>
      readLiveEvalLimits({ AI_LIVE_EVAL_MAX_ESTIMATED_COST_USD_CENTS: '301' }),
    ).toThrowError(expect.objectContaining({ code: 'LIVE_EVAL_BLOCKED' }));
  });

  it('blocks a legacy v1 snapshot without verification metadata at the production preflight', () => {
    const legacyInput: Record<string, unknown> = { ...priceSnapshot() };
    delete legacyInput.pricingVerifiedAt;
    const legacySnapshot = parseAiPriceSnapshot(legacyInput);

    expect(() =>
      preflightLiveEvaluation({
        env: enabledEnv,
        aiEnabled: true,
        credentialsConfigured: true,
        priceSnapshot: legacySnapshot,
        plannedCalls: [callBudget()],
      }),
    ).toThrowError(expect.objectContaining({ code: 'LIVE_EVAL_BLOCKED' }));
  });

  it('reserves worst-case attempts/cost and stops before a third configured logical call', () => {
    const call = callBudget();
    const preflight = preflightLiveEvaluation({
      env: {
        AI_LIVE_EVAL_ENABLED: 'true',
        AI_LIVE_EVAL_MAX_LOGICAL_CALLS: '2',
        AI_LIVE_EVAL_MAX_PROVIDER_ATTEMPTS: '4',
        AI_LIVE_EVAL_MAX_ESTIMATED_COST_USD_CENTS: '1',
      },
      aiEnabled: true,
      credentialsConfigured: true,
      priceSnapshot: priceSnapshot(),
      plannedCalls: [call, call],
    });
    const guard = new LiveEvalBudgetGuard(preflight);
    const first = guard.authorizeNextCall(call);
    expect(() => guard.authorizeNextCall(call)).toThrowError(
      expect.objectContaining({ code: 'LIVE_EVAL_BLOCKED' }),
    );
    guard.settleCall({ reservation: first, attempts: 1, attemptUsages: [] });
    const second = guard.authorizeNextCall(call);
    const settled = guard.settleCall({
      reservation: second,
      attempts: 2,
      attemptUsages: [call.maximumUsagePerAttempt],
    });
    expect(settled).toMatchObject({
      logicalCallsStarted: 2,
      providerAttemptsCompleted: 3,
      activeReservation: false,
    });
    expect(settled.estimatedCostUsdMicros).toBeGreaterThan(0);
    expect(() => guard.authorizeNextCall(call)).toThrowError(
      expect.objectContaining({ code: 'LIVE_EVAL_BLOCKED' }),
    );
  });

  it('fails closed when actual usage exceeds the pre-call reservation', () => {
    const call = callBudget({ maxAttempts: 1 });
    const preflight = preflightLiveEvaluation({
      env: enabledEnv,
      aiEnabled: true,
      credentialsConfigured: true,
      priceSnapshot: priceSnapshot(),
      plannedCalls: [call],
    });
    const guard = new LiveEvalBudgetGuard(preflight);
    const reservation = guard.authorizeNextCall(call);

    expect(() =>
      guard.settleCall({
        reservation,
        attempts: 1,
        attemptUsages: [{ ...call.maximumUsagePerAttempt, outputTokens: 8 }],
      }),
    ).toThrowError(expect.objectContaining({ code: 'LIVE_EVAL_BLOCKED' }));
  });
});
