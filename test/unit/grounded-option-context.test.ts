import { describe, expect, it } from 'vitest';
import {
  GROUNDED_OPTION_CONTEXT_VERSION,
  buildGroundedOptionContext,
  type GroundedOptionContextInput,
} from '../../srv/narratives/grounded-option-context.ts';
import { groundedOptionContextInput } from '../fixtures/grounded-option.ts';

function contextInput(): GroundedOptionContextInput {
  return structuredClone(groundedOptionContextInput);
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
      '20f205d1f25daa91137ccdada783de09372290858a54c3cc49f9d759473ded37',
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

    const context = buildGroundedOptionContext(input);
    const unknown = context.facts.find((fact) => fact.key === 'option.budget.category.FOOD');
    const missing = context.facts.find((fact) => fact.key === 'option.budget.category.ATTRACTIONS');

    expect(unknown).toMatchObject({
      status: 'UNKNOWN',
      value: {
        amountMinor: null,
        classification: 'UNKNOWN',
        priceType: 'UNKNOWN',
      },
    });
    expect(missing).toMatchObject({ status: 'MISSING', value: null, sourceSnapshotIds: [] });
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
});
