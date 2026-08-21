import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { AiProvider, type AiProvider as AiProviderType } from '../ai/contracts.ts';
import { NARRATIVE_PRICE_CATALOG_VERSION } from '../narratives/narrative-quality-versions.ts';
import { EvalContractError } from './dataset.ts';

export { NARRATIVE_PRICE_CATALOG_VERSION } from '../narratives/narrative-quality-versions.ts';

export const AI_PRICE_SNAPSHOT_SCHEMA_VERSION = 'ai-price-snapshot-schema-v1';
export const AI_PRICE_ARITHMETIC_VERSION = 'usd-micros-ceil-each-token-class-v1';
export const USD_MICROS_PER_USD = 1_000_000;
export const USD_MICROS_PER_CENT = 10_000;
export const TOKENS_PER_PRICE_UNIT = 1_000_000;

const nonNegativeSafeInteger = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const strictIsoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/u)
  .refine(
    (value) => {
      const parsed = new Date(`${value}T00:00:00.000Z`);
      return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
    },
    { message: 'Expected a real calendar date in YYYY-MM-DD format.' },
  );

const modelPriceSchema = z
  .object({
    provider: z.enum([AiProvider.OPENAI, AiProvider.ANTHROPIC]),
    model: z.string().trim().min(1).max(200),
    inputUsdMicrosPerMillionTokens: nonNegativeSafeInteger,
    outputUsdMicrosPerMillionTokens: nonNegativeSafeInteger,
    cacheReadUsdMicrosPerMillionTokens: nonNegativeSafeInteger,
    cacheWriteUsdMicrosPerMillionTokens: nonNegativeSafeInteger,
    reasoningUsdMicrosPerMillionTokens: nonNegativeSafeInteger,
  })
  .strict();

const priceSnapshotShape = {
  schemaVersion: z.literal(AI_PRICE_SNAPSHOT_SCHEMA_VERSION),
  priceCatalogVersion: z.literal(NARRATIVE_PRICE_CATALOG_VERSION),
  currency: z.literal('USD'),
  tokenUnit: z.literal(TOKENS_PER_PRICE_UNIT),
  models: z.array(modelPriceSchema),
} as const;

function rejectDuplicateProviderModels(
  snapshot: {
    readonly models: readonly {
      readonly provider: AiProviderType;
      readonly model: string;
    }[];
  },
  refinement: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  for (const [index, price] of snapshot.models.entries()) {
    const key = `${price.provider}:${price.model}`;
    if (seen.has(key)) {
      refinement.addIssue({
        code: 'custom',
        path: ['models', index],
        message: 'A price snapshot cannot duplicate a provider/model pair.',
      });
    }
    seen.add(key);
  }
}

/** Schema v1 remains compatible with snapshots created before verification metadata was added. */
export const aiPriceSnapshotSchema = z
  .object({ ...priceSnapshotShape, pricingVerifiedAt: strictIsoDate.optional() })
  .strict()
  .superRefine(rejectDuplicateProviderModels);

/** Strict preflight-only contract: live cost authorization always requires verified pricing. */
export const verifiedAiPriceSnapshotSchema = z
  .object({ ...priceSnapshotShape, pricingVerifiedAt: strictIsoDate })
  .strict()
  .superRefine(rejectDuplicateProviderModels);

export type AiModelPrice = z.infer<typeof modelPriceSchema>;
export type AiPriceSnapshot = z.infer<typeof aiPriceSnapshotSchema>;
export type VerifiedAiPriceSnapshot = z.infer<typeof verifiedAiPriceSnapshotSchema>;

export interface BillableTokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly reasoningTokens: number;
}

export interface CostEstimate {
  readonly arithmeticVersion: typeof AI_PRICE_ARITHMETIC_VERSION;
  readonly usdMicros: number;
  readonly usage: BillableTokenUsage;
}

export function parseAiPriceSnapshot(input: unknown): AiPriceSnapshot {
  const parsed = aiPriceSnapshotSchema.safeParse(input);
  if (!parsed.success) {
    throw new EvalContractError(
      'INVALID_EVAL_INPUT',
      'The AI price snapshot failed its strict local schema.',
    );
  }
  return deepFreeze(parsed.data);
}

export function requireVerifiedAiPriceSnapshot(input: unknown): VerifiedAiPriceSnapshot {
  const parsed = verifiedAiPriceSnapshotSchema.safeParse(input);
  if (!parsed.success) {
    throw new EvalContractError(
      'LIVE_EVAL_BLOCKED',
      'Live evaluation requires a strict price snapshot with a valid pricing verification date.',
    );
  }
  return deepFreeze(parsed.data);
}

