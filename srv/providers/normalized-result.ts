import type { Place, StayOption, TransportOption } from '../domain/candidate.ts';
import type { Money } from '../domain/money.ts';
import type { OfferChargeCollection, OfferPricingV2 } from '../domain/offer-pricing.ts';
import type { ProviderJsonValue } from './provider-fingerprint.ts';

function moneyResultView(money: Money): ProviderJsonValue {
  return {
    amountMinor: money.amountMinor,
    currency: money.currency,
    priceType: money.priceType,
  };
}

function chargeCollectionResultView(collection: OfferChargeCollection): ProviderJsonValue {
  return {
    completeness: collection.completeness,
    items: collection.items.map((charge) => ({
      id: charge.id,
      code: charge.code,
      label: charge.label,
      amount: moneyResultView(charge.amount),
      ...('condition' in charge
        ? {
            condition: charge.condition,
            payableAt: charge.payableAt,
            mandatoryWhenConditionMet: charge.mandatoryWhenConditionMet,
          }
        : {}),
    })),
  };
}

function offerPricingResultView(pricing: OfferPricingV2): ProviderJsonValue {
  return {
    contractVersion: pricing.contractVersion,
    mandatoryTotal: moneyResultView(pricing.mandatoryTotal),
    conditionalCharges: chargeCollectionResultView(pricing.conditionalCharges),
    optionalAncillaries: chargeCollectionResultView(pricing.optionalAncillaries),
  };
}

/** Closed, source-free DTO view used for item and provider-call result fingerprints. */
export function transportResultView(offer: TransportOption): ProviderJsonValue {
  return {
    id: offer.id,
    destinationCode: offer.destinationCode,
    mode: offer.mode,
    outbound: {
      departureAt: offer.outbound.departureAt,
      arrivalAt: offer.outbound.arrivalAt,
      durationMinutes: offer.outbound.durationMinutes,
      connections: offer.outbound.connections,
    },
    return: {
      departureAt: offer.return.departureAt,
      arrivalAt: offer.return.arrivalAt,
      durationMinutes: offer.return.durationMinutes,
      connections: offer.return.connections,
    },
    price: moneyResultView(offer.price),
    additionalFees: moneyResultView(offer.additionalFees),
    pricing: offerPricingResultView(offer.pricing),
  };
}

/** Closed, source-free DTO view used for item and provider-call result fingerprints. */
export function stayResultView(offer: StayOption): ProviderJsonValue {
  return {
    id: offer.id,
    destinationCode: offer.destinationCode,
    name: offer.name,
    checkInDate: offer.checkInDate,
    checkOutDate: offer.checkOutDate,
    nights: offer.nights,
    price: moneyResultView(offer.price),
    additionalFees: moneyResultView(offer.additionalFees),
    pricing: offerPricingResultView(offer.pricing),
    centralityScore: offer.centralityScore,
  };
}

/** Closed, source-free DTO view used for item and provider-call result fingerprints. */
export function placeResultView(place: Place): ProviderJsonValue {
  return {
    id: place.id,
    destinationCode: place.destinationCode,
    name: place.name,
    preferenceScores: {
      food: place.preferenceScores.food,
      nature: place.preferenceScores.nature,
      history: place.preferenceScores.history,
      museums: place.preferenceScores.museums,
      nightlife: place.preferenceScores.nightlife,
      centralAccommodation: place.preferenceScores.centralAccommodation,
      travelComfort: place.preferenceScores.travelComfort,
      priceSensitivity: place.preferenceScores.priceSensitivity,
    },
  };
}
