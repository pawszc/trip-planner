import { describe, expect, it } from 'vitest';
import {
  calculateBinaryClassMetrics,
  calculateEndToEndMetrics,
  calculatePercentDelta,
  calculateSemanticQualityMetrics,
  calculateStabilityMetrics,
  evaluateEndToEndGates,
  evaluateRegressionAgainstBaseline,
  evaluateSemanticGates,
  evaluateStabilityGates,
  type SemanticCaseOutcome,
} from '../../srv/evals/metrics.ts';
import {
  frozenNarrativeQualityDataset,
  passingEndToEndOutcome,
  perfectSemanticOutcome,
} from './eval-fixtures.ts';

function perfectOutcomes(): SemanticCaseOutcome[] {
  return frozenNarrativeQualityDataset().cases.map(perfectSemanticOutcome);
}

function rejectOutcome(caseId: string): SemanticCaseOutcome {
  return {
    caseId,
    actualDecision: 'REJECT',
    actualStage: 'JUDGE',
    failedDimensions: ['FACTUAL_ENTAILMENT'],
    reasonCodes: ['UNSUPPORTED_CLAIM'],
    strictJudgeOutputValid: true,
  };
}

function falseAccept(outcomes: SemanticCaseOutcome[], caseId: string): void {
  const index = outcomes.findIndex((outcome) => outcome.caseId === caseId);
  outcomes[index] = {
    caseId,
    actualDecision: 'PUBLISH',
    actualStage: 'JUDGE',
    failedDimensions: [],
    reasonCodes: [],
    strictJudgeOutputValid: true,
  };
}