export function loadAiPriceSnapshot(
  snapshotUrl: URL = new URL(
    '../../evals/prices/narrative-quality-price-catalog-v1.json',
    import.meta.url,
  ),
): AiPriceSnapshot {
  let input: unknown;
  try {
    input = JSON.parse(readFileSync(snapshotUrl, 'utf8')) as unknown;
  } catch {
    throw new EvalContractError('INVALID_EVAL_INPUT', 'The AI price snapshot is unreadable.');
  }
  return parseAiPriceSnapshot(input);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export function findModelPrice(
  snapshot: AiPriceSnapshot,
  provider: AiProviderType,
  configuredModel: string,
): AiModelPrice | undefined {
  return snapshot.models.find(
    (entry) => entry.provider === provider && entry.model === configuredModel,
  );
}

function assertTokenUsage(usage: BillableTokenUsage): void {
  for (const value of Object.values(usage)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new EvalContractError(
        'INVALID_EVAL_INPUT',
        'Token usage must contain non-negative safe integers.',
      );
    }
  }
  if (usage.cacheReadTokens + usage.cacheWriteTokens > usage.inputTokens) {
    throw new EvalContractError(
      'INVALID_EVAL_INPUT',
      'Cache token classes cannot exceed total input tokens.',
    );
  }
  if (usage.reasoningTokens > usage.outputTokens) {
    throw new EvalContractError(
      'INVALID_EVAL_INPUT',
      'Reasoning tokens cannot exceed total output tokens.',
    );
  }
}

function ceilTokenClassCost(tokens: number, rateUsdMicrosPerMillionTokens: number): bigint {
  if (tokens === 0 || rateUsdMicrosPerMillionTokens === 0) return 0n;
  const numerator = BigInt(tokens) * BigInt(rateUsdMicrosPerMillionTokens);
  return (numerator + BigInt(TOKENS_PER_PRICE_UNIT) - 1n) / BigInt(TOKENS_PER_PRICE_UNIT);
}

/**
 * Financial arithmetic is integer-only. Cache tokens are removed from regular input, reasoning
 * tokens are removed from regular output, and every independently priced class rounds up to one
 * USD micro. This intentionally yields a conservative reproducible estimate.
 */
export function estimateCallCostUsdMicros(
  price: AiModelPrice,
  usage: BillableTokenUsage,
): CostEstimate {
  assertTokenUsage(usage);
  const uncachedInputTokens = usage.inputTokens - usage.cacheReadTokens - usage.cacheWriteTokens;
  const nonReasoningOutputTokens = usage.outputTokens - usage.reasoningTokens;
  const usdMicros =
    ceilTokenClassCost(uncachedInputTokens, price.inputUsdMicrosPerMillionTokens) +
    ceilTokenClassCost(usage.cacheReadTokens, price.cacheReadUsdMicrosPerMillionTokens) +
    ceilTokenClassCost(usage.cacheWriteTokens, price.cacheWriteUsdMicrosPerMillionTokens) +
    ceilTokenClassCost(nonReasoningOutputTokens, price.outputUsdMicrosPerMillionTokens) +
    ceilTokenClassCost(usage.reasoningTokens, price.reasoningUsdMicrosPerMillionTokens);
  if (usdMicros > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new EvalContractError('INVALID_EVAL_INPUT', 'The estimated call cost is too large.');
  }
  return { arithmeticVersion: AI_PRICE_ARITHMETIC_VERSION, usdMicros: Number(usdMicros), usage };
}

export function sumUsdMicros(values: readonly number[]): number {
  const total = values.reduce((sum, value) => {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new EvalContractError(
        'INVALID_EVAL_INPUT',
        'USD micros must be non-negative safe integers.',
      );
    }
    return sum + BigInt(value);
  }, 0n);
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new EvalContractError('INVALID_EVAL_INPUT', 'The total estimated cost is too large.');
  }
  return Number(total);
}

export function formatUsdMicrosDecimal(usdMicros: number): string {
  if (!Number.isSafeInteger(usdMicros) || usdMicros < 0) {
    throw new EvalContractError(
      'INVALID_EVAL_INPUT',
      'USD micros must be a non-negative safe integer.',
    );
  }
  const micros = BigInt(usdMicros);
  const whole = micros / BigInt(USD_MICROS_PER_USD);
  const fraction = String(micros % BigInt(USD_MICROS_PER_USD)).padStart(6, '0');
  return `${whole}.${fraction}`;
}

export function formatUsdMicros(usdMicros: number): string {
  return `${formatUsdMicrosDecimal(usdMicros)} USD`;
}
