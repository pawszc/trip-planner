import { describe, expect, it } from 'vitest';
import {
  buildGroundedOptionContext,
  type GroundedOptionContext,
  type GroundedOptionContextInput,
} from '../../srv/narratives/grounded-option-context.ts';
import {
  NARRATIVE_QUALITY_PRECHECK_CASE_IDS,
  loadNarrativeQualityDataset,
  resolveNarrativeQualityDataset,
} from '../../srv/evals/dataset.ts';
import { resolveSyntheticNarrativeQualityFixture } from '../../srv/evals/synthetic-fixtures.ts';
import { buildNarrativeModelView } from '../../srv/narratives/narrative-model-view.ts';
import {
  runNarrativeSafetyPrecheck,
  type NarrativeSafetyPrecheckResult,
} from '../../srv/narratives/narrative-safety-precheck.ts';
import type { OptionNarrativeOutput } from '../../srv/narratives/option-narrative.ts';
import { groundedOptionContextInput } from '../fixtures/grounded-option.ts';

function input(): GroundedOptionContextInput {
  return structuredClone(groundedOptionContextInput);
}

function context(sourceInput = input()): GroundedOptionContext {
  return buildGroundedOptionContext(sourceInput);
}

function fact(contextValue: GroundedOptionContext, key: string) {
  const value = contextValue.facts.find((candidate) => candidate.key === key);
  if (value === undefined) throw new Error(`Missing ${key} fixture fact.`);
  return value;
}

function output(
  contextValue: GroundedOptionContext,
  text: string,
  factKey = 'option.destination',
): OptionNarrativeOutput {
  return {
    contextFingerprint: contextValue.fingerprint,
    blocks: [
      {
        kind: 'SUMMARY',
        text,
        factReferences: [fact(contextValue, factKey).factId],
      },
    ],
  };
}

function check(
  contextValue: GroundedOptionContext,
  narrativeOutput: OptionNarrativeOutput,
): NarrativeSafetyPrecheckResult {
  return runNarrativeSafetyPrecheck({
    context: contextValue,
    modelView: buildNarrativeModelView(contextValue),
    narrativeOutput,
  });
}

function reasonCodes(result: NarrativeSafetyPrecheckResult): readonly string[] {
  return result.findings.map((finding) => finding.reasonCode);
}

