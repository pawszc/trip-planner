import { createHash } from 'node:crypto';
import type { ZodType } from 'zod';
import type { AiValidationFailureStage } from './failure-execution-evidence.ts';

export const AiProvider = Object.freeze({
  OPENAI: 'OPENAI',
  ANTHROPIC: 'ANTHROPIC',
} as const);
export type AiProvider = (typeof AiProvider)[keyof typeof AiProvider];

export const AiTaskType = Object.freeze({
  DECIDE: 'DECIDE',
  GENERATE: 'GENERATE',
  JUDGE: 'JUDGE',
  SMOKE: 'SMOKE',
} as const);
export type AiTaskType = (typeof AiTaskType)[keyof typeof AiTaskType];

export type ProfiledAiTaskType = Exclude<AiTaskType, (typeof AiTaskType)['SMOKE']>;

export type AiEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface AiExecutionProfile {
  taskType: AiTaskType;
  provider: AiProvider;
  model: string;
  effort: AiEffort;
  maxOutputTokens: number;
}

export type JsonPrimitive = string | number | boolean | null;
export type JsonObject = { readonly [key: string]: JsonValue };
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];

export type StructuredAiOutputValidationFailureStage = Exclude<
  AiValidationFailureStage,
  'SCHEMA_CONSTRUCTION' | 'RESPONSE_JSON_PARSE'
>;

export type StructuredAiOutputValidationResult<TOutput> =
  | {
      readonly success: true;
      readonly output: TOutput;
    }
  | {
      readonly success: false;
      readonly validationFailureStage: StructuredAiOutputValidationFailureStage;
    };

export interface StructuredAiRequest<TOutput> {
  taskType: AiTaskType;
  promptVersion: string;
  schemaVersion: string;
  schemaName: string;
  instructions: string;
  input: JsonValue;
  /**
   * Full local output contract. The gateway revalidates adapter results with this schema so a
   * custom adapter cannot bypass the product contract.
   */
  outputSchema: ZodType<TOutput>;
  /**
   * Optional provider-visible transport contract. It may contain only constraints representable
   * by the provider's strict JSON Schema subset. Legacy requests fall back to outputSchema.
   */
  providerOutputSchema?: ZodType;
  /**
   * Optional staged local validator for context-dependent or cross-field invariants. It returns
   * only a controlled stage on failure and never exposes parser issues or rejected values.
   */
  validateOutput?: (
    output: unknown,
    requestInput: JsonValue,
  ) => StructuredAiOutputValidationResult<TOutput>;
  /**
   * Optional request-local classifier for an adapter result that is already transport-parsed and
   * locally bound. The gateway uses it to preserve controlled semantic stages without exposing the
   * rejected output or request input in evidence.
   */
  validateBoundOutput?: (
    output: unknown,
    requestInput: JsonValue,
  ) => StructuredAiOutputValidationResult<TOutput>;
  maxOutputTokens?: number;
  /** Gateway-owned execution ID. A caller-supplied value is always overwritten by AiGateway. */
  aiRunId?: string;
  /** Optional safe association for future product calls; never contains trip input or prompt data. */
  planningRunId?: string;
  /** Optional safe narrative subject association for privacy-safe operational telemetry only. */
  rankedOptionId?: string;
}

export function resolveStructuredAiProviderOutputSchema<TOutput>(
  request: StructuredAiRequest<TOutput>,
): ZodType {
  return request.providerOutputSchema ?? request.outputSchema;
}

