import { canonicalizeJson } from '../ai/contracts.ts';
import type { JsonValue } from '../ai/contracts.ts';
import type { GroundedFact, GroundedOptionContext } from './grounded-option-context.ts';
import type { NarrativeJudgeReasonCode } from './narrative-judge.ts';
import {
  buildNarrativeModelView,
  collectNarrativeExcludedValues,
  type NarrativeModelView,
} from './narrative-model-view.ts';
export { NARRATIVE_SAFETY_PRECHECK_VERSION } from './narrative-quality-versions.ts';
import { parseOptionNarrativeOutput, type OptionNarrativeOutput } from './option-narrative.ts';

// This deterministic boundary must recognize every forbidden C0/C1 control code explicitly.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;
const BIDI_OVERRIDE_PATTERN = /[\u202a-\u202e\u2066-\u2069]/u;
const MARKDOWN_LINK_PATTERN = /!?\[[^\]\r\n]{0,512}\]\([^\r\n)]{1,2048}\)/u;
const URL_PATTERN =
  /(?:\b[a-z][a-z0-9+.-]*:\/\/|\bwww\.|\bmailto:|\b(?:\d{1,3}\.){3}\d{1,3}\b|\b[a-z0-9](?:[a-z0-9-]{0,62}\.)+[a-z]{2,63}(?![a-z0-9-]))/iu;
const HTML_PATTERN = /<\/?[a-z][^>]*>/iu;
const SCRIPT_PATTERN = /(?:<\s*script\b|\bjavascript\s*:|\bdata\s*:\s*text\/html)/iu;
const EVENT_HANDLER_PATTERN = /\bon[a-z]{3,}\s*=/iu;
const SECRET_SHAPE_PATTERN = /\b(?:sk|pk|api|token|secret)[-_][A-Za-z0-9_-]{6,}\b/u;
const MONEY_LIKE_PATTERN =
  /(?:\b(PLN|EUR)\s*([-+]?\d(?:[\d\s.,]*\d)?[.,]?)|\b([-+]?\d(?:[\d\s.,]*\d)?)\s*(PLN|EUR|zł|€))(?![\p{L}\p{N}_])/giu;

export interface NarrativeSafetyPrecheckFinding {
  readonly reasonCode: NarrativeJudgeReasonCode;
  readonly severity: 'CRITICAL';
  readonly blockSequence: number;
}

export type NarrativeSafetyPrecheckFailure = NarrativeSafetyPrecheckFinding;

export type NarrativeSafetyPrecheckResult =
  | { readonly passed: true; readonly findings: readonly [] }
  | { readonly passed: false; readonly findings: readonly NarrativeSafetyPrecheckFinding[] };

export interface NarrativeSafetyPrecheckInput {
  readonly context: GroundedOptionContext;
  readonly modelView: NarrativeModelView;
  readonly narrativeOutput: unknown;
}

function isJsonArray(value: JsonValue): value is readonly JsonValue[] {
  return Array.isArray(value);
}

function collectDisplayValues(value: JsonValue, key = ''): readonly string[] {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return [];
  if (typeof value === 'string') return key.endsWith('Display') ? [value] : [];
  if (isJsonArray(value)) return value.flatMap((item) => collectDisplayValues(item));
  return Object.entries(value).flatMap(([field, fieldValue]) =>
    collectDisplayValues(fieldValue, field),
  );
}

function citedKnownMoneyDisplays(
  context: GroundedOptionContext,
  factReferences: readonly string[],
): readonly string[] {
  const cited = new Set(factReferences);
  return context.facts
    .filter((fact): fact is GroundedFact => fact.status === 'KNOWN' && cited.has(fact.factId))
    .flatMap((fact) => collectDisplayValues(fact.value))
    .filter((value, index, values) => value.length > 0 && values.indexOf(value) === index)
    .sort((left, right) => right.length - left.length || left.localeCompare(right, 'en'));
}

interface NormalizedMoneyToken {
  readonly currency: 'PLN' | 'EUR';
  readonly minorUnits: string;
}

function normalizeMoneyToken(
  currencyToken: string,
  amountToken: string,
): NormalizedMoneyToken | null {
  const currency = currencyToken === 'EUR' || currencyToken === '€' ? 'EUR' : 'PLN';
  const compact = amountToken.replace(/[\s\u00a0]/gu, '').replace(/[.,]+$/u, '');
  const negative = compact.startsWith('-');
  const unsigned = compact.replace(/^[-+]/u, '');
  if (!/^\d[\d.,]*$/u.test(unsigned)) return null;

  const separators = [...unsigned.matchAll(/[.,]/gu)];
  const finalSeparator = separators.at(-1);
  const digitsAfterFinal =
    finalSeparator === undefined ? -1 : unsigned.length - finalSeparator.index! - 1;
  const decimalSeparator =
    digitsAfterFinal === 1 || digitsAfterFinal === 2 ? finalSeparator?.[0] : undefined;
  const decimalIndex = decimalSeparator === undefined ? -1 : unsigned.lastIndexOf(decimalSeparator);
  const integerDigits = (decimalIndex < 0 ? unsigned : unsigned.slice(0, decimalIndex)).replace(
    /[.,]/gu,
    '',
  );
  const fractionalDigits =
    decimalIndex < 0 ? '' : unsigned.slice(decimalIndex + 1).replace(/[.,]/gu, '');
  if (!/^\d+$/u.test(integerDigits) || !/^\d{0,2}$/u.test(fractionalDigits)) return null;
  const normalizedInteger = integerDigits.replace(/^0+(?=\d)/u, '');
  const minorUnits = `${normalizedInteger}${fractionalDigits.padEnd(2, '0')}`.replace(
    /^0+(?=\d)/u,
    '',
  );
  return { currency, minorUnits: `${negative ? '-' : ''}${minorUnits}` };
}

