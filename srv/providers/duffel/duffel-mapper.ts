import type { TransportLeg, TransportOption } from '../../domain/candidate.ts';
import {
  CURRENCY_CONTRACT_VERSION,
  getSupportedCurrencyDefinitionForContract,
} from '../../domain/currency.ts';
import {
  SOURCE_SNAPSHOT_CONTRACT_VERSION,
  createMoney,
  type SourceSnapshot,
} from '../../domain/money.ts';
import { OFFER_PRICING_CONTRACT_VERSION } from '../../domain/offer-pricing.ts';
import { transportResultView } from '../normalized-result.ts';
import { createProviderFingerprint, type ProviderJsonValue } from '../provider-fingerprint.ts';
import {
  createSourceSnapshotResultFingerprint,
  type SourceSnapshotResultFingerprintInput,
} from '../source-snapshot.ts';
import {
  DUFFEL_ADAPTER_VERSION,
  DUFFEL_API_VERSION,
  DUFFEL_TERMS_POLICY_VERSION,
  type DuffelEnvironment,
  type DuffelOffer,
  type DuffelSlice,
} from './duffel-contracts.ts';
import { DUFFEL_UPSTREAM_SCHEMA_FINGERPRINT } from './duffel-schemas.ts';

export interface DuffelMapperContext {
  readonly destinationCode: string;
  readonly originCode: string;
  readonly currency: string;
  readonly environment: DuffelEnvironment;
  readonly queryFingerprint: string;
  readonly fetchedAt: string;
}

function parseAmountMinor(value: string, currency: string): number {
  const definition = getSupportedCurrencyDefinitionForContract(CURRENCY_CONTRACT_VERSION, currency);
  if (definition === null) throw new TypeError('Duffel offer currency is unsupported.');
  const match = new RegExp(`^(\\d+)(?:\\.(\\d{1,${definition.fractionDigits}}))?$`).exec(value);
  if (match === null) throw new TypeError('Duffel offer amount has invalid precision.');
  const scale = 10n ** BigInt(definition.fractionDigits);
  const minor =
    BigInt(match[1] ?? '0') * scale +
    BigInt((match[2] ?? '').padEnd(definition.fractionDigits, '0'));
  const amountMinor = Number(minor);
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) {
    throw new TypeError('Duffel offer amount is outside integer minor units.');
  }
  return amountMinor;
}

function durationMinutes(value: string): number {
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?$/.exec(value);
  if (match === null || (match[1] === undefined && match[2] === undefined)) {
    throw new TypeError('Duffel duration is invalid.');
  }
  const minutes = Number(match[1] ?? '0') * 60 + Number(match[2] ?? '0');
  if (!Number.isSafeInteger(minutes) || minutes <= 0) {
    throw new TypeError('Duffel duration is outside supported bounds.');
  }
  return minutes;
}

function localParts(value: string): readonly number[] {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/.exec(value);
  if (match === null) throw new TypeError('Duffel local timestamp is invalid.');
  return [
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6]),
    Number((match[7] ?? '').padEnd(3, '0')),
  ];
}

function zonedInstant(local: string, timeZone: string): string {
  const parts = localParts(local);
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    calendar: 'iso8601',
    numberingSystem: 'latn',
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const target = parts.slice(0, 6).join('|');
  const normalizedGuess = Date.UTC(
    parts[0]!,
    parts[1]! - 1,
    parts[2]!,
    parts[3]!,
    parts[4]!,
    parts[5]!,
    parts[6]!,
  );
  const matches: number[] = [];
  for (let offsetMinutes = -14 * 60; offsetMinutes <= 14 * 60; offsetMinutes += 15) {
    const candidate = normalizedGuess + offsetMinutes * 60_000;
    const formatted = Object.fromEntries(
      formatter
        .formatToParts(candidate)
        .filter(({ type }) => ['year', 'month', 'day', 'hour', 'minute', 'second'].includes(type))
        .map(({ type, value }) => [type, Number(value)]),
    );
    const actual = [
      formatted.year,
      formatted.month,
      formatted.day,
      formatted.hour,
      formatted.minute,
      formatted.second,
    ].join('|');
    if (actual === target) matches.push(candidate);
  }
  if (matches.length !== 1) throw new TypeError('Duffel local timestamp is ambiguous.');
  const offsetMinutes = Math.floor((normalizedGuess - matches[0]!) / 60_000);
  const offsetSign = offsetMinutes < 0 ? '-' : '+';
  const absoluteOffset = Math.abs(offsetMinutes);
  const padded = (value: number, width = 2): string => String(value).padStart(width, '0');
  return `${padded(parts[0]!, 4)}-${padded(parts[1]!)}-${padded(parts[2]!)}T${padded(parts[3]!)}:${padded(parts[4]!)}:${padded(parts[5]!)}.${padded(parts[6]!, 3)}${offsetSign}${padded(Math.floor(absoluteOffset / 60))}:${padded(absoluteOffset % 60)}`;
}

