import { createHash } from 'node:crypto';
import type { ZodType } from 'zod';

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

export interface StructuredAiRequest<TOutput> {
  taskType: AiTaskType;
  promptVersion: string;
  schemaVersion: string;
  schemaName: string;
  instructions: string;
  input: JsonValue;
  outputSchema: ZodType<TOutput>;
  maxOutputTokens?: number;
  /** Gateway-owned execution ID. A caller-supplied value is always overwritten by AiGateway. */
  aiRunId?: string;
  /** Optional safe association for future product calls; never contains trip input or prompt data. */
  planningRunId?: string;
}

export interface AiUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

export interface AiRefusalState {
  refused: boolean;
  category?: string;
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