describe('narrative-quality semantic metrics', () => {
  it('calculates a hand-checked confusion matrix, precision, recall and F1', () => {
    const metrics = calculateBinaryClassMetrics(
      [true, true, false, false],
      [true, false, true, false],
    );

    expect(metrics.confusion).toEqual({
      truePositive: 1,
      falsePositive: 1,
      falseNegative: 1,
      trueNegative: 1,
    });
    expect(metrics.precision).toEqual({ numerator: 1, denominator: 2, value: 0.5 });
    expect(metrics.recall).toEqual({ numerator: 1, denominator: 2, value: 0.5 });
    expect(metrics.f1).toEqual({ numerator: 2, denominator: 4, value: 0.5 });
  });

  it('passes a perfect golden result and applies the versioned empty-dimension convention', () => {
    const dataset = frozenNarrativeQualityDataset();
    const metrics = calculateSemanticQualityMetrics(dataset, perfectOutcomes());

    expect(metrics.accuracy).toMatchObject({ numerator: 32, denominator: 32, value: 1 });
    expect(metrics.reject.recall).toMatchObject({ numerator: 20, denominator: 20 });
    expect(metrics.publish.recall).toMatchObject({ numerator: 12, denominator: 12 });
    expect(metrics.macroF1).toBe(1);
    expect(metrics.dimensionMacroF1).toBe(1);
    expect(metrics.dimensionMacroF1ConventionVersion).toBe(
      'dimension-fail-positive-empty-agreement-one-v1',
    );
    expect(metrics.dimensions.RELEVANCE_AND_BLOCK_KIND.f1).toEqual({
      numerator: 1,
      denominator: 1,
      value: 1,
    });
    expect(evaluateSemanticGates(metrics)).toEqual({ passed: true, failures: [] });
  });

  it('accepts the exact 19/20 reject-recall threshold without rounding', () => {
    const dataset = frozenNarrativeQualityDataset();
    const outcomes = perfectOutcomes();
    falseAccept(outcomes, 'R01');
    const metrics = calculateSemanticQualityMetrics(dataset, outcomes);

    expect(metrics.reject.recall).toMatchObject({ numerator: 19, denominator: 20 });
    expect(evaluateSemanticGates(metrics).failures).not.toContain('REJECT_RECALL');
  });

  it('fails below reject recall even though binary accuracy remains exactly 30/32', () => {
    const dataset = frozenNarrativeQualityDataset();
    const outcomes = perfectOutcomes();
    falseAccept(outcomes, 'R01');
    falseAccept(outcomes, 'R05');
    const metrics = calculateSemanticQualityMetrics(dataset, outcomes);

    expect(metrics.accuracy).toMatchObject({ numerator: 30, denominator: 32 });
    expect(metrics.reject.recall).toMatchObject({ numerator: 18, denominator: 20 });
    expect(evaluateSemanticGates(metrics).failures).toContain('REJECT_RECALL');
  });

  it('never lets an average mask one critical false accept', () => {
    const dataset = frozenNarrativeQualityDataset();
    const outcomes = perfectOutcomes();
    falseAccept(outcomes, 'R02');
    const gates = evaluateSemanticGates(calculateSemanticQualityMetrics(dataset, outcomes));

    expect(gates.failures).toContain('CRITICAL_FALSE_ACCEPTS');
    expect(gates.failures).toContain('CRITICAL_REASON_CODE_RECALL');
  });

  it('requires strict judge-output validity for every attempted judge call', () => {
    const dataset = frozenNarrativeQualityDataset();
    const outcomes = perfectOutcomes();
    const index = outcomes.findIndex(({ caseId }) => caseId === 'R01');
    outcomes[index] = { ...outcomes[index]!, strictJudgeOutputValid: false };
    const metrics = calculateSemanticQualityMetrics(dataset, outcomes);

    expect(metrics.strictJudgeOutputValidity).toMatchObject({ numerator: 29, denominator: 30 });
    expect(evaluateSemanticGates(metrics).failures).toContain('STRICT_JUDGE_OUTPUT_VALIDITY');
  });

  it('rejects duplicate or incomplete outcome membership', () => {
    const dataset = frozenNarrativeQualityDataset();
    const outcomes = perfectOutcomes();
    outcomes[1] = outcomes[0]!;

    expect(() => calculateSemanticQualityMetrics(dataset, outcomes)).toThrowError(
      expect.objectContaining({ code: 'INVALID_EVAL_INPUT' }),
    );
  });

  it('enforces the 11/12 clean-publish boundary', () => {
    const dataset = frozenNarrativeQualityDataset();
    const oneMiss = perfectOutcomes();
    oneMiss[0] = rejectOutcome('P01');
    const atBoundary = calculateSemanticQualityMetrics(dataset, oneMiss);
    expect(atBoundary.publish.recall).toMatchObject({ numerator: 11, denominator: 12 });
    expect(evaluateSemanticGates(atBoundary).failures).not.toContain('CLEAN_PUBLISH_RECALL');

    const twoMisses = [...oneMiss];
    twoMisses[1] = rejectOutcome('P02');
    expect(
      evaluateSemanticGates(calculateSemanticQualityMetrics(dataset, twoMisses)).failures,
    ).toContain('CLEAN_PUBLISH_RECALL');
  });
});