export function validateStructuredAiOutput<TOutput>(
  request: StructuredAiRequest<TOutput>,
  output: unknown,
): StructuredAiOutputValidationResult<TOutput> {
  if (request.providerOutputSchema === undefined) {
    const local = request.outputSchema.safeParse(output);
    if (!local.success) {
      return { success: false, validationFailureStage: 'TRANSPORT_SCHEMA_VALIDATION' };
    }
    const staged = request.validateOutput?.(local.data, request.input);
    return staged === undefined || staged.success ? { success: true, output: local.data } : staged;
  }
  const transport = resolveStructuredAiProviderOutputSchema(request).safeParse(output);
  if (!transport.success) {
    return { success: false, validationFailureStage: 'TRANSPORT_SCHEMA_VALIDATION' };
  }
  const staged = request.validateOutput?.(transport.data, request.input) ?? {
    success: true as const,
    output: transport.data,
  };
  if (!staged.success) return staged;
  // The full local contract remains the final backstop after explicit transport and binding
  // phases. A staged validator can classify stricter invariants but cannot bypass this schema.
  const local = request.outputSchema.safeParse(staged.output);
  return local.success
    ? { success: true, output: local.data }
    : { success: false, validationFailureStage: 'TRANSPORT_SCHEMA_VALIDATION' };
}

/**
 * Revalidates an adapter result that has already crossed the provider transport boundary and been
 * locally bound. Keeping this separate prevents a provider payload from bypassing its findings-only
 * (or blocks-only) schema while allowing the gateway to enforce the full final output contract.
 */
export function validateBoundStructuredAiOutput<TOutput>(
  request: StructuredAiRequest<TOutput>,
  output: unknown,
): StructuredAiOutputValidationResult<TOutput> {
  const staged = request.validateBoundOutput?.(output, request.input);
  if (staged !== undefined && !staged.success) return staged;
  const local = request.outputSchema.safeParse(staged === undefined ? output : staged.output);
  return local.success
    ? { success: true, output: local.data }
    : { success: false, validationFailureStage: 'TRANSPORT_SCHEMA_VALIDATION' };
}

export interface AiUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

export const AI_REFUSAL_CATEGORY_VALUES = ['content_filter', 'model_refusal', 'unknown'] as const;

export type AiRefusalCategory = (typeof AI_REFUSAL_CATEGORY_VALUES)[number];

export interface AiRefusalState {
  refused: boolean;
  category?: AiRefusalCategory;
}

export interface AiCallResult<TOutput> {
  aiRunId: string;
  output: TOutput;
  provider: AiProvider;
  configuredModel: string;
  responseModel: string;
  taskType: AiTaskType;
  promptVersion: string;
  schemaVersion: string;
  inputFingerprint: string;
  usage: AiUsage;
  latencyMs: number;
  providerRequestId?: string;
  providerResponseId?: string;
  attempts: number;
  refusal: AiRefusalState;
}

export interface StructuredAiAdapter {
  readonly provider: AiProvider;
  call<TOutput>(
    request: StructuredAiRequest<TOutput>,
    profile: AiExecutionProfile,
  ): Promise<AiCallResult<TOutput>>;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isValidAiRunId(value: string): boolean {
  return UUID_PATTERN.test(value);
}

function serializeJson(value: JsonValue, seen: WeakSet<object>): string {
  if (value === null) {
    return 'null';
  }

  if (typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('AI input may contain only finite JSON numbers.');
    }
    return JSON.stringify(value);
  }

  if (seen.has(value)) {
    throw new TypeError('AI input must not contain circular references.');
  }
  seen.add(value);

  let serialized: string;
  if (isJsonArray(value)) {
    serialized = `[${value.map((item) => serializeJson(item, seen)).join(',')}]`;
  } else {
    const fields = Object.keys(value)
      .sort()
      .map((key) => {
        const fieldValue = value[key];
        if (fieldValue === undefined) {
          throw new TypeError(`AI input field ${key} is not JSON-serializable.`);
        }
        return `${JSON.stringify(key)}:${serializeJson(fieldValue, seen)}`;
      });
    serialized = `{${fields.join(',')}}`;
  }

  seen.delete(value);
  return serialized;
}

function isJsonArray(value: JsonValue): value is readonly JsonValue[] {
  return Array.isArray(value);
}

/** Canonical JSON preserves array order and sorts every object key recursively. */
export function canonicalizeJson(value: JsonValue): string {
  return serializeJson(value, new WeakSet<object>());
}

/** Stable SHA-256 identifier; raw grounded input is not included in telemetry. */
export function createInputFingerprint(value: JsonValue): string {
  return createHash('sha256').update(canonicalizeJson(value), 'utf8').digest('hex');
}
