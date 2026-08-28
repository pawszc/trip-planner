import type { TransportOption } from '../../domain/candidate.ts';
import { SOURCE_SNAPSHOT_CONTRACT_VERSION } from '../../domain/money.ts';
import type { TransportProvider, TransportSearchRequest } from '../contracts.ts';
import { ProviderExecutionError, providerFailureFromHttpMetadata } from '../provider-errors.ts';
import type { ProviderCallOptions } from '../provider-execution.ts';
import { ProviderHttpClientError, type ProviderHttpClient } from '../http/provider-http-client.ts';
import { transportResultView } from '../normalized-result.ts';
import { createProviderFingerprint, type ProviderJsonValue } from '../provider-fingerprint.ts';
import type { ProviderManifestEntry } from '../provider-manifest.ts';
import {
  DUFFEL_ADAPTER_ID,
  DUFFEL_ADAPTER_VERSION,
  DUFFEL_API_VERSION,
  DUFFEL_MAX_OFFERS_PER_DESTINATION,
  DUFFEL_SEARCH_POLICY_VERSION,
  DUFFEL_UPSTREAM_SCHEMA_VERSION,
  type DuffelEnvironment,
  type DuffelOffer,
} from './duffel-contracts.ts';
import { duffelOfferSemanticFingerprint, mapDuffelOffer } from './duffel-mapper.ts';
import { buildDuffelOfferRequestPlans, resolveDuffelOriginIata } from './duffel-search-policy.ts';
import {
  DUFFEL_UPSTREAM_SCHEMA_FINGERPRINT,
  duffelOfferRequestResponseSchema,
} from './duffel-schemas.ts';

export interface DuffelApiTransportProviderOptions {
  readonly environment: DuffelEnvironment;
  readonly httpClient: ProviderHttpClient;
  readonly manifestEntry: ProviderManifestEntry;
  readonly clock?: () => Date;
  readonly maxOffersPerDestination?: number;
}

function safeProviderFailure(
  category: 'INVALID_SCHEMA' | 'NETWORK',
  destinationCode: string,
): ProviderExecutionError {
  return new ProviderExecutionError({
    category,
    providerKey: 'duffel-flights',
    operation: 'TRANSPORT_SEARCH',
    callSequence: 0,
    providerCallAttempted: true,
    destinationCode,
  });
}

function stableOffers(
  offers: readonly {
    readonly option: TransportOption;
    readonly upstreamOffer: DuffelOffer;
  }[],
  maximum: number,
): readonly TransportOption[] {
  const ordered = [...offers].sort(
    (left, right) =>
      (left.option.pricing.mandatoryTotal.amountMinor ?? Number.POSITIVE_INFINITY) -
        (right.option.pricing.mandatoryTotal.amountMinor ?? Number.POSITIVE_INFINITY) ||
      left.option.outbound.departureAt.localeCompare(right.option.outbound.departureAt, 'en') ||
      left.option.id.localeCompare(right.option.id, 'en'),
  );
  const unique = new Map<string, TransportOption>();
  for (const { option, upstreamOffer } of ordered) {
    const fingerprint = duffelOfferSemanticFingerprint(upstreamOffer, option);
    if (!unique.has(fingerprint)) unique.set(fingerprint, option);
  }
  return Object.freeze([...unique.values()].slice(0, maximum));
}

export function createDuffelTransportManifestEntry(
  environment: DuffelEnvironment,
): ProviderManifestEntry {
  return Object.freeze({
    role: 'TRANSPORT',
    mode: 'LIVE',
    providerKey: 'duffel-flights',
    providerName: 'Duffel',
    providerVersion: `duffel-${environment.toLowerCase()}-offers-v2`,
    adapterId: DUFFEL_ADAPTER_ID,
    adapterVersion: DUFFEL_ADAPTER_VERSION,
    sourceContractVersion: SOURCE_SNAPSHOT_CONTRACT_VERSION,
    searchPolicyVersion: DUFFEL_SEARCH_POLICY_VERSION,
    fixtureVersion: null,
    upstreamApiVersion: DUFFEL_API_VERSION,
    upstreamSchemaVersion: DUFFEL_UPSTREAM_SCHEMA_VERSION,
    upstreamSchemaFingerprint: DUFFEL_UPSTREAM_SCHEMA_FINGERPRINT,
  });
}