function mapSlice(slice: DuffelSlice): TransportLeg {
  for (let index = 1; index < slice.segments.length; index += 1) {
    if (
      slice.segments[index - 1]!.destination.iata_code !== slice.segments[index]!.origin.iata_code
    ) {
      throw new TypeError('Duffel slice contains an airport change or discontinuity.');
    }
  }
  let previousArrivalAt: string | null = null;
  const mappedSegments = slice.segments.map((segment) => {
    const departureAt = zonedInstant(segment.departing_at, segment.origin.time_zone);
    const arrivalAt = zonedInstant(segment.arriving_at, segment.destination.time_zone);
    const explicitDuration = durationMinutes(segment.duration);
    const actualDuration = Math.floor((Date.parse(arrivalAt) - Date.parse(departureAt)) / 60_000);
    if (actualDuration <= 0 || actualDuration !== explicitDuration) {
      throw new TypeError('Duffel segment duration is inconsistent with explicit timestamps.');
    }
    if (previousArrivalAt !== null && Date.parse(previousArrivalAt) > Date.parse(departureAt)) {
      throw new TypeError('Duffel slice contains overlapping or reversed segments.');
    }
    previousArrivalAt = arrivalAt;
    return { departureAt, arrivalAt };
  });
  const first = slice.segments[0]!;
  const last = slice.segments.at(-1)!;
  if (
    first.origin.iata_code !== slice.origin.iata_code ||
    last.destination.iata_code !== slice.destination.iata_code
  ) {
    throw new TypeError('Duffel slice endpoints are inconsistent.');
  }
  const departureAt = mappedSegments[0]!.departureAt;
  const arrivalAt = mappedSegments.at(-1)!.arrivalAt;
  const explicitDuration = durationMinutes(slice.duration);
  if (Math.floor((Date.parse(arrivalAt) - Date.parse(departureAt)) / 60_000) !== explicitDuration) {
    throw new TypeError('Duffel slice duration is inconsistent with explicit timestamps.');
  }
  return {
    departureAt,
    arrivalAt,
    durationMinutes: explicitDuration,
    connections: slice.segments.length - 1,
  };
}

function sourceAttribution(offer: DuffelOffer): string {
  const carriers = [
    ...new Set(
      offer.slices.flatMap((slice) =>
        slice.segments.map((segment) => segment.operating_carrier.name),
      ),
    ),
  ].sort((left, right) => left.localeCompare(right, 'en'));
  const attribution = `Duffel; operated by ${carriers.join(', ')}`;
  if (attribution.length > 500) throw new TypeError('Duffel carrier attribution is too long.');
  return attribution;
}

