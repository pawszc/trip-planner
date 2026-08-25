import { canonicalizeJson, type JsonObject, type JsonValue } from '../ai/contracts.ts';
import { DomainError } from '../domain/domain-error.ts';
import type {
  GroundedFact,
  GroundedOptionContext,
  GroundedSourceSnapshot,
} from './grounded-option-context.ts';
import {
  buildNarrativeGenerationView,
  type NarrativeGenerationView,
} from './narrative-generation-view.ts';
import type { NarrativeModelView } from './narrative-model-view.ts';
import type { OptionNarrativeBlock, OptionNarrativeOutput } from './option-narrative.ts';

export const NARRATIVE_FINALIZATION_VERSION = 'narrative-finalization-v1';
export const OPTION_NARRATIVE_PROVIDER_MAX_BLOCKS = 6;
export const OPTION_NARRATIVE_FINAL_MAX_BLOCKS = 8;

const PROVENANCE_FACT_KEY_PREFIX = 'provenance.';
const MONEY_CLAIM_PATTERN =
  /(?:\b(?:PLN|EUR)\s*[-+]?\d(?:[\d\s.,]*\d)?|\b[-+]?\d(?:[\d\s.,]*\d)?\s*(?:PLN|EUR|zł|€))(?![\p{L}\p{N}_])/giu;
const ISO_INSTANT_CLAIM_PATTERN =
  /(?<!\d)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})(?!\d)/gu;
const CALENDAR_DATE_CLAIM_PATTERN =
  /(?<!\d)(?:\d{4}[-/.]\d{2}[-/.]\d{2}|\d{2}[-/.]\d{2}[-/.]\d{4})(?!\d)/gu;
const CLOCK_TIME_CLAIM_PATTERN =
  /(?<!\d)(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})?(?!\d)/gu;
const NUMBER_CLAIM_PATTERN = /(?<![\p{L}\p{N}_])[-+]?\d+(?:[.,]\d+)?(?![\p{L}\p{N}_])/gu;

// English and Polish are the closed product prose languages for locally reserved disclosure
// concepts. Quantitative binding below is language-independent and remains the primary guard
// against completing a non-KNOWN value.
const PROVIDER_CODE_OWNED_CLAIM_PATTERNS = [
  /(?:^|[^a-z0-9])(?:unknown|missing|absent|unavailable|incomplete|not\s+(?:known|provided|available))(?=$|[^a-z0-9])/u,
  /(?:^|[^a-z0-9])(?:nieznan[a-z]*|brakuj[a-z]*|niedostepn[a-z]*|niekompletn[a-z]*|nieobecn[a-z]*|nie\s+(?:podan[a-z]*|znan[a-z]*|dostepn[a-z]*))(?=$|[^a-z0-9])/u,
  /(?:^|[^a-z0-9])(?:cached?|fixture|demonstrat[a-z]*|test\s+data|fresh\s+data|real[- ]?time|live\s+(?:availability|offer|data|prices?)|currently\s+available|available\s+now|availability\s+(?:is\s+)?current|up[- ]to[- ]date)(?=$|[^a-z0-9])/u,
  /(?:^|[^a-z0-9])(?:dane\s+(?:testow[a-z]*|demonstracyjn[a-z]*|aktualn[a-z]*|biezac[a-z]*|swiez[a-z]*)|oferta\s+(?:aktualn[a-z]*|biezac[a-z]*|na\s+zywo)|dostepnosc\s+(?:aktualn[a-z]*|biezac[a-z]*|na\s+zywo)|na\s+zywo|w\s+czasie\s+rzeczywistym|pamieci\s+podrecznej)(?=$|[^a-z0-9])/u,
] as const;

const NON_KNOWN_FACT_LABELS = [
  ['option.budget.summary', 'budget summary'],
  ['option.budget.category.TRANSPORT', 'transport cost'],
  ['option.budget.category.ACCOMMODATION', 'accommodation cost'],
  ['option.budget.category.LOCAL_TRANSPORT', 'local transport cost'],
  ['option.budget.category.FOOD', 'food cost'],
  ['option.budget.category.ATTRACTIONS', 'attractions cost'],
  ['option.budget.category.ADDITIONAL_FEES', 'additional fees'],
  ['option.budget.category.BUFFER', 'budget buffer'],
] as const;

