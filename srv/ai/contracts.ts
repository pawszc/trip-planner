import { createHash } from 'node:crypto';
import type { ZodType } from 'zod';

export enum AiProvider {
  OPENAI = 'OPENAI',
  ANTHROPIC = 'ANTHROPIC',
}

export enum AiTaskType {
  DECIDE = 'DECIDE',
  GENERATE = 'GENERATE',
  JUDGE = 'JUDGE',
  SMOKE = 'SMOKE',
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
  provider?: AiProvider;
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
  output: TOutput;
  provider: AiProvider;
  model: string;
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
  readonly model: string;
  call<TOutput>(request: StructuredAiRequest<TOutput>): Promise<AiCallResult<TOutput>>;
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