export function mapDuffelOffer(offer: DuffelOffer, context: DuffelMapperContext): TransportOption {
  if (Date.parse(offer.expires_at) <= Date.parse(context.fetchedAt)) {
    throw new TypeError('Duffel offer is not fresh at the mapper checkpoint.');
  }
  if (offer.live_mode !== (context.environment === 'LIVE')) {
    throw new TypeError('Duffel offer environment does not match configured lineage.');
  }
  const [outboundSlice, returnSlice] = offer.slices;
  if (
    outboundSlice.origin.iata_code !== context.originCode ||
    outboundSlice.destination.iata_code !== context.destinationCode ||
    returnSlice.origin.iata_code !== context.destinationCode ||
    returnSlice.destination.iata_code !== context.originCode
  ) {
    throw new TypeError('Duffel offer route does not match the planned return journey.');
  }
  if (
    offer.base_currency !== context.currency ||
    offer.tax_currency !== context.currency ||
    offer.total_currency !== context.currency ||
    offer.tax_amount === null
  ) {
    throw new TypeError('Duffel offer mandatory currency facts are incomplete or mismatched.');
  }
  const baseMinor = parseAmountMinor(offer.base_amount, offer.base_currency);
  const taxMinor = parseAmountMinor(offer.tax_amount, offer.tax_currency);
  const totalMinor = parseAmountMinor(offer.total_amount, offer.total_currency);
  if (baseMinor + taxMinor !== totalMinor || !Number.isSafeInteger(baseMinor + taxMinor)) {
    throw new TypeError('Duffel offer mandatory price arithmetic is inconsistent.');
  }

  const outbound = mapSlice(outboundSlice);
  const returnLeg = mapSlice(returnSlice);
  const sourceInput: SourceSnapshotResultFingerprintInput = {
    contractVersion: SOURCE_SNAPSHOT_CONTRACT_VERSION,
    id: `duffel:${context.environment.toLowerCase()}:${offer.id}`,
    sourceType: 'LIVE',
    provider: 'Duffel',
    adapterVersion: DUFFEL_ADAPTER_VERSION,
    providerVersion: `duffel-${context.environment.toLowerCase()}-offers-v2`,
    upstreamApiVersion: DUFFEL_API_VERSION,
    upstreamSchemaFingerprint: DUFFEL_UPSTREAM_SCHEMA_FINGERPRINT,
    queryFingerprint: context.queryFingerprint,
    externalItemId: offer.id,
    fetchedAt: context.fetchedAt,
    expiresAt: offer.expires_at,
    sourceUrl: 'https://duffel.com',
    attribution: sourceAttribution(offer),
    freshnessType: 'LIVE',
    currency: context.currency,
    fixtureVersion: null,
    termsPolicyVersion: DUFFEL_TERMS_POLICY_VERSION,
  };
  const withoutSource: TransportOption = {
    id: `duffel:${offer.id}`,
    destinationCode: context.destinationCode,
    mode: 'FLIGHT',
    outbound,
    return: returnLeg,
    price: createMoney(baseMinor, context.currency, 'LIVE_PRICE', null),
    additionalFees: createMoney(taxMinor, context.currency, 'LIVE_PRICE', null),
    pricing: {
      contractVersion: OFFER_PRICING_CONTRACT_VERSION,
      mandatoryTotal: createMoney(totalMinor, context.currency, 'LIVE_PRICE', null),
      conditionalCharges: { completeness: 'UNKNOWN', items: [] },
      optionalAncillaries: {
        completeness: offer.available_services === undefined ? 'UNKNOWN' : 'COMPLETE',
        items: (offer.available_services ?? []).map((service) => ({
          id: service.id,
          code: service.type === 'baggage' ? 'CHECKED_BAGGAGE' : 'SEAT',
          label: service.type === 'baggage' ? 'Optional baggage service' : 'Optional seat service',
          amount: createMoney(
            parseAmountMinor(service.total_amount, service.total_currency),
            service.total_currency,
            'LIVE_PRICE',
            null,
          ),
        })),
      },
    },
    sourceSnapshot: null,
  };
  if (
    withoutSource.pricing.optionalAncillaries.items.some(
      (service) => service.amount.currency !== context.currency,
    )
  ) {
    throw new TypeError('Duffel optional service currency is unsupported or mismatched.');
  }
  const resultView = transportResultView(withoutSource) as ProviderJsonValue;
  const source: SourceSnapshot = {
    ...sourceInput,
    resultFingerprint: createSourceSnapshotResultFingerprint(sourceInput, resultView),
  };
  const bindMoney = (amountMinor: number) =>
    createMoney(amountMinor, context.currency, 'LIVE_PRICE', source);
  return {
    ...withoutSource,
    price: bindMoney(baseMinor),
    additionalFees: bindMoney(taxMinor),
    pricing: {
      ...withoutSource.pricing,
      mandatoryTotal: bindMoney(totalMinor),
      optionalAncillaries: {
        ...withoutSource.pricing.optionalAncillaries,
        items: withoutSource.pricing.optionalAncillaries.items.map((service) => ({
          ...service,
          amount: createMoney(
            service.amount.amountMinor!,
            service.amount.currency,
            'LIVE_PRICE',
            source,
          ),
        })),
      },
    },
    sourceSnapshot: source,
  };
}

export function duffelOfferSemanticFingerprint(
  offer: DuffelOffer,
  option: TransportOption,
): string {
  return createProviderFingerprint({
    slices: offer.slices.map((slice) => ({
      duration: slice.duration,
      origin: slice.origin.iata_code,
      destination: slice.destination.iata_code,
      segments: slice.segments.map((segment) => ({
        origin: segment.origin.iata_code,
        originTimeZone: segment.origin.time_zone,
        destination: segment.destination.iata_code,
        destinationTimeZone: segment.destination.time_zone,
        departingAt: segment.departing_at,
        arrivingAt: segment.arriving_at,
        duration: segment.duration,
        operatingCarrierId: segment.operating_carrier.id,
        operatingCarrierIataCode: segment.operating_carrier.iata_code,
        operatingCarrierFlightNumber: segment.operating_carrier_flight_number,
      })),
    })),
    priceAmountMinor: option.price.amountMinor,
    feesAmountMinor: option.additionalFees.amountMinor,
    totalAmountMinor: option.pricing.mandatoryTotal.amountMinor,
    currency: option.price.currency,
    optionalAncillaries: [...option.pricing.optionalAncillaries.items]
      .sort(
        (left, right) =>
          left.code.localeCompare(right.code, 'en') || left.id.localeCompare(right.id, 'en'),
      )
      .map((service) => ({
        id: service.id,
        code: service.code,
        amountMinor: service.amount.amountMinor,
        currency: service.amount.currency,
      })),
  });
}
