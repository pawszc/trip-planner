import type { AiConfig } from './config.ts';
import { AiTaskType, createInputFingerprint } from './contracts.ts';
import type {
  AiCallResult,
  AiProvider,
  StructuredAiAdapter,
  StructuredAiRequest,
} from './contracts.ts';
import { AiError } from './errors.ts';
import type { AiRunRecorder, AiRunTelemetryEvent } from './telemetry.ts';
import { NoopAiRunRecorder } from './telemetry.ts';

function configuredProvider(config: AiConfig, taskType: AiTaskType): AiProvider {
  return taskType === AiTaskType.GENERATE ? config.generateProvider : config.decideProvider;
}

export class AiGateway {
  private readonly adapters = new Map<AiProvider, StructuredAiAdapter>();

  constructor(
    private readonly config: AiConfig,
    adapters: readonly StructuredAiAdapter[],
    private readonly recorder: AiRunRecorder = new NoopAiRunRecorder(),
  ) {
    for (const adapter of adapters) {
      if (this.adapters.has(adapter.provider)) {
        throw new AiError('INVALID_AI_CONFIGURATION', 'AI adapter providers must be unique.', {
          provider: adapter.provider,
          details: { field: 'adapters' },
        });
      }
      this.adapters.set(adapter.provider, adapter);
    }
  }

  async call<TOutput>(request: StructuredAiRequest<TOutput>): Promise<AiCallResult<TOutput>> {
    const provider = request.provider ?? configuredProvider(this.config, request.taskType);
    const adapter = this.adapters.get(provider);

    if (!this.config.enabled) {
      throw new AiError('AI_DISABLED', 'AI calls are disabled by configuration.', {
        provider,
        ...(adapter === undefined ? {} : { model: adapter.model }),
        details: { field: 'AI_ENABLED' },
      });
    }

    if (adapter === undefined) {
      throw new AiError(
        'UNSUPPORTED_AI_PROVIDER',
        'No adapter is configured for the selected provider.',
        {
          provider,
        },
      );
    }

    const fingerprint = createInputFingerprint(request.input);

    const commonEvent = {
      provider,
      model: adapter.model,
      taskType: request.taskType,
      promptVersion: request.promptVersion,
      schemaVersion: request.schemaVersion,
      inputFingerprint: fingerprint,
    } as const;
    this.recorder.record({ ...commonEvent, status: 'STARTED' });

    try {
      const result = await adapter.call(request);
      if (result.provider !== provider) {
        throw new AiError('PROVIDER_ERROR', 'The selected adapter returned a different provider.', {
          provider,
          model: adapter.model,
        });
      }
      const successEvent: AiRunTelemetryEvent = {
        ...commonEvent,
        status: 'SUCCEEDED',
        latencyMs: result.latencyMs,
        attempts: result.attempts,
        usage: result.usage,
        refusal: result.refusal,
        ...(result.providerRequestId === undefined
          ? {}
          : { providerRequestId: result.providerRequestId }),
      };
      this.recorder.record(successEvent);
      return result;
    } catch (cause) {
      const error =
        cause instanceof AiError
          ? cause
          : new AiError('PROVIDER_ERROR', `${provider} failed to complete the request.`, {
              provider,
              model: adapter.model,
              cause,
            });
      this.recorder.record({
        ...commonEvent,
        status: 'FAILED',
        errorCode: error.code,
        ...(error.code === 'MODEL_REFUSAL' ? { refusal: { refused: true } } : {}),
      });
      throw error;
    }
  }
}
