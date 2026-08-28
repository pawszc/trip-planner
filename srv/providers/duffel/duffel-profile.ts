import type { CandidateEngineProviders } from '../../orchestration/candidate-engine.ts';
import { SOURCE_SNAPSHOT_CONTRACT_VERSION } from '../../domain/money.ts';
import { MockAccommodationProvider } from '../mock-accommodation-provider.ts';
import { MockPlacesProvider } from '../mock-places-provider.ts';
import {
  createProviderConfigurationManifest,
  MOCK_PROVIDER_MANIFEST,
  type ProviderConfigurationManifest,
  type ProviderManifestEntry,
} from '../provider-manifest.ts';
import {
  DUFFEL_ADAPTER_ID,
  DUFFEL_ADAPTER_VERSION,
  DUFFEL_API_VERSION,
  DUFFEL_SEARCH_POLICY_VERSION,
  DUFFEL_UPSTREAM_SCHEMA_VERSION,
  type DuffelEnvironment,
} from './duffel-contracts.ts';
import { DuffelApiTransportProvider } from './duffel-api-transport-provider.ts';
import { DUFFEL_UPSTREAM_SCHEMA_FINGERPRINT } from './duffel-schemas.ts';
import type { ProviderHttpClient } from '../http/provider-http-client.ts';

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

export function createDuffelPlanningProviderManifest(
  environment: DuffelEnvironment,
): ProviderConfigurationManifest {
  return createProviderConfigurationManifest(
    MOCK_PROVIDER_MANIFEST.entries.map((entry) =>
      entry.role === 'TRANSPORT' ? createDuffelTransportManifestEntry(environment) : entry,
    ),
  );
}

export interface DuffelPlanningProfileOptions {
  readonly environment: DuffelEnvironment;
  readonly httpClient: ProviderHttpClient;
  readonly clock?: () => Date;
}

export interface DuffelPlanningProfile {
  readonly manifest: ProviderConfigurationManifest;
  readonly providers: CandidateEngineProviders;
}

export function createDuffelPlanningProfile(
  options: DuffelPlanningProfileOptions,
): DuffelPlanningProfile {
  const manifest = createDuffelPlanningProviderManifest(options.environment);
  const transportEntry = manifest.entries.find((entry) => entry.role === 'TRANSPORT');
  if (transportEntry === undefined) throw new TypeError('Duffel transport manifest is missing.');
  return Object.freeze({
    manifest,
    providers: Object.freeze({
      transport: new DuffelApiTransportProvider({
        environment: options.environment,
        httpClient: options.httpClient,
        manifestEntry: transportEntry,
        ...(options.clock === undefined ? {} : { clock: options.clock }),
      }),
      accommodation: new MockAccommodationProvider(),
      places: new MockPlacesProvider(),
    }),
  });
}