type NonKnownFactKey = (typeof NON_KNOWN_FACT_LABELS)[number][0];

const NON_KNOWN_PROVIDER_TERM_PATTERNS: Readonly<Record<NonKnownFactKey, RegExp>> = {
  'option.budget.summary':
    /(?:^|[^a-z0-9])(?:total\s+(?:cost|budget)|per\s+person|remaining\s+budget|within\s+budget|calkowit[a-z]*\s+koszt|laczny\s+koszt|na\s+osobe|pozostal[a-z]*\s+budzet|w\s+budzecie)(?=$|[^a-z0-9])/u,
  'option.budget.category.TRANSPORT':
    /(?:^|[^a-z0-9])(?:transport|transportation|przejazd[a-z]*|podroz[a-z]*)(?=$|[^a-z0-9])/u,
  'option.budget.category.ACCOMMODATION':
    /(?:^|[^a-z0-9])(?:accommodation|lodging|hotel|nocleg[a-z]*|zakwaterowan[a-z]*)(?=$|[^a-z0-9])/u,
  'option.budget.category.LOCAL_TRANSPORT':
    /(?:^|[^a-z0-9])(?:local\s+transport|transit|komunikacj[a-z]*\s+miejsk[a-z]*|transport[a-z]*\s+lokaln[a-z]*)(?=$|[^a-z0-9])/u,
  'option.budget.category.FOOD':
    /(?:^|[^a-z0-9])(?:food|meals?|dining|wyzywieni[a-z]*|jedzeni[a-z]*|posilk[a-z]*)(?=$|[^a-z0-9])/u,
  'option.budget.category.ATTRACTIONS':
    /(?:^|[^a-z0-9])(?:attractions?|activities|atrakcj[a-z]*)(?=$|[^a-z0-9])/u,
  'option.budget.category.ADDITIONAL_FEES':
    /(?:^|[^a-z0-9])(?:additional\s+fees?|extra\s+fees?|dodatkow[a-z]*\s+oplat[a-z]*)(?=$|[^a-z0-9])/u,
  'option.budget.category.BUFFER':
    /(?:^|[^a-z0-9])(?:budget\s+buffer|contingency|bufor[a-z]*)(?=$|[^a-z0-9])/u,
};

interface BuildMandatoryNarrativeBlocksInput {
  readonly context: GroundedOptionContext;
}

export interface FinalizeNarrativeOutputInput {
  readonly context: GroundedOptionContext;
  readonly modelView: NarrativeModelView;
  readonly generationView: NarrativeGenerationView;
  readonly providerBlocks: readonly OptionNarrativeBlock[];
}

export interface ValidateFinalizedNarrativeInput {
  readonly context: GroundedOptionContext;
  readonly modelView: NarrativeModelView;
  readonly generationView: NarrativeGenerationView;
  readonly output: OptionNarrativeOutput;
}

function invalidFinalization(message: string): never {
  throw new DomainError('INVALID_NARRATIVE_FINALIZATION', message);
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeProviderClaimText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[łŁ]/gu, 'l')
    .toLocaleLowerCase('en');
}

interface SupportedProviderLiterals {
  readonly moneyDisplays: ReadonlySet<string>;
  readonly numbers: ReadonlySet<string>;
  readonly strings: ReadonlySet<string>;
}

function collectSupportedProviderLiterals(
  value: JsonValue,
  field: string,
  strings: Set<string>,
  moneyDisplays: Set<string>,
  numbers: Set<string>,
): void {
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    numbers.add(String(value));
    return;
  }
  if (typeof value === 'string') {
    strings.add(value);
    if (field.toLowerCase().endsWith('display')) moneyDisplays.add(value);
    if (!field.toLowerCase().endsWith('minor') && /^[-+]?\d+(?:\.\d+)?$/u.test(value)) {
      numbers.add(value);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectSupportedProviderLiterals(item, field, strings, moneyDisplays, numbers);
    }
    return;
  }
  for (const [key, nested] of Object.entries(value)) {
    collectSupportedProviderLiterals(nested, key, strings, moneyDisplays, numbers);
  }
}