function hasExactDuffelManifestIdentity(
  entry: ProviderManifestEntry,
  environment: DuffelEnvironment,
): boolean {
  try {
    return (
      createProviderFingerprint(entry as unknown as ProviderJsonValue) ===
      createProviderFingerprint(
        createDuffelTransportManifestEntry(environment) as unknown as ProviderJsonValue,
      )
    );
  } catch {
    return false;
  }
}

export class DuffelApiTransportProvider implements TransportProvider {
  public readonly manifestEntry: ProviderManifestEntry;
  private readonly environment: DuffelEnvironment;
  private readonly httpClient: ProviderHttpClient;
  private readonly clock: () => Date;
  private readonly maxOffersPerDestination: number;

  constructor(options: DuffelApiTransportProviderOptions) {
    if (!hasExactDuffelManifestIdentity(options.manifestEntry, options.environment)) {
      throw new TypeError('Duffel adapter manifest identity does not match its environment.');
    }
    const maximum = options.maxOffersPerDestination ?? DUFFEL_MAX_OFFERS_PER_DESTINATION;
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 6) {
      throw new TypeError('Duffel result limit is outside Search Policy v1.');
    }
    this.environment = options.environment;
    this.httpClient = options.httpClient;
    this.manifestEntry = options.manifestEntry;
    this.clock = options.clock ?? (() => new Date());
    this.maxOffersPerDestination = maximum;
  }

  public async search(
    request: TransportSearchRequest,
    options?: ProviderCallOptions,
  ): Promise<readonly TransportOption[]> {
    if (options === undefined) {
      throw new TypeError('Duffel adapter requires the run-scoped upstream executor.');
    }
    const originCode = resolveDuffelOriginIata(request.originCity);
    const plans = buildDuffelOfferRequestPlans(request);
    if (originCode === null) throw new TypeError('Duffel origin is unsupported.');

    const groups = await Promise.all(
      plans.map((plan) =>
        options.executeUpstream<readonly TransportOption[]>(
          {
            destinationCode: plan.destination.code,
            queryFingerprint: plan.queryFingerprint,
            resultFingerprint: (result) =>
              createProviderFingerprint(result.map((offer) => transportResultView(offer))),
            resultCount: (result) => result.length,
          },
          async ({ signal }) => {
            let unknownResponse: unknown;
            try {
              unknownResponse = await this.httpClient.postJson(plan.path, plan.body, signal);
            } catch (error) {
              if (error instanceof ProviderHttpClientError) {
                if (error.kind === 'HTTP_STATUS') {
                  throw providerFailureFromHttpMetadata({
                    providerKey: 'duffel-flights',
                    operation: 'TRANSPORT_SEARCH',
                    callSequence: 0,
                    providerCallAttempted: true,
                    destinationCode: plan.destination.code,
                    ...(error.status === null ? {} : { status: error.status }),
                    rateLimit: { retryAfterMs: error.retryAfterMs },
                  });
                }
                if (error.kind === 'INVALID_JSON') {
                  throw safeProviderFailure('INVALID_SCHEMA', plan.destination.code);
                }
              }
              throw error;
            }

            const parsed = duffelOfferRequestResponseSchema.safeParse(unknownResponse);
            if (!parsed.success || parsed.data.data.live_mode !== (this.environment === 'LIVE')) {
              throw safeProviderFailure('INVALID_SCHEMA', plan.destination.code);
            }
            const fetchedAt = this.clock().toISOString();
            const mapped: Array<{
              option: TransportOption;
              upstreamOffer: DuffelOffer;
            }> = [];
            for (const offer of parsed.data.data.offers) {
              try {
                mapped.push({
                  option: mapDuffelOffer(offer, {
                    destinationCode: plan.destination.code,
                    originCode,
                    currency: request.currency,
                    environment: this.environment,
                    queryFingerprint: plan.queryFingerprint,
                    fetchedAt,
                  }),
                  upstreamOffer: offer,
                });
              } catch {
                // One malformed, ambiguous, stale-shaped or currency-incompatible offer is
                // rejected locally; the destination remains usable if other offers are valid.
              }
            }
            return stableOffers(mapped, this.maxOffersPerDestination);
          },
        ),
      ),
    );
    return Object.freeze(
      groups
        .flat()
        .sort(
          (left, right) =>
            left.destinationCode.localeCompare(right.destinationCode, 'en') ||
            left.id.localeCompare(right.id, 'en'),
        ),
    );
  }
}
