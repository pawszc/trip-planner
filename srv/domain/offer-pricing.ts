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
export const CONDITIONAL_CHARGE_PAYABLE_AT_VALUES = [
  'BOOKING',
  'PROPERTY',
  'AIRPORT',
  'UNKNOWN',
] as const;
export type ConditionalChargePayableAt = (typeof CONDITIONAL_CHARGE_PAYABLE_AT_VALUES)[number];

interface OfferChargeDisclosureBase {
  /** Stable adapter/provider identifier, separate from any raw free-text description. */
  id: string;
  /** Closed adapter-owned code such as CITY_TAX or CHECKED_BAGGAGE. */
  code: string;
  /** Safe adapter-normalized display label; never an arbitrary raw payload. */
  label: string;
  amount: Money;
}

export interface ConditionalChargeDisclosure extends OfferChargeDisclosureBase {
  condition: string;
  payableAt: ConditionalChargePayableAt;
  mandatoryWhenConditionMet: boolean;
}

export type OptionalAncillaryDisclosure = OfferChargeDisclosureBase;

export type OfferChargeDisclosure = ConditionalChargeDisclosure | OptionalAncillaryDisclosure;

export interface OfferChargeCollection<
  TDisclosure extends OfferChargeDisclosure = OfferChargeDisclosure,
> {
  completeness: ChargeCollectionCompleteness;
  items: readonly TDisclosure[];
}

/**
 * `price` on the containing offer remains the mandatory subtotal and `additionalFees` remains
 * mandatory taxes/fees. This v2 block binds their required all-in total and keeps contingent or
 * unselected charges explicit but non-additive.
 */
export interface OfferPricingV2 {
  contractVersion: typeof OFFER_PRICING_CONTRACT_VERSION;
  mandatoryTotal: Money;
  conditionalCharges: OfferChargeCollection<ConditionalChargeDisclosure>;
  optionalAncillaries: OfferChargeCollection<OptionalAncillaryDisclosure>;
}

export function knownEmptyChargeCollection<
  TDisclosure extends OfferChargeDisclosure = OfferChargeDisclosure,
>(): OfferChargeCollection<TDisclosure> {
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

function safeChargeDisplayText(value: unknown, maximum: number): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= maximum &&
    ![...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || (codePoint >= 127 && codePoint <= 159);
    })
  );
}

export function chargeCollectionValidationIssues(
  collection: OfferChargeCollection | null | undefined,
  path: string,
  kind: 'CONDITIONAL' | 'OPTIONAL' = 'OPTIONAL',
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
    const expectedItemKeys =
      kind === 'CONDITIONAL'
        ? ['amount', 'code', 'condition', 'id', 'label', 'mandatoryWhenConditionMet', 'payableAt']
        : ['amount', 'code', 'id', 'label'];
    if (
      itemKeys.length !== expectedItemKeys.length ||
      itemKeys.some((key, keyIndex) => key !== expectedItemKeys[keyIndex])
    ) {
      issues.push(`${path}.items[${index}].fields`);
    }
    if (!safeChargeText(item.id) || seenIds.has(item.id)) {
      issues.push(`${path}.items[${index}].id`);
    }
    if (safeChargeText(item.id)) seenIds.add(item.id);
    if (!safeChargeText(item.code)) issues.push(`${path}.items[${index}].code`);
    if (!safeChargeDisplayText(item.label, 240)) issues.push(`${path}.items[${index}].label`);
    if (kind === 'CONDITIONAL') {
      if (!safeChargeDisplayText(item.condition, 500)) {
        issues.push(`${path}.items[${index}].condition`);
      }
      if (
        !CONDITIONAL_CHARGE_PAYABLE_AT_VALUES.includes(item.payableAt as ConditionalChargePayableAt)
      ) {
        issues.push(`${path}.items[${index}].payableAt`);
      }
      if (typeof item.mandatoryWhenConditionMet !== 'boolean') {
        issues.push(`${path}.items[${index}].mandatoryWhenConditionMet`);
      }
    }
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
    ...chargeCollectionValidationIssues(
      pricing.conditionalCharges,
      `${path}.conditionalCharges`,
      'CONDITIONAL',
    ),
    ...chargeCollectionValidationIssues(
      pricing.optionalAncillaries,
      `${path}.optionalAncillaries`,
      'OPTIONAL',
    ),
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