function supportedLiteralsForReferences(
  factReferences: readonly string[],
  generationView: NarrativeGenerationView,
): SupportedProviderLiterals {
  const byId = new Map(generationView.facts.map((fact) => [fact.factId, fact]));
  const strings = new Set<string>();
  const moneyDisplays = new Set<string>();
  const numbers = new Set<string>();
  for (const factId of factReferences) {
    const fact = byId.get(factId);
    if (fact === undefined) continue;
    collectSupportedProviderLiterals(fact.value, '', strings, moneyDisplays, numbers);
  }
  return { strings, moneyDisplays, numbers };
}

function consumeClaims(
  text: string,
  pattern: RegExp,
  isSupported: (claim: string) => boolean,
  failureMessage: string,
): string {
  const characters = text.split('');
  for (const match of text.matchAll(pattern)) {
    const claim = match[0];
    if (!isSupported(claim)) invalidFinalization(failureMessage);
    const start = match.index;
    if (start === undefined) invalidFinalization(failureMessage);
    for (let index = start; index < start + claim.length; index += 1) characters[index] = ' ';
  }
  return characters.join('');
}

function validateProviderQuantitativeClaims(
  text: string,
  literals: SupportedProviderLiterals,
): void {
  let remainder = consumeClaims(
    text,
    MONEY_CLAIM_PATTERN,
    (claim) => literals.moneyDisplays.has(claim),
    'Provider money claims must use an exact display from a cited KNOWN fact.',
  );
  remainder = consumeClaims(
    remainder,
    ISO_INSTANT_CLAIM_PATTERN,
    (claim) => literals.strings.has(claim),
    'Provider date-time claims must belong to a cited KNOWN fact.',
  );
  remainder = consumeClaims(
    remainder,
    CALENDAR_DATE_CLAIM_PATTERN,
    (claim) => [...literals.strings].some((value) => value.includes(claim)),
    'Provider date claims must belong to a cited KNOWN fact.',
  );
  remainder = consumeClaims(
    remainder,
    CLOCK_TIME_CLAIM_PATTERN,
    (claim) => [...literals.strings].some((value) => value.includes(claim)),
    'Provider time claims must belong to a cited KNOWN fact.',
  );
  consumeClaims(
    remainder,
    NUMBER_CLAIM_PATTERN,
    (claim) => literals.numbers.has(claim),
    'Provider numeric claims must belong exactly to a cited KNOWN fact.',
  );
}

function containsCodeOwnedSourceValue(text: string, context: GroundedOptionContext): boolean {
  const normalizedText = normalizeProviderClaimText(text);
  return context.sourceSnapshots.some((source) =>
    [
      source.id,
      source.sourceKey,
      source.provider,
      source.externalItemId,
      source.fetchedAt,
      source.sourceUrl,
      source.freshnessType,
      source.fixtureVersion,
      source.contexts,
    ].some((value) => {
      const normalized = normalizeProviderClaimText(value.trim());
      return normalized.length > 0 && normalizedText.includes(normalized);
    }),
  );
}

function containsCodeOwnedClaim(text: string, context: GroundedOptionContext): boolean {
  const normalized = normalizeProviderClaimText(text);
  if (
    PROVIDER_CODE_OWNED_CLAIM_PATTERNS.some((pattern) => pattern.test(normalized)) ||
    containsCodeOwnedSourceValue(text, context)
  ) {
    return true;
  }
  return context.facts
    .filter((fact) => fact.status !== 'KNOWN')
    .some((fact) => {
      const pattern = NON_KNOWN_PROVIDER_TERM_PATTERNS[fact.key as NonKnownFactKey];
      return pattern?.test(normalized) ?? true;
    });
}

