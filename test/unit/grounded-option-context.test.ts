import { describe, expect, it } from 'vitest';
import { CURRENCY_CONTRACT_VERSION } from '../../srv/domain/currency.ts';
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

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

function makeIncompleteBudget(input: GroundedOptionContextInput): void {
  const food = input.budgetItems.find((item) => item.category === 'FOOD');
  if (food === undefined) throw new Error('The fixture must contain FOOD.');
  food.classification = 'UNKNOWN';
  food.priceType = 'UNKNOWN';
  food.amountMinor = null;
  input.budgetItems = input.budgetItems.filter((item) => item.category !== 'ATTRACTIONS');
  removeSourceContext(input, 'BUDGET:ATTRACTIONS');
  input.rankedOption.confirmedAmountMinor = '218000';
  input.rankedOption.estimatedAmountMinor = '70600';
  input.rankedOption.unknownCategoryCount = 2;
  input.rankedOption.totalAmountMinor = null;
  input.rankedOption.costPerPersonMinor = null;
  input.rankedOption.remainingBudgetMinor = null;
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
        currencyContractVersion: CURRENCY_CONTRACT_VERSION,
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
      '47285ff5164a6534f1cf01a2c54dd1c88d92f1945fd796ff3482adab0b5869ae',
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
        version: `candidate-engine-v1:${GROUNDED_MONEY_DISPLAY_VERSION}:${CURRENCY_CONTRACT_VERSION}`,
      },
      value: {
        currencyContractVersion: CURRENCY_CONTRACT_VERSION,
        moneyDisplayVersion: GROUNDED_MONEY_DISPLAY_VERSION,
        budgetLimitMinor: '600000',
        budgetLimitDisplay: '6,000.00 PLN',
        confirmedAmountMinor: '218000',
        confirmedAmountDisplay: '2,180.00 PLN',
        estimatedAmountMinor: '262600',
        estimatedAmountDisplay: '2,626.00 PLN',
        totalAmountMinor: '480600',
        totalAmountDisplay: '4,806.00 PLN',
        costPerPersonMinor: '240300',
        costPerPersonDisplay: '2,403.00 PLN',
        remainingBudgetMinor: '119400',
        remainingBudgetDisplay: '1,194.00 PLN',
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
    expect(formatGroundedMoney('123456', 'EUR', 'test.eur')).toBe('1,234.56 EUR');
    expect(formatGroundedMoney('-45', 'PLN', 'test.negative')).toBe('-0.45 PLN');
    expect(formatGroundedMoney(null, 'PLN', 'test.unknown')).toBeNull();
    for (const currency of ['JPY', 'KWD', 'USD', 'ZZZ']) {
      expect(() => formatGroundedMoney('1234', currency, `test.${currency}`)).toThrowError(
        expect.objectContaining({ code: 'INVALID_GROUNDED_OPTION_CONTEXT' }),
      );
      expect(() => formatGroundedMoney(null, currency, `test.${currency}.unknown`)).toThrowError(
        expect.objectContaining({ code: 'INVALID_GROUNDED_OPTION_CONTEXT' }),
      );
    }
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
    makeIncompleteBudget(input);

    const context = buildGroundedOptionContext(input);
    const unknown = context.facts.find((fact) => fact.key === 'option.budget.category.FOOD');
    const missing = context.facts.find((fact) => fact.key === 'option.budget.category.ATTRACTIONS');
    const summary = context.facts.find((fact) => fact.key === 'option.budget.summary');

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
    expect(summary).toMatchObject({
      status: 'MISSING',
      value: {
        confirmedAmountMinor: '218000',
        estimatedAmountMinor: '70600',
        unknownCategoryCount: 2,
        totalAmountMinor: null,
        totalAmountDisplay: null,
        costPerPersonMinor: null,
        costPerPersonDisplay: null,
        remainingBudgetMinor: null,
        remainingBudgetDisplay: null,
      },
    });
    expect(unknown?.factId).toMatch(/^fact_[0-9a-f]{64}$/);
    expect(missing?.factId).toMatch(/^fact_[0-9a-f]{64}$/);
  });

  it('keeps complete category facts and the aggregate financially self-consistent', () => {
    const input = contextInput();
    const context = buildGroundedOptionContext(input);
    const categoryFacts = context.facts.filter((fact) =>
      fact.key.startsWith('option.budget.category.'),
    );
    const summary = context.facts.find((fact) => fact.key === 'option.budget.summary');

    expect(categoryFacts).toHaveLength(7);
    expect(categoryFacts.every((fact) => fact.status === 'KNOWN')).toBe(true);
    expect(
      categoryFacts.every(
        (fact) =>
          isRecord(fact.value) &&
          fact.value.currency === 'PLN' &&
          fact.value.currencyContractVersion === CURRENCY_CONTRACT_VERSION,
      ),
    ).toBe(true);
    expect(
      input.budgetItems.every((item) =>
        item.priceType === 'ESTIMATE'
          ? item.classification === 'ESTIMATED'
          : item.classification === 'CONFIRMED',
      ),
    ).toBe(true);

    const confirmed = input.budgetItems
      .filter((item) => item.classification === 'CONFIRMED')
      .reduce((sum, item) => sum + BigInt(String(item.amountMinor)), 0n);
    const estimated = input.budgetItems
      .filter((item) => item.classification === 'ESTIMATED')
      .reduce((sum, item) => sum + BigInt(String(item.amountMinor)), 0n);
    expect(summary).toMatchObject({
      status: 'KNOWN',
      value: {
        confirmedAmountMinor: confirmed.toString(),
        estimatedAmountMinor: estimated.toString(),
        unknownCategoryCount: 0,
        totalAmountMinor: (confirmed + estimated).toString(),
        costPerPersonMinor: ((confirmed + estimated + 1n) / 2n).toString(),
        remainingBudgetMinor: (600_000n - confirmed - estimated).toString(),
      },
    });
  });

  it('marks an otherwise complete budget UNKNOWN and nulls complete aggregates', () => {
    const input = contextInput();
    const food = input.budgetItems.find((item) => item.category === 'FOOD');
    if (food === undefined) throw new Error('The fixture must contain FOOD.');
    food.priceType = 'UNKNOWN';
    food.classification = 'UNKNOWN';
    food.amountMinor = null;
    input.rankedOption.estimatedAmountMinor = '134600';
    input.rankedOption.unknownCategoryCount = 1;
    input.rankedOption.totalAmountMinor = null;
    input.rankedOption.costPerPersonMinor = null;
    input.rankedOption.remainingBudgetMinor = null;

    const summary = buildGroundedOptionContext(input).facts.find(
      (fact) => fact.key === 'option.budget.summary',
    );
    expect(summary).toMatchObject({
      status: 'UNKNOWN',
      value: {
        estimatedAmountMinor: '134600',
        unknownCategoryCount: 1,
        totalAmountMinor: null,
        costPerPersonMinor: null,
        remainingBudgetMinor: null,
      },
    });
  });

  it.each([
    [
      'category arithmetic',
      (input: GroundedOptionContextInput) => {
        input.rankedOption.confirmedAmountMinor = '218001';
      },
    ],
    [
      'cost-per-person arithmetic',
      (input: GroundedOptionContextInput) => {
        input.rankedOption.costPerPersonMinor = '240301';
      },
    ],
    [
      'remaining-budget arithmetic',
      (input: GroundedOptionContextInput) => {
        input.rankedOption.remainingBudgetMinor = '119401';
      },
    ],
    [
      'price classification',
      (input: GroundedOptionContextInput) => {
        input.budgetItems[3]!.classification = 'CONFIRMED';
      },
    ],
    [
      'category currency',
      (input: GroundedOptionContextInput) => {
        input.budgetItems[3]!.currency = 'EUR';
      },
    ],
    [
      'known aggregates beside UNKNOWN',
      (input: GroundedOptionContextInput) => {
        const food = input.budgetItems.find((item) => item.category === 'FOOD')!;
        food.priceType = 'UNKNOWN';
        food.classification = 'UNKNOWN';
        food.amountMinor = null;
        input.rankedOption.estimatedAmountMinor = '134600';
        input.rankedOption.unknownCategoryCount = 1;
      },
    ],
    [
      'incorrect incomplete count',
      (input: GroundedOptionContextInput) => {
        makeIncompleteBudget(input);
        input.rankedOption.unknownCategoryCount = 1;
      },
    ],
    [
      'request budget limit',
      (input: GroundedOptionContextInput) => {
        input.tripRequest.totalBudget = '6000.01';
      },
    ],
  ])('fails closed for inconsistent grounded budget %s', (_case, corrupt) => {
    const input = contextInput();
    corrupt(input);
    expect(() => buildGroundedOptionContext(input)).toThrowError(
      expect.objectContaining({ code: 'INVALID_GROUNDED_OPTION_CONTEXT' }),
    );
  });

  it.each([
    [
      'empty PlanningRun provider fixture version',
      (input: GroundedOptionContextInput) => {
        input.planningRun.providerFixtureVersion = ' ';
      },
    ],
    [
      'RankedOption provider fixture version',
      (input: GroundedOptionContextInput) => {
        input.rankedOption.providerFixtureVersion = 'other-fixture';
      },
    ],
    [
      'BudgetItem provider fixture version',
      (input: GroundedOptionContextInput) => {
        input.budgetItems[0]!.providerFixtureVersion = 'other-fixture';
      },
    ],
    [
      'SourceSnapshot provider fixture version',
      (input: GroundedOptionContextInput) => {
        input.sourceSnapshots[0]!.providerFixtureVersion = 'other-fixture';
      },
    ],
    [
      'empty PlanningRun scoring version',
      (input: GroundedOptionContextInput) => {
        input.planningRun.scoringVersion = ' ';
      },
    ],
    [
      'RankedOption scoring version',
      (input: GroundedOptionContextInput) => {
        input.rankedOption.scoringVersion = 'other-score';
      },
    ],
    [
      'BudgetItem scoring version',
      (input: GroundedOptionContextInput) => {
        input.budgetItems[0]!.scoringVersion = 'other-score';
      },
    ],
    [
      'SourceSnapshot scoring version',
      (input: GroundedOptionContextInput) => {
        input.sourceSnapshots[0]!.scoringVersion = 'other-score';
      },
    ],
  ])('fails closed for inconsistent version lineage: %s', (_case, corrupt) => {
    const input = contextInput();
    corrupt(input);
    expect(() => buildGroundedOptionContext(input)).toThrowError(
      expect.objectContaining({ code: 'INVALID_GROUNDED_OPTION_CONTEXT' }),
    );
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
