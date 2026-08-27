import {
  addMinorUnits,
  classifyMoney,
  isKnownMoney,
  isMoney,
  moneyValidationIssues,
  type Money,
} from './money.ts';

export const OFFER_PRICING_CONTRACT_VERSION = 'offer-price-v2';
export const CHARGE_COLLECTION_COMPLETENESS_VALUES = ['COMPLETE', 'PARTIAL', 'UNKNOWN'] as const;
export type ChargeCollectionCompleteness = (typeof CHARGE_COLLECTION_COMPLETENESS_VALUES)[number];
export const MAX_OFFER_CHARGE_ITEMS = 100;

export interface OfferChargeDisclosure {
  /** Stable adapter/provider identifier, separate from any raw free-text description. */
  id: string;
  /** Closed adapter-owned code such as CITY_TAX or CHECKED_BAGGAGE. */
  code: string;
  amount: Money;
}

export interface OfferChargeCollection {
  completeness: ChargeCollectionCompleteness;
  items: readonly OfferChargeDisclosure[];
}

/**
 * `price` on the containing offer remains the mandatory subtotal and `additionalFees` remains
 * mandatory taxes/fees. This v2 block binds their required all-in total and keeps contingent or
 * unselected charges explicit but non-additive.
 */
export interface OfferPricingV2 {
  contractVersion: typeof OFFER_PRICING_CONTRACT_VERSION;
  mandatoryTotal: Money;
  conditionalCharges: OfferChargeCollection;
  optionalAncillaries: OfferChargeCollection;
}

export function knownEmptyChargeCollection(): OfferChargeCollection {
  return Object.freeze({ completeness: 'COMPLETE', items: Object.freeze([]) });
}

function safeChargeText(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 120 &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
  );
}

export function chargeCollectionValidationIssues(
  collection: OfferChargeCollection | null | undefined,
  path: string,
): readonly string[] {
  const issues: string[] = [];
  if (collection === null || typeof collection !== 'object') {
    return Object.freeze([path]);
  }
  const collectionKeys = Object.keys(collection).sort((left, right) =>
    left.localeCompare(right, 'en'),
  );
  if (
    collectionKeys.length !== 2 ||
    collectionKeys[0] !== 'completeness' ||
    collectionKeys[1] !== 'items'
  ) {
    issues.push(`${path}.fields`);
  }
  if (!CHARGE_COLLECTION_COMPLETENESS_VALUES.includes(collection.completeness)) {
    issues.push(`${path}.completeness`);
  }
  if (!Array.isArray(collection.items)) return Object.freeze([...issues, `${path}.items`]);
  if (collection.items.length > MAX_OFFER_CHARGE_ITEMS) issues.push(`${path}.itemLimit`);
  const seenIds = new Set<string>();
  for (const [index, typedCharge] of collection.items.entries()) {
    const charge: unknown = typedCharge;
    if (typeof charge !== 'object' || charge === null) {
      issues.push(`${path}.items[${index}]`);
      continue;
    }
    const item = charge as Readonly<Record<string, unknown>>;
    const itemKeys = Object.keys(item).sort((left, right) => left.localeCompare(right, 'en'));
    if (
      itemKeys.length !== 3 ||
      itemKeys[0] !== 'amount' ||
      itemKeys[1] !== 'code' ||
      itemKeys[2] !== 'id'
    ) {
      issues.push(`${path}.items[${index}].fields`);
    }
    if (!safeChargeText(item.id) || seenIds.has(item.id)) {
      issues.push(`${path}.items[${index}].id`);
    }
    if (safeChargeText(item.id)) seenIds.add(item.id);
    if (!safeChargeText(item.code)) issues.push(`${path}.items[${index}].code`);
    issues.push(...moneyValidationIssues(item.amount, `${path}.items[${index}].amount`));
  }
  return Object.freeze(issues);
}

/** Shape/reconciliation issues only; UNKNOWN mandatory values are classified separately. */
export function offerPricingValidationIssues(
  price: Money,
  mandatoryFees: Money,
  pricing: OfferPricingV2 | null | undefined,
  path: string,
): readonly string[] {
  const issues: string[] = [];
  if (pricing === null || typeof pricing !== 'object') return Object.freeze([path]);
  const pricingKeys = Object.keys(pricing).sort((left, right) => left.localeCompare(right, 'en'));
  if (
    pricingKeys.length !== 4 ||
    pricingKeys[0] !== 'conditionalCharges' ||
    pricingKeys[1] !== 'contractVersion' ||
    pricingKeys[2] !== 'mandatoryTotal' ||
    pricingKeys[3] !== 'optionalAncillaries'
  ) {
    issues.push(`${path}.fields`);
  }
  if (pricing.contractVersion !== OFFER_PRICING_CONTRACT_VERSION) {
    issues.push(`${path}.contractVersion`);
  }
  issues.push(
    ...moneyValidationIssues(price, `${path}.subtotal`),
    ...moneyValidationIssues(mandatoryFees, `${path}.mandatoryFees`),
    ...moneyValidationIssues(pricing.mandatoryTotal, `${path}.mandatoryTotal`),
    ...chargeCollectionValidationIssues(pricing.conditionalCharges, `${path}.conditionalCharges`),
    ...chargeCollectionValidationIssues(pricing.optionalAncillaries, `${path}.optionalAncillaries`),
  );
  if (!isMoney(price) || !isMoney(mandatoryFees) || !isMoney(pricing.mandatoryTotal)) {
    return Object.freeze(
      [...new Set(issues)].sort((left, right) => left.localeCompare(right, 'en')),
    );
  }
  if (
    price.currency !== mandatoryFees.currency ||
    price.currency !== pricing.mandatoryTotal.currency
  ) {
    issues.push(`${path}.mandatoryCurrency`);
  }
  if (isKnownMoney(price) && isKnownMoney(mandatoryFees) && isKnownMoney(pricing.mandatoryTotal)) {
    try {
      if (
        addMinorUnits(price.amountMinor, mandatoryFees.amountMinor) !==
        pricing.mandatoryTotal.amountMinor
      ) {
        issues.push(`${path}.mandatoryTotal`);
      }
    } catch {
      issues.push(`${path}.mandatoryTotal`);
    }
    const expectedClassification =
      price.priceType === 'ESTIMATE' || mandatoryFees.priceType === 'ESTIMATE'
        ? 'ESTIMATED'
        : 'CONFIRMED';
    if (classifyMoney(pricing.mandatoryTotal) !== expectedClassification) {
      issues.push(`${path}.mandatoryTotalClassification`);
    }
  }
  return Object.freeze([...new Set(issues)].sort((left, right) => left.localeCompare(right, 'en')));
}