function requireProvenanceFact(
  context: GroundedOptionContext,
  source: GroundedSourceSnapshot,
): GroundedFact {
  const matches = context.facts.filter(
    (fact) =>
      fact.key.startsWith(PROVENANCE_FACT_KEY_PREFIX) &&
      fact.sourceSnapshotIds.length === 1 &&
      fact.sourceSnapshotIds[0] === source.id,
  );
  if (matches.length !== 1) {
    invalidFinalization('Required provenance has no unambiguous code-owned grounded fact.');
  }
  const fact = matches[0]!;
  if (fact.status !== 'KNOWN' || !isJsonObject(fact.value)) {
    invalidFinalization('Required provenance fact is not an exact KNOWN metadata record.');
  }
  if (
    fact.value.sourceSnapshotId !== source.id ||
    fact.value.freshnessType !== source.freshnessType ||
    fact.value.demonstrationData !== source.demonstrationData
  ) {
    invalidFinalization('Required provenance fact does not match code-owned source metadata.');
  }
  return fact;
}

function buildProvenanceDisclosure(context: GroundedOptionContext): OptionNarrativeBlock | null {
  const requiringDisclosure = [...context.sourceSnapshots]
    .filter(
      (source) =>
        source.freshnessType === 'FIXTURE' ||
        source.freshnessType === 'CACHED' ||
        source.demonstrationData,
    )
    .sort((left, right) => left.id.localeCompare(right.id, 'en'));
  if (requiringDisclosure.length === 0) return null;

  const demonstration = requiringDisclosure.some(
    (source) => source.freshnessType === 'FIXTURE' || source.demonstrationData,
  );
  const cached = requiringDisclosure.some((source) => source.freshnessType === 'CACHED');
  const text =
    demonstration && cached
      ? 'Source disclosure: this option uses demonstrative fixture/test data and cached data; it is not a current live offer and does not represent current live availability.'
      : demonstration
        ? 'Source disclosure: this option uses demonstrative fixture/test data and is not a current live offer.'
        : 'Source disclosure: this option uses cached data and does not represent current live availability.';
  return {
    kind: 'RISK',
    text,
    factReferences: requiringDisclosure
      .map((source) => requireProvenanceFact(context, source))
      .map((fact) => fact.factId),
  };
}

function nonKnownFactLabel(fact: GroundedFact): string {
  const entry = NON_KNOWN_FACT_LABELS.find(([key]) => key === fact.key);
  if (entry === undefined) {
    invalidFinalization(`Non-KNOWN fact ${fact.key} has no closed disclosure label.`);
  }
  return entry[1];
}

function nonKnownFactOrder(fact: GroundedFact): number {
  const index = NON_KNOWN_FACT_LABELS.findIndex(([key]) => key === fact.key);
  if (index < 0) invalidFinalization(`Non-KNOWN fact ${fact.key} has no stable disclosure order.`);
  return index;
}

function buildNonKnownDisclosure(context: GroundedOptionContext): OptionNarrativeBlock | null {
  const nonKnownFacts = context.facts
    .filter((fact) => fact.status !== 'KNOWN')
    .sort(
      (left, right) =>
        nonKnownFactOrder(left) - nonKnownFactOrder(right) ||
        left.factId.localeCompare(right.factId, 'en'),
    );
  if (nonKnownFacts.length === 0) return null;
  if (nonKnownFacts.length > 32) {
    invalidFinalization('Non-KNOWN disclosure exceeds the final fact-reference contract.');
  }

  const unknown = nonKnownFacts.filter((fact) => fact.status === 'UNKNOWN');
  const missing = nonKnownFacts.filter((fact) => fact.status === 'MISSING');
  const clauses = [
    ...(unknown.length === 0
      ? []
      : [`UNKNOWN applies to ${unknown.map(nonKnownFactLabel).join(', ')}`]),
    ...(missing.length === 0
      ? []
      : [`MISSING (absent) applies to ${missing.map(nonKnownFactLabel).join(', ')}`]),
  ];
  const incompleteSummary = nonKnownFacts.some(
    (fact) => fact.key === ('option.budget.summary' satisfies NonKnownFactKey),
  );
  const text = `Limitations — ${clauses.join('; ')}. ${
    incompleteSummary
      ? 'The total, per-person, and remaining budget are unavailable because the budget is incomplete. '
      : ''
  }No unavailable value has been inferred.`;
  if (text.length > 1_200) {
    invalidFinalization('Non-KNOWN disclosure exceeds the final narrative text contract.');
  }
  return {
    kind: 'RISK',
    text,
    factReferences: nonKnownFacts.map((fact) => fact.factId),
  };
}

