import { describe, expect, it } from 'vitest';
import {
  GROUNDED_OPTION_CONTEXT_VERSION,
  buildGroundedOptionContext,
  type GroundedOptionContextInput,
} from '../../srv/narratives/grounded-option-context.ts';
import {
  formatGroundedMoney,
  GROUNDED_MONEY_DISPLAY_VERSION,
} from '../../srv/narratives/grounded-money-display.ts';
import { groundedOptionContextInput } from '../fixtures/grounded-option.ts';

function contextInput(): GroundedOptionContextInput {
  return structuredClone(groundedOptionContextInput);
}

function removeSourceContext(input: GroundedOptionContextInput, removedContext: string): void {
  for (const source of input.sourceSnapshots) {
    source.contexts = source.contexts
      .split(',')
      .map((context) => context.trim())
      .filter((context) => context !== removedContext)
      .join(', ');
  }
}

describe('GroundedOptionContext', () => {
  it('builds the exact versioned context deterministically with unique context-bound fact IDs', () => {
    const first = buildGroundedOptionContext(contextInput());
    const second = buildGroundedOptionContext(contextInput());

    expect(second).toEqual(first);
    expect(first).toMatchObject({
      version: GROUNDED_OPTION_CONTEXT_VERSION,
      planningRun: {
        id: groundedOptionContextInput.planningRun.ID,
        requestFingerprint: groundedOptionContextInput.planningRun.requestFingerprint,
        providerFixtureVersion: 'europe-reference-v1',
        engineVersion: 'candidate-engine-v1',
        scoringVersion: 'candidate-score-v1:selection-v1',
      },
      rankedOption: {
        id: groundedOptionContextInput.rankedOption.ID,
        rank: 1,
        role: 'BEST_OVERALL',
      },
    });
    expect(first.fingerprint).toBe(
      '5a7f35d57f09e6e57a1032b28df4bd59075b4e391eeb8a11f81ca09baf284bfb',
    );
    expect(first.facts.map((fact) => fact.key)).toEqual([
      'option.accommodation',
      'option.budget.category.ACCOMMODATION',
      'option.budget.category.ADDITIONAL_FEES',
      'option.budget.category.ATTRACTIONS',
      'option.budget.category.BUFFER',
      'option.budget.category.FOOD',
      'option.budget.category.LOCAL_TRANSPORT',
      'option.budget.category.TRANSPORT',
      'option.budget.summary',
      'option.destination',
      'option.score',
      'option.selection',
      'option.transport',
      'provenance.fixture:prague-option',
    ]);
    expect(first.facts).toHaveLength(14);
    expect(new Set(first.facts.map((fact) => fact.factId)).size).toBe(14);
    expect(first.facts.every((fact) => /^fact_[0-9a-f]{64}$/.test(fact.factId))).toBe(true);

    const transport = first.facts.find((fact) => fact.key === 'option.transport');
    const accommodation = first.facts.find((fact) => fact.key === 'option.accommodation');
    const budget = first.facts.find((fact) => fact.key === 'option.budget.summary');
    const score = first.facts.find((fact) => fact.key === 'option.score');
    expect(transport).toMatchObject({
      sourceSnapshotIds: ['40000000-0000-4000-8000-000000000001'],
      internalDerivation: null,
    });
    expect(accommodation).toMatchObject({
      sourceSnapshotIds: ['40000000-0000-4000-8000-000000000001'],
      internalDerivation: null,
    });
    expect(
      [...(transport?.sourceSnapshotIds ?? []), ...(accommodation?.sourceSnapshotIds ?? [])].every(
        (sourceId) => first.sourceSnapshots.some((source) => source.id === sourceId),
      ),
    ).toBe(true);
    expect(budget).toMatchObject({
      sourceSnapshotIds: [],
      internalDerivation: {
        kind: 'INTERNAL_DETERMINISTIC',
        version: `candidate-engine-v1:${GROUNDED_MONEY_DISPLAY_VERSION}`,
      },
      value: {
        moneyDisplayVersion: GROUNDED_MONEY_DISPLAY_VERSION,
        budgetLimitMinor: '600000',
        budgetLimitDisplay: '6,000.00 PLN',
        confirmedAmountMinor: '218000',
        confirmedAmountDisplay: '2,180.00 PLN',
        estimatedAmountMinor: '168000',
        estimatedAmountDisplay: '1,680.00 PLN',
        totalAmountMinor: '424600',
        totalAmountDisplay: '4,246.00 PLN',
        costPerPersonMinor: '212300',
        costPerPersonDisplay: '2,123.00 PLN',
        remainingBudgetMinor: '175400',
        remainingBudgetDisplay: '1,754.00 PLN',
      },
    });
    expect(score).toMatchObject({
      sourceSnapshotIds: [],
      internalDerivation: {
        kind: 'INTERNAL_DETERMINISTIC',
        version: 'candidate-score-v1:selection-v1',
      },
    });
  });

  it('formats currency precision deterministically in code without floating-point money', () => {
    expect(formatGroundedMoney('123456', 'PLN', 'test.pln')).toBe('1,234.56 PLN');
    expect(formatGroundedMoney('1234', 'JPY', 'test.jpy')).toBe('1,234 JPY');
    expect(formatGroundedMoney('1234', 'KWD', 'test.kwd')).toBe('1.234 KWD');
    expect(formatGroundedMoney('-45', 'PLN', 'test.negative')).toBe('-0.45 PLN');
    expect(formatGroundedMoney(null, 'PLN', 'test.unknown')).toBeNull();
  });

  it('changes the fingerprint and every fact ID when the exact context changes', () => {
    const first = buildGroundedOptionContext(contextInput());
    const changedInput = contextInput();
    changedInput.rankedOption.destinationCity = 'Wiedeń';
    const changed = buildGroundedOptionContext(changedInput);

    expect(changed.fingerprint).not.toBe(first.fingerprint);
    expect(new Set(first.facts.map((fact) => fact.factId))).not.toContain(changed.facts[0]?.factId);
    expect(changed.facts.map((fact) => fact.factId)).not.toEqual(
      first.facts.map((fact) => fact.factId),
    );
  });

  it('binds the fingerprint and fact IDs to the explicit context version', () => {
    const first = buildGroundedOptionContext(contextInput());
    const versionedInput = contextInput();
    versionedInput.contextVersion = 'grounded-option-context-v2-test';
    const versioned = buildGroundedOptionContext(versionedInput);

    expect(versioned.version).toBe('grounded-option-context-v2-test');
    expect(versioned.fingerprint).not.toBe(first.fingerprint);
    expect(versioned.facts.map((fact) => fact.factId)).not.toEqual(
      first.facts.map((fact) => fact.factId),
    );
  });

  it('keeps UNKNOWN and missing budget positions explicit and gives each a fact ID', () => {
    const input = contextInput();
    const food = input.budgetItems.find((item) => item.category === 'FOOD');
    if (food === undefined) throw new Error('The fixture must contain FOOD.');
    food.classification = 'UNKNOWN';
    food.priceType = 'UNKNOWN';
    food.amountMinor = null;
    input.budgetItems = input.budgetItems.filter((item) => item.category !== 'ATTRACTIONS');
    removeSourceContext(input, 'BUDGET:ATTRACTIONS');

    const context = buildGroundedOptionContext(input);
    const unknown = context.facts.find((fact) => fact.key === 'option.budget.category.FOOD');
    const missing = context.facts.find((fact) => fact.key === 'option.budget.category.ATTRACTIONS');

    expect(unknown).toMatchObject({
      status: 'UNKNOWN',
      value: {
        amountMinor: null,
        amountDisplay: null,
        moneyDisplayVersion: GROUNDED_MONEY_DISPLAY_VERSION,
        classification: 'UNKNOWN',
        priceType: 'UNKNOWN',
      },
    });
    expect(missing).toMatchObject({
      status: 'MISSING',
      value: null,
      sourceSnapshotIds: [],
      internalDerivation: null,
    });
    expect(unknown?.factId).toMatch(/^fact_[0-9a-f]{64}$/);
    expect(missing?.factId).toMatch(/^fact_[0-9a-f]{64}$/);
  });

  it('rejects records linked to another planning context instead of silently dropping them', () => {
    const input = contextInput();
    input.budgetItems[0]!.planningRun_ID = 'different-planning-run';

    expect(() => buildGroundedOptionContext(input)).toThrowError(
      expect.objectContaining({ code: 'INVALID_GROUNDED_OPTION_CONTEXT' }),
    );
  });

  it('fails closed when external provenance is dangling', () => {
    const input = contextInput();
    removeSourceContext(input, 'TRANSPORT_FACT');

    expect(() => buildGroundedOptionContext(input)).toThrowError(
      expect.objectContaining({ code: 'INVALID_GROUNDED_OPTION_CONTEXT' }),
    );
  });

  it('fails closed when external provenance is ambiguous', () => {
    const input = contextInput();
    input.sourceSnapshots = [
      ...input.sourceSnapshots,
      {
        ...input.sourceSnapshots[0]!,
        ID: '40000000-0000-4000-8000-000000000002',
        sourceKey: 'fixture:ambiguous-transport',
        externalItemId: 'ambiguous-transport',
        contexts: 'TRANSPORT_FACT',
      },
    ];

    expect(() => buildGroundedOptionContext(input)).toThrowError(
      expect.objectContaining({ code: 'INVALID_GROUNDED_OPTION_CONTEXT' }),
    );
  });
});
