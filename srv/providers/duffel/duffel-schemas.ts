import { z } from 'zod';
import { createProviderFingerprint } from '../provider-fingerprint.ts';

const safeId = (prefix: string) => z.string().regex(new RegExp(`^${prefix}_[A-Za-z0-9]{6,120}$`));
const iataCode = z.string().regex(/^[A-Z]{3}$/);
const carrierIataCode = z.string().regex(/^[A-Z0-9]{2}$/);
const safeText = z
  .string()
  .min(1)
  .max(160)
  .refine((value) => ![...value].some((character) => (character.codePointAt(0) ?? 0) <= 31));
const amount = z.string().regex(/^\d+(?:\.\d{1,2})?$/);
const expiryInstant = z.string().datetime({ offset: true });
const localInstant = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?$/);
const duration = z.string().regex(/^PT(?=\d)(?:\d+H)?(?:\d+M)?$/);

const locationSchema = z.object({
  iata_code: iataCode,
  time_zone: z.string().min(1).max(80),
});

const carrierSchema = z.object({
  id: safeId('arl'),
  name: safeText,
  iata_code: carrierIataCode.nullable(),
});

const segmentSchema = z.object({
  id: safeId('seg'),
  departing_at: localInstant,
  arriving_at: localInstant,
  duration,
  origin: locationSchema,
  destination: locationSchema,
  operating_carrier: carrierSchema,
  operating_carrier_flight_number: z.string().regex(/^[A-Z0-9]{1,8}$/),
});

const sliceSchema = z.object({
  id: safeId('sli'),
  duration,
  origin: locationSchema,
  destination: locationSchema,
  segments: z.array(segmentSchema).min(1).max(8),
});

const availableServiceSchema = z.object({
  id: safeId('ase'),
  type: z.enum(['baggage', 'seat']),
  total_amount: amount,
  total_currency: z.string().regex(/^[A-Z]{3}$/),
});

export const duffelOfferSchema = z.object({
  id: safeId('off'),
  expires_at: expiryInstant,
  live_mode: z.boolean(),
  base_amount: amount,
  base_currency: z.string().regex(/^[A-Z]{3}$/),
  tax_amount: amount.nullable(),
  tax_currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .nullable(),
  total_amount: amount,
  total_currency: z.string().regex(/^[A-Z]{3}$/),
  slices: z.tuple([sliceSchema, sliceSchema]),
  available_services: z.array(availableServiceSchema).max(100).optional(),
});

export const duffelOfferRequestEnvelopeSchema = z.object({
  data: z.object({
    id: safeId('orq'),
    live_mode: z.boolean(),
    offers: z.array(z.unknown()),
  }),
});

export const duffelOfferRequestResponseSchema = z.object({
  data: z.object({
    id: safeId('orq'),
    live_mode: z.boolean(),
    offers: z.array(duffelOfferSchema),
  }),
});

export const DUFFEL_UPSTREAM_SCHEMA_FINGERPRINT = createProviderFingerprint({
  contract: 'duffel-offer-request-offers-v2',
  projection: [
    'offer.id',
    'offer.expires_at',
    'offer.live_mode',
    'offer.base_amount/currency',
    'offer.tax_amount/currency',
    'offer.total_amount/currency',
    'offer.slices[2].segments',
    'segment.times/locations/operating_carrier',
    'offer.available_services?',
  ],
});