describe('deterministic narrative safety precheck', () => {
  it('matches the frozen PRECHECK boundary and leaves R07, R08, and R10 to JUDGE', () => {
    const resolved = resolveNarrativeQualityDataset(
      loadNarrativeQualityDataset(),
      resolveSyntheticNarrativeQualityFixture,
    );
    const results = resolved.cases.map(({ authored, groundedContext, candidate }) => ({
      caseId: authored.id,
      result: runNarrativeSafetyPrecheck({
        context: groundedContext,
        modelView: buildNarrativeModelView(groundedContext),
        narrativeOutput: candidate,
      }),
    }));
    const failedCaseIds = results
      .filter(({ result }) => !result.passed)
      .map(({ caseId }) => caseId);

    expect(failedCaseIds).toEqual(NARRATIVE_QUALITY_PRECHECK_CASE_IDS);
    expect(failedCaseIds).not.toEqual(expect.arrayContaining(['R07', 'R08', 'R10']));
    expect(results.find(({ caseId }) => caseId === 'R20')?.result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reasonCode: 'PII_OR_SECRET_EXPOSURE' }),
        expect.objectContaining({ reasonCode: 'UNTRUSTED_CONTENT_EXPOSED' }),
      ]),
    );
  });

  it.each([
    ['URL', 'Sprawdź https://example.com/oferta.'],
    ['bare domain', 'Sprawdź booking.example.com teraz.'],
    ['Markdown link', 'Sprawdź [ofertę](/book-now).'],
    ['image Markdown', 'Źródło: ![hotel](image.png).'],
    ['HTML', 'Dobry <strong>hotel</strong>.'],
    ['script protocol', 'Otwórz javascript:alert(1).'],
    ['event handler', 'Opis onload=alert(1).'],
    ['control character', 'Praga\u0007 jest opcją.'],
    ['bidi override', 'Praga\u202Eexe jest opcją.'],
  ])('rejects %s deterministically', (_name, text) => {
    const grounded = context();
    const result = check(grounded, output(grounded, text));

    expect(result.passed).toBe(false);
    expect(reasonCodes(result)).toContain('UNTRUSTED_CONTENT_EXPOSED');
  });

  it('rejects exact excluded URL/external/provider-shaped values and marks secret exposure', () => {
    const sourceInput = input();
    sourceInput.sourceSnapshots[0]!.externalItemId = 'sk-test-do-not-expose';
    sourceInput.sourceSnapshots[0]!.sourceUrl = 'https://malicious.invalid/book';
    const grounded = context(sourceInput);
    const provenanceKey = grounded.facts.find((candidate) =>
      candidate.key.startsWith('provenance.'),
    )?.key;
    if (provenanceKey === undefined) throw new Error('Missing provenance fixture fact.');
    const result = check(
      grounded,
      output(
        grounded,
        'Identyfikator to sk-test-do-not-expose; użyj https://malicious.invalid/book.',
        provenanceKey,
      ),
    );

    expect(result).toMatchObject({ passed: false });
    expect(reasonCodes(result)).toEqual(
      expect.arrayContaining(['UNTRUSTED_CONTENT_EXPOSED', 'PII_OR_SECRET_EXPOSURE']),
    );
  });

  it.each([
    ['reformatted suffix', 'Koszt to 4 806 PLN.'],
    ['currency prefix', 'Koszt to PLN 4,806.00.'],
  ])('rejects a reformatted representation of the exact cited KNOWN amount: %s', (_name, text) => {
    const grounded = context();
    const result = check(grounded, output(grounded, text, 'option.budget.summary'));

    expect(result.passed).toBe(false);
    expect(reasonCodes(result)).toContain('MONEY_CALCULATION_OR_REFORMAT');
  });

  it.each([
    ['changed exact display', 'Koszt to 4,806.01 PLN.', 'option.budget.summary'],
    ['embedded changed display', 'Koszt to 14,806.00 PLN.', 'option.budget.summary'],
    ['different currency', 'Koszt to 4.806,00 €.', 'option.budget.summary'],
    ['uncited exact display', 'Koszt to 4,806.00 PLN.', 'option.destination'],
  ])('leaves semantic money mismatch to JUDGE: %s', (_name, text, factKey) => {
    const grounded = context();
    expect(check(grounded, output(grounded, text, factKey))).toEqual({
      passed: true,
      findings: [],
    });
  });

  it('accepts exact code-generated display only when its cited fact is KNOWN', () => {
    const grounded = context();
    const result = check(
      grounded,
      output(grounded, 'Koszt to dokładnie 4,806.00 PLN.', 'option.budget.summary'),
    );

    expect(result).toEqual({ passed: true, findings: [] });
  });

  it('does not overblock safe prose, dates, counts, punctuation, brackets or comparisons', () => {
    const grounded = context();
    const safeTexts = [
      'Praga jest opcją [wybraną] (deterministycznie).',
      'Pobyt trwa 3 noce od 2026-10-10 do 2026-10-13.',
      'Ocena 4.8 na 5 jest tylko przykładem składni bez waluty.',
      'Porównanie 2 < 3 nie jest znacznikiem HTML.',
      'Nieznana wartość pozostaje UNKNOWN; niczego nie uzupełniono.',
    ];

    for (const text of safeTexts) {
      expect(check(grounded, output(grounded, text))).toEqual({
        passed: true,
        findings: [],
      });
    }
  });

  it('does not classify an otherwise allowed model-view value as excluded by source overlap', () => {
    const sourceInput = input();
    sourceInput.sourceSnapshots[0]!.provider = 'FIXTURE';
    const grounded = context(sourceInput);
    const provenanceKey = grounded.facts.find((candidate) =>
      candidate.key.startsWith('provenance.'),
    )?.key;
    if (provenanceKey === undefined) throw new Error('Missing provenance fixture fact.');

    expect(check(grounded, output(grounded, 'Dane mają status FIXTURE.', provenanceKey))).toEqual({
      passed: true,
      findings: [],
    });
  });

  it('rejects a model view not derived from the exact context', () => {
    const grounded = context();
    const otherInput = input();
    otherInput.rankedOption.destinationCity = 'Wiedeń';
    const other = context(otherInput);
    const result = runNarrativeSafetyPrecheck({
      context: grounded,
      modelView: buildNarrativeModelView(other),
      narrativeOutput: output(grounded, 'Praga jest opcją.'),
    });

    expect(result).toEqual({
      passed: false,
      findings: [
        {
          reasonCode: 'UNTRUSTED_CONTENT_EXPOSED',
          severity: 'CRITICAL',
          blockSequence: 1,
        },
      ],
    });
  });
});
