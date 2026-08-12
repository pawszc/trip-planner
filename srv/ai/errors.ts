import type { AiProvider } from './contracts.ts';
import { redactSensitiveData } from './redaction.ts';

export const AI_ERROR_CODE_VALUES = [
  'AI_DISABLED',
  'LIVE_AI_NOT_ENABLED',
  'MISSING_CREDENTIALS',
  'INVALID_AI_CONFIGURATION',
  'UNSUPPORTED_AI_PROVIDER',
  'AUTHENTICATION_FAILED',
  'MODEL_ACCESS_DENIED',
  'RATE_LIMITED',
  'AI_TIMEOUT',
  'PROVIDER_UNAVAILABLE',
  'PROVIDER_ERROR',
  'MODEL_REFUSAL',
  'EMPTY_MODEL_OUTPUT',
  'INVALID_STRUCTURED_OUTPUT',
] as const;

export type AiErrorCode = (typeof AI_ERROR_CODE_VALUES)[number];
export type AiErrorDetailValue = string | number | boolean | null;
export type AiErrorDetails = Readonly<Record<string, AiErrorDetailValue>>;

export interface AiErrorOptions {
  provider?: AiProvider;
  model?: string;
  retryable?: boolean;
  details?: AiErrorDetails;
  cause?: unknown;
}

export interface SafeAiError {
  name: 'AiError';
  code: AiErrorCode;
  message: string;
  retryable: boolean;
  details: AiErrorDetails;
  provider?: AiProvider;
  model?: string;
}

/** Domain-safe AI failure. The original cause stays non-enumerable on Error. */
export class AiError extends Error {
  public readonly code: AiErrorCode;
  public readonly provider?: AiProvider;
  public readonly model?: string;
  public readonly retryable: boolean;
  public readonly details: AiErrorDetails;

  constructor(code: AiErrorCode, message: string, options: AiErrorOptions = {}) {
    const redactedMessage = redactSensitiveData(message);
    super(
      typeof redactedMessage === 'string' ? redactedMessage : 'AI request failed safely.',
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = 'AiError';
    this.code = code;
    this.retryable = options.retryable ?? false;
    const redactedDetails = redactSensitiveData(options.details ?? {});
    const safeDetails: Record<string, AiErrorDetailValue> = {};
    if (typeof redactedDetails === 'object' && redactedDetails !== null) {
      for (const [key, value] of Object.entries(redactedDetails)) {
        if (
          typeof value === 'string' ||
          typeof value === 'number' ||
          typeof value === 'boolean' ||
          value === null
        ) {
          safeDetails[key] = value;
        }
      }
    }
    this.details = Object.freeze(safeDetails);
    if (options.provider !== undefined) {
      this.provider = options.provider;
    }
    if (options.model !== undefined) {
      this.model = options.model;
    }
  }

  toSafeJSON(): SafeAiError {
    return {
      name: 'AiError',
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      details: this.details,
      ...(this.provider === undefined ? {} : { provider: this.provider }),
      ...(this.model === undefined ? {} : { model: this.model }),
    };
  }

  override toString(): string {
    return `${this.name} [${this.code}]: ${this.message}`;
  }
}

export interface ProviderFailureMetadata {
  status?: number;
  providerCode?: string;
  isTimeout?: boolean;
  isConnectionError?: boolean;
  isModelAccessError?: boolean;
  isQuotaError?: boolean;
}

export interface ProviderFailureContext {
  provider: AiProvider;
  model: string;
  modelEnvironmentVariable: string;
  metadata: ProviderFailureMetadata;
  cause: unknown;
}

function baseDetails(context: ProviderFailureContext): AiErrorDetails {
  return {
    modelEnvironmentVariable: context.modelEnvironmentVariable,
    configuredModel: context.model,
    ...(context.metadata.status === undefined ? {} : { status: context.metadata.status }),
    ...(context.metadata.providerCode === undefined
      ? {}
      : { providerCode: context.metadata.providerCode }),
  };
}

export function normalizeProviderFailure(context: ProviderFailureContext): AiError {
  const { metadata, provider, model, cause } = context;
  const options = (codeDetails: AiErrorDetails, retryable = false): AiErrorOptions => ({
    provider,
    model,
    retryable,
    details: codeDetails,
    cause,
  });

  if (metadata.status === 401) {
    return new AiError(
      'AUTHENTICATION_FAILED',
      `${provider} rejected the configured credentials.`,
      options(baseDetails(context)),
    );
  }

  if (metadata.status === 403 || metadata.status === 404 || metadata.isModelAccessError === true) {
    return new AiError(
      'MODEL_ACCESS_DENIED',
      `${provider} did not allow access to the configured model.`,
      options({
        ...baseDetails(context),
        nextStep: `Change only ${context.modelEnvironmentVariable} in the local .env to a model available on this account.`,
      }),
    );
  }

  if (metadata.status === 429) {
    return new AiError(
      'RATE_LIMITED',
      `${provider} rate-limited the request.`,
      options({ ...baseDetails(context), quotaRelated: metadata.isQuotaError === true }, true),
    );
  }

  if (metadata.isTimeout === true) {
    return new AiError(
      'AI_TIMEOUT',
      `${provider} did not complete the request within the configured timeout.`,
      options(baseDetails(context), true),
    );
  }

  if (metadata.isConnectionError === true || (metadata.status ?? 0) >= 500) {
    return new AiError(
      'PROVIDER_UNAVAILABLE',
      `${provider} is temporarily unavailable.`,
      options(baseDetails(context), true),
    );
  }

  return new AiError(
    'PROVIDER_ERROR',
    `${provider} failed to complete the request.`,
    options(baseDetails(context)),
  );
}

export function createMissingCredentialsError(
  provider: AiProvider,
  model: string,
  credentialEnvironmentVariable: string,
): AiError {
  return new AiError('MISSING_CREDENTIALS', `${provider} credentials are not configured.`, {
    provider,
    model,
    details: { credentialEnvironmentVariable },
  });
}