describe('narrative-quality stability, E2E, deltas and regression', () => {
  it('passes exactly 7/8 stability agreement but fails any critical false accept across runs', () => {
    const dataset = frozenNarrativeQualityDataset();
    const primary = perfectOutcomes();
    const repeated = dataset.cases.filter(({ sentinel }) => sentinel).map(perfectSemanticOutcome);
    repeated[0] = rejectOutcome(repeated[0]!.caseId);
    const boundary = calculateStabilityMetrics(dataset, primary, repeated);
    expect(boundary.exactDecisionAgreement).toMatchObject({ numerator: 7, denominator: 8 });
    expect(evaluateStabilityGates(boundary)).toEqual({ passed: true, failures: [] });

    const criticalIndex = repeated.findIndex(({ caseId }) => caseId === 'R07');
    repeated[criticalIndex] = {
      caseId: 'R07',
      actualDecision: 'PUBLISH',
      actualStage: 'JUDGE',
      failedDimensions: [],
      reasonCodes: [],
      strictJudgeOutputValid: true,
    };
    expect(
      evaluateStabilityGates(calculateStabilityMetrics(dataset, primary, repeated)).failures,
    ).toContain('CRITICAL_FALSE_ACCEPT');
  });

  it('enforces all four synthetic E2E gates and the 3/4 publication boundary', () => {
    const dataset = frozenNarrativeQualityDataset();
    const outcomes = dataset.endToEndCases.map(({ id }) => passingEndToEndOutcome(id));
    outcomes[3] = { ...outcomes[3]!, actualDecision: 'REJECT' };
    const metrics = calculateEndToEndMetrics(dataset, outcomes);

    expect(metrics.locallyValidCandidates).toMatchObject({ numerator: 4, denominator: 4 });
    expect(metrics.published).toMatchObject({ numerator: 3, denominator: 4 });
    expect(evaluateEndToEndGates(metrics)).toEqual({ passed: true, failures: [] });

    outcomes[2] = { ...outcomes[2]!, actualDecision: 'REJECT' };
    expect(evaluateEndToEndGates(calculateEndToEndMetrics(dataset, outcomes)).failures).toContain(
      'PUBLICATION_COUNT',
    );
  });

  it('fails E2E adversarial propagation, critical publication, audit linkage and mutation separately', () => {
    const dataset = frozenNarrativeQualityDataset();
    const outcomes = dataset.endToEndCases.map(({ id }) => passingEndToEndOutcome(id));
    outcomes[0] = { ...outcomes[0]!, criticalNarrativePublished: true };
    outcomes[1] = { ...outcomes[1]!, generateAuditSucceeded: false };
    outcomes[2] = { ...outcomes[2]!, deterministicStateUnchanged: false };
    outcomes[3] = { ...outcomes[3]!, adversarialPayloadPropagated: true };

    expect(evaluateEndToEndGates(calculateEndToEndMetrics(dataset, outcomes)).failures).toEqual([
      'CRITICAL_PUBLICATION',
      'ADVERSARIAL_PROPAGATION',
      'AUDIT_OR_REVIEW_LINKAGE',
      'DETERMINISTIC_STATE_MUTATION',
    ]);
  });

  it('reports exact percent deltas and warns only above, not at, 25 percent', () => {
    expect(calculatePercentDelta(125, 100)).toEqual({
      baseline: 100,
      current: 125,
      percent: 25,
      increaseAbove25Percent: false,
    });
    expect(calculatePercentDelta(126, 100).increaseAbove25Percent).toBe(true);
    expect(calculatePercentDelta(1, 0)).toMatchObject({
      percent: null,
      increaseAbove25Percent: true,
    });
    expect(calculatePercentDelta(0, 0)).toMatchObject({
      percent: 0,
      increaseAbove25Percent: false,
    });
  });

  it('allows at most one newly incorrect non-critical case against an accepted baseline', () => {
    const dataset = frozenNarrativeQualityDataset();
    const baseline = calculateSemanticQualityMetrics(dataset, perfectOutcomes());
    const oneRegression = perfectOutcomes();
    falseAccept(oneRegression, 'R01');
    expect(
      evaluateRegressionAgainstBaseline(
        dataset,
        baseline,
        calculateSemanticQualityMetrics(dataset, oneRegression),
      ).passed,
    ).toBe(true);

    const twoRegressions = [...oneRegression];
    falseAccept(twoRegressions, 'R05');
    const result = evaluateRegressionAgainstBaseline(
      dataset,
      baseline,
      calculateSemanticQualityMetrics(dataset, twoRegressions),
      { latencyP95: calculatePercentDelta(126, 100) },
    );
    expect(result.passed).toBe(false);
    expect(result.newlyIncorrectNonCriticalCaseIds).toEqual(['R01', 'R05']);
    expect(result.warnings).toEqual(['latencyP95 increased by more than 25%.']);
  });
});
