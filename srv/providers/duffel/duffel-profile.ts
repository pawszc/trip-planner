import type { CandidateEngineProviders } from '../../orchestration/candidate-engine.ts';
import { MockAccommodationProvider } from '../mock-accommodation-provider.ts';
import { MockPlacesProvider } from '../mock-places-provider.ts';
import {
  createProviderConfigurationManifest,
  MOCK_PROVIDER_MANIFEST,
  type ProviderConfigurationManifest,
} from '../provider-manifest.ts';
import type { DuffelEnvironment } from './duffel-contracts.ts';
import {
  createDuffelTransportManifestEntry,
  DuffelApiTransportProvider,
} from './duffel-api-transport-provider.ts';
import type { ProviderHttpClient } from '../http/provider-http-client.ts';

export { createDuffelTransportManifestEntry };

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