export function buildMandatoryNarrativeBlocks(
  input: BuildMandatoryNarrativeBlocksInput,
): readonly OptionNarrativeBlock[] {
  const provenance = buildProvenanceDisclosure(input.context);
  const nonKnown = buildNonKnownDisclosure(input.context);
  return [...(provenance === null ? [] : [provenance]), ...(nonKnown === null ? [] : [nonKnown])];
}

function validateProviderBlocks(
  blocks: readonly OptionNarrativeBlock[],
  generationView: NarrativeGenerationView,
  context: GroundedOptionContext,
): void {
  if (blocks.length < 1 || blocks.length > OPTION_NARRATIVE_PROVIDER_MAX_BLOCKS) {
    invalidFinalization(
      `Provider narrative must contain 1-${OPTION_NARRATIVE_PROVIDER_MAX_BLOCKS} generated blocks.`,
    );
  }
  const allowedFactIds = new Set(generationView.facts.map((fact) => fact.factId));
  for (const block of blocks) {
    if (containsCodeOwnedClaim(block.text, context)) {
      invalidFinalization(
        'Provider prose must not own source freshness/demonstration or UNKNOWN/MISSING handling.',
      );
    }
    if (block.factReferences.some((factId) => !allowedFactIds.has(factId))) {
      invalidFinalization('Provider prose references a fact outside the generation-only view.');
    }
    validateProviderQuantitativeClaims(
      block.text,
      supportedLiteralsForReferences(block.factReferences, generationView),
    );
  }
}

/** Appends mandatory code-owned blocks without modifying any provider-generated block. */
export function finalizeNarrativeOutput(
  input: FinalizeNarrativeOutputInput,
): OptionNarrativeOutput {
  const expectedGenerationView = buildNarrativeGenerationView(input.context, input.modelView);
  if (canonicalizeJson(input.generationView) !== canonicalizeJson(expectedGenerationView)) {
    invalidFinalization('Generation view does not match the exact grounded/model context.');
  }
  validateProviderBlocks(input.providerBlocks, input.generationView, input.context);
  const mandatoryBlocks = buildMandatoryNarrativeBlocks({ context: input.context });
  const blocks = [...input.providerBlocks, ...mandatoryBlocks];
  if (blocks.length > OPTION_NARRATIVE_FINAL_MAX_BLOCKS) {
    invalidFinalization('Final narrative exceeds reserved deterministic block capacity.');
  }
  return {
    contextFingerprint: input.context.fingerprint,
    blocks,
  };
}

/** Verifies the exact provider-prefix plus deterministic-tail contract before JUDGE/persistence. */
export function validateFinalizedNarrative(input: ValidateFinalizedNarrativeInput): boolean {
  try {
    const mandatoryBlocks = buildMandatoryNarrativeBlocks({ context: input.context });
    const providerBlockCount = input.output.blocks.length - mandatoryBlocks.length;
    if (providerBlockCount < 1 || providerBlockCount > OPTION_NARRATIVE_PROVIDER_MAX_BLOCKS) {
      return false;
    }
    const expected = finalizeNarrativeOutput({
      context: input.context,
      modelView: input.modelView,
      generationView: input.generationView,
      providerBlocks: input.output.blocks.slice(0, providerBlockCount),
    });
    return canonicalizeJson(input.output) === canonicalizeJson(expected);
  } catch {
    return false;
  }
}