function extractMoneyTokens(text: string): readonly NormalizedMoneyToken[] {
  return [...text.matchAll(MONEY_LIKE_PATTERN)].flatMap((match) => {
    const currencyToken = match[1] ?? match[4];
    const amountToken = match[2] ?? match[3];
    if (currencyToken === undefined || amountToken === undefined) return [];
    const normalized = normalizeMoneyToken(currencyToken, amountToken);
    return normalized === null ? [] : [normalized];
  });
}

function containsReformattedCitedMoney(
  text: string,
  context: GroundedOptionContext,
  factReferences: readonly string[],
): boolean {
  let remainder = text;
  const citedDisplays = citedKnownMoneyDisplays(context, factReferences);
  for (const display of citedDisplays) remainder = remainder.split(display).join(' ');
  const exactAmounts = citedDisplays.flatMap((display) => extractMoneyTokens(display));
  return extractMoneyTokens(remainder).some((candidate) =>
    exactAmounts.some(
      (exact) => exact.currency === candidate.currency && exact.minorUnits === candidate.minorUnits,
    ),
  );
}

function finding(
  reasonCode: NarrativeJudgeReasonCode,
  blockSequence: number,
): NarrativeSafetyPrecheckFinding {
  return { reasonCode, severity: 'CRITICAL', blockSequence };
}

function addUniqueFinding(
  findings: NarrativeSafetyPrecheckFinding[],
  next: NarrativeSafetyPrecheckFinding,
): void {
  if (
    !findings.some(
      (current) =>
        current.reasonCode === next.reasonCode && current.blockSequence === next.blockSequence,
    )
  ) {
    findings.push(next);
  }
}

/** Narrow deterministic checks only; semantic entailment remains the JUDGE's responsibility. */
export function runNarrativeSafetyPrecheck(
  input: NarrativeSafetyPrecheckInput,
): NarrativeSafetyPrecheckResult {
  const expectedModelView = buildNarrativeModelView(input.context);
  if (canonicalizeJson(expectedModelView) !== canonicalizeJson(input.modelView)) {
    return {
      passed: false,
      findings: [finding('UNTRUSTED_CONTENT_EXPOSED', 1)],
    };
  }
  const narrative: OptionNarrativeOutput = parseOptionNarrativeOutput(
    input.narrativeOutput,
    input.context,
  );
  const excludedValues = [...collectNarrativeExcludedValues(input.context)].sort(
    (left, right) => right.length - left.length,
  );
  const findings: NarrativeSafetyPrecheckFinding[] = [];

  for (const [index, block] of narrative.blocks.entries()) {
    const blockSequence = index + 1;
    const text = block.text;
    if (MARKDOWN_LINK_PATTERN.test(text) || URL_PATTERN.test(text)) {
      addUniqueFinding(findings, finding('UNTRUSTED_CONTENT_EXPOSED', blockSequence));
    }
    if (SECRET_SHAPE_PATTERN.test(text)) {
      addUniqueFinding(findings, finding('PII_OR_SECRET_EXPOSURE', blockSequence));
    }
    if (
      HTML_PATTERN.test(text) ||
      SCRIPT_PATTERN.test(text) ||
      EVENT_HANDLER_PATTERN.test(text) ||
      CONTROL_CHARACTER_PATTERN.test(text) ||
      BIDI_OVERRIDE_PATTERN.test(text)
    ) {
      addUniqueFinding(findings, finding('UNTRUSTED_CONTENT_EXPOSED', blockSequence));
    }
    const exposedExcludedValues = excludedValues.filter((value) => text.includes(value));
    if (exposedExcludedValues.length > 0) {
      addUniqueFinding(findings, finding('UNTRUSTED_CONTENT_EXPOSED', blockSequence));
      if (exposedExcludedValues.some((value) => SECRET_SHAPE_PATTERN.test(value))) {
        addUniqueFinding(findings, finding('PII_OR_SECRET_EXPOSURE', blockSequence));
      }
    }
    if (containsReformattedCitedMoney(text, input.context, block.factReferences)) {
      addUniqueFinding(findings, finding('MONEY_CALCULATION_OR_REFORMAT', blockSequence));
    }
  }

  return findings.length === 0 ? { passed: true, findings: [] } : { passed: false, findings };
}
