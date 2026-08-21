import type { AiConfig } from './config.ts';
import type { StructuredAiAdapter } from './contracts.ts';
import { AnthropicMessagesAdapter } from './adapters/anthropic-messages-adapter.ts';
import { OpenAiResponsesAdapter } from './adapters/openai-responses-adapter.ts';
import { AiGateway } from './ai-gateway.ts';
import { CapAiRunStore } from './persistence/cap-ai-run-store.ts';
import type { AiRunStore } from './persistence/ai-run-store.ts';
import { PersistentAiRunRecorder } from './persistence/persistent-ai-run-recorder.ts';
import { ConsoleAiOperationalSignalSink, type AiOperationalSignalSink } from './telemetry.ts';

export interface PersistentAiGatewayDependencies {
  /** Test seam; production composition creates both official SDK adapters. */
  adapters?: readonly StructuredAiAdapter[];
  /** Test seam; production composition uses the internal CAP-backed AiRuns store. */
  store?: AiRunStore;
  generateAiRunId?: () => string;
  now?: () => Date;
  /** Test/operations seam independent from the AiRuns persistence path. */
  operationalSignalSink?: AiOperationalSignalSink;
}

/**
 * Explicit production composition root for persistent, fail-closed AI execution.
 * Construction is side-effect free: no environment reads, database writes or SDK requests.
 */
export function createPersistentAiGateway(
  config: AiConfig,
  dependencies: PersistentAiGatewayDependencies = {},
): AiGateway {
  const adapters = dependencies.adapters ?? [
    new OpenAiResponsesAdapter(config),
    new AnthropicMessagesAdapter(config),
  ];
  const store = dependencies.store ?? new CapAiRunStore();
  const recorder = new PersistentAiRunRecorder(store, config.runRetentionDays);
  const operationalSignalSink =
    dependencies.operationalSignalSink ?? new ConsoleAiOperationalSignalSink();

  return new AiGateway(
    config,
    adapters,
    recorder,
    dependencies.generateAiRunId,
    dependencies.now,
    operationalSignalSink,
  );
}
