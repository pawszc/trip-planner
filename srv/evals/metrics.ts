import {
  EvalContractError,
  NARRATIVE_QUALITY_DIMENSIONS,
  NARRATIVE_QUALITY_REASON_CODES,
  NARRATIVE_QUALITY_SENTINEL_CASE_IDS,
  validateNarrativeQualityDatasetContract,
  type NarrativeDecision,
  type NarrativeEvaluationStage,
  type NarrativeQualityDataset,
  type NarrativeQualityDimension,
  type NarrativeQualityReasonCode,
} from './dataset.ts';
import {
  validateNarrativeE2eRequiredPropertyResults,
  type NARRATIVE_E2E_REQUIRED_PROPERTY_CATALOG_VERSION,
  type NarrativeE2eRequiredPropertyResult,
} from './required-properties.ts';

export const DIMENSION_MACRO_F1_CONVENTION_VERSION =
  'dimension-fail-positive-empty-agreement-one-v1';

/**
 * Each dimension is an independent binary classifier with FAIL as the positive class. Its F1 is
 * `2TP / (2TP + FP + FN)`. When expected and actual contain no FAIL for a dimension, its F1 is
 * defined as 1 because the all-PASS classification agrees exactly. The final score is the
 * unweighted arithmetic mean across all eight contract dimensions.
 */
export const DIMENSION_MACRO_F1_CONVENTION = Object.freeze({
  version: DIMENSION_MACRO_F1_CONVENTION_VERSION,
  positiveClass: 'FAIL' as const,
  emptyPositiveAgreementF1: 1 as const,
  dimensionCount: 8 as const,
});

export interface MetricRatio {
  readonly numerator: number;
  readonly denominator: number;
  readonly value: number;
}

export interface BinaryConfusionMatrix {
  readonly truePositive: number;
  readonly falsePositive: number;
  readonly falseNegative: number;
  readonly trueNegative: number;
}

export interface BinaryClassMetrics {
  readonly confusion: BinaryConfusionMatrix;
  readonly precision: MetricRatio;
  readonly recall: MetricRatio;
  readonly f1: MetricRatio;
}

export interface SemanticCaseOutcome {
  readonly caseId: string;
  readonly actualDecision: NarrativeDecision;
  readonly actualStage: NarrativeEvaluationStage;
  readonly failedDimensions: readonly NarrativeQualityDimension[];
  readonly reasonCodes: readonly NarrativeQualityReasonCode[];
  /** null means PRECHECK made zero JUDGE calls. */
  readonly strictJudgeOutputValid: boolean | null;
}

export interface SemanticQualityMetrics {
  readonly caseCount: number;
  readonly accuracy: MetricRatio;
  readonly publish: BinaryClassMetrics;
  readonly reject: BinaryClassMetrics;
  readonly macroF1: number;
  readonly dimensionMacroF1ConventionVersion: typeof DIMENSION_MACRO_F1_CONVENTION_VERSION;
  readonly dimensions: Readonly<Record<NarrativeQualityDimension, BinaryClassMetrics>>;
  readonly dimensionMacroF1: number;
  readonly criticalFalseAccepts: number;
  readonly criticalReasonCodeRecall: MetricRatio;
  readonly strictJudgeOutputValidity: MetricRatio;
  readonly correctCaseIds: readonly string[];
  readonly incorrectCaseIds: readonly string[];
}

export const SEMANTIC_GATE_THRESHOLDS = Object.freeze({
  criticalFalseAccepts: 0,
  rejectRecall: Object.freeze({ numerator: 19, denominator: 20 }),
  cleanPublishRecall: Object.freeze({ numerator: 11, denominator: 12 }),
  accuracy: Object.freeze({ numerator: 30, denominator: 32 }),
  macroF1: Object.freeze({ numerator: 9, denominator: 10 }),
  dimensionMacroF1: Object.freeze({ numerator: 4, denominator: 5 }),
  criticalReasonCodeRecall: Object.freeze({ numerator: 1, denominator: 1 }),
  strictJudgeOutputValidity: Object.freeze({ numerator: 1, denominator: 1 }),
});

export interface SemanticGateResult {
  readonly passed: boolean;
  readonly failures: readonly (
    | 'CRITICAL_FALSE_ACCEPTS'
    | 'REJECT_RECALL'
    | 'CLEAN_PUBLISH_RECALL'
    | 'ACCURACY'
    | 'MACRO_F1'
    | 'DIMENSION_MACRO_F1'
    | 'CRITICAL_REASON_CODE_RECALL'
    | 'STRICT_JUDGE_OUTPUT_VALIDITY'
  )[];
}

function ratio(numerator: number, denominator: number, emptyValue = 0): MetricRatio {
  if (
    !Number.isSafeInteger(numerator) ||
    !Number.isSafeInteger(denominator) ||
    numerator < 0 ||
    denominator < 0 ||
    numerator > denominator
  ) {
    throw new EvalContractError('INVALID_EVAL_INPUT', 'A metric ratio contains invalid counts.');
  }
  return {
    numerator,
    denominator,
    value: denominator === 0 ? emptyValue : numerator / denominator,
  };
}

function f1Ratio(confusion: BinaryConfusionMatrix): MetricRatio {
  const numerator = 2 * confusion.truePositive;
  const denominator = numerator + confusion.falsePositive + confusion.falseNegative;
  return ratio(denominator === 0 ? 1 : numerator, denominator === 0 ? 1 : denominator);
}

export function calculateBinaryClassMetrics(
  expectedPositive: readonly boolean[],
  actualPositive: readonly boolean[],
): BinaryClassMetrics {
  if (expectedPositive.length !== actualPositive.length) {
    throw new EvalContractError(
      'INVALID_EVAL_INPUT',
      'Expected and actual binary labels must have equal length.',
    );
  }
  let truePositive = 0;
  let falsePositive = 0;
  let falseNegative = 0;
  let trueNegative = 0;
  for (const [index, expected] of expectedPositive.entries()) {
    const actual = actualPositive[index];
    if (actual === undefined) {
      throw new EvalContractError('INVALID_EVAL_INPUT', 'A binary label is missing.');
    }
    if (expected && actual) truePositive += 1;
    else if (!expected && actual) falsePositive += 1;
    else if (expected && !actual) falseNegative += 1;
    else trueNegative += 1;
  }
  const confusion = { truePositive, falsePositive, falseNegative, trueNegative };
  return {
    confusion,
    precision: ratio(truePositive, truePositive + falsePositive, 1),
    recall: ratio(truePositive, truePositive + falseNegative, 1),
    f1: f1Ratio(confusion),
  };
}

function assertKnownUniqueValues<T extends string>(
  label: string,
  values: readonly T[],
  catalog: readonly T[],
): void {
  if (new Set(values).size !== values.length || values.some((value) => !catalog.includes(value))) {
    throw new EvalContractError('INVALID_EVAL_INPUT', `${label} must use unique catalog values.`);
  }
}

export function indexSemanticOutcomes(
  dataset: NarrativeQualityDataset,
  outcomes: readonly SemanticCaseOutcome[],
): ReadonlyMap<string, SemanticCaseOutcome> {
  validateNarrativeQualityDatasetContract(dataset);
  const expectedIds = dataset.cases.map(({ id }) => id);
  const byId = new Map<string, SemanticCaseOutcome>();
  for (const outcome of outcomes) {
    if (byId.has(outcome.caseId) || !expectedIds.includes(outcome.caseId)) {
      throw new EvalContractError(
        'INVALID_EVAL_INPUT',
        'Semantic outcomes must contain each exact dataset case once.',
      );
    }
    assertKnownUniqueValues(
      `Failed dimensions for ${outcome.caseId}`,
      outcome.failedDimensions,
      NARRATIVE_QUALITY_DIMENSIONS,
    );
    assertKnownUniqueValues(
      `Reason codes for ${outcome.caseId}`,
      outcome.reasonCodes,
      NARRATIVE_QUALITY_REASON_CODES,
    );
    if (
      (outcome.actualStage === 'PRECHECK' && outcome.strictJudgeOutputValid !== null) ||
      (outcome.actualStage === 'JUDGE' && outcome.strictJudgeOutputValid === null) ||
      (outcome.actualDecision === 'PUBLISH' &&
        (outcome.actualStage !== 'JUDGE' ||
          outcome.failedDimensions.length !== 0 ||
          outcome.reasonCodes.length !== 0 ||
          outcome.strictJudgeOutputValid !== true))
    ) {
      throw new EvalContractError(
        'INVALID_EVAL_INPUT',
        `Outcome ${outcome.caseId} violates the fail-closed publication contract.`,
      );
    }
    byId.set(outcome.caseId, outcome);
  }
  if (byId.size !== expectedIds.length || expectedIds.some((id) => !byId.has(id))) {
    throw new EvalContractError(
      'INVALID_EVAL_INPUT',
      'Semantic outcomes must contain all 32 exact dataset cases.',
    );
  }
  return byId;
}

function averageRatios(ratios: readonly MetricRatio[]): number {
  if (ratios.length === 0) {
    throw new EvalContractError('INVALID_EVAL_INPUT', 'A macro average needs components.');
  }
  return ratios.reduce((sum, component) => sum + component.value, 0) / ratios.length;
}

function ratioAtLeast(
  actual: MetricRatio,
  threshold: { readonly numerator: number; readonly denominator: number },
): boolean {
  if (actual.denominator === 0) return false;
  return (
    BigInt(actual.numerator) * BigInt(threshold.denominator) >=
    BigInt(actual.denominator) * BigInt(threshold.numerator)
  );
}

/** Exact comparison of an arithmetic mean of rational F1 values, with no rounding gate. */
function averageAtLeast(
  actual: readonly MetricRatio[],
  threshold: { readonly numerator: number; readonly denominator: number },
): boolean {
  if (actual.length === 0) return false;
  const commonDenominator = actual.reduce(
    (product, component) => product * BigInt(component.denominator),
    1n,
  );
  const sumNumerator = actual.reduce(
    (sum, component) =>
      sum + BigInt(component.numerator) * (commonDenominator / BigInt(component.denominator)),
    0n,
  );
  return (
    sumNumerator * BigInt(threshold.denominator) >=
    commonDenominator * BigInt(actual.length) * BigInt(threshold.numerator)
  );
}

export function calculateSemanticQualityMetrics(
  dataset: NarrativeQualityDataset,
  outcomes: readonly SemanticCaseOutcome[],
): SemanticQualityMetrics {
  const byId = indexSemanticOutcomes(dataset, outcomes);
  const ordered = dataset.cases.map((authored) => ({ authored, actual: byId.get(authored.id)! }));
  const expectedPublish = ordered.map(({ authored }) => authored.expected.decision === 'PUBLISH');
  const actualPublish = ordered.map(({ actual }) => actual.actualDecision === 'PUBLISH');
  const expectedReject = expectedPublish.map((value) => !value);
  const actualReject = actualPublish.map((value) => !value);
  const publish = calculateBinaryClassMetrics(expectedPublish, actualPublish);
  const reject = calculateBinaryClassMetrics(expectedReject, actualReject);
  const correctCaseIds = ordered
    .filter(({ authored, actual }) => authored.expected.decision === actual.actualDecision)
    .map(({ authored }) => authored.id);
  const incorrectCaseIds = ordered
    .filter(({ authored, actual }) => authored.expected.decision !== actual.actualDecision)
    .map(({ authored }) => authored.id);

  const dimensions = Object.fromEntries(
    NARRATIVE_QUALITY_DIMENSIONS.map((dimension) => [
      dimension,
      calculateBinaryClassMetrics(
        ordered.map(({ authored }) => authored.expected.failedDimensions.includes(dimension)),
        ordered.map(({ actual }) => actual.failedDimensions.includes(dimension)),
      ),
    ]),
  ) as unknown as Readonly<Record<NarrativeQualityDimension, BinaryClassMetrics>>;

  let requiredCriticalReasonCodes = 0;
  let foundCriticalReasonCodes = 0;
  for (const { authored, actual } of ordered) {
    if (!authored.expected.critical) continue;
    for (const reasonCode of authored.expected.requiredReasonCodes) {
      requiredCriticalReasonCodes += 1;
      if (actual.reasonCodes.includes(reasonCode)) foundCriticalReasonCodes += 1;
    }
  }
  const judged = ordered.filter(({ actual }) => actual.actualStage === 'JUDGE');
  const validJudgeOutputs = judged.filter(
    ({ actual }) => actual.strictJudgeOutputValid === true,
  ).length;
  const dimensionF1s = NARRATIVE_QUALITY_DIMENSIONS.map((dimension) => dimensions[dimension].f1);

  return {
    caseCount: ordered.length,
    accuracy: ratio(correctCaseIds.length, ordered.length),
    publish,
    reject,
    macroF1: averageRatios([publish.f1, reject.f1]),
    dimensionMacroF1ConventionVersion: DIMENSION_MACRO_F1_CONVENTION_VERSION,
    dimensions,
    dimensionMacroF1: averageRatios(dimensionF1s),
    criticalFalseAccepts: ordered.filter(
      ({ authored, actual }) => authored.expected.critical && actual.actualDecision === 'PUBLISH',
    ).length,
    criticalReasonCodeRecall: ratio(foundCriticalReasonCodes, requiredCriticalReasonCodes),
    strictJudgeOutputValidity: ratio(validJudgeOutputs, judged.length),
    correctCaseIds,
    incorrectCaseIds,
  };
}

export function evaluateSemanticGates(metrics: SemanticQualityMetrics): SemanticGateResult {
  const failures: SemanticGateResult['failures'][number][] = [];
  if (metrics.criticalFalseAccepts !== SEMANTIC_GATE_THRESHOLDS.criticalFalseAccepts)
    failures.push('CRITICAL_FALSE_ACCEPTS');
  if (!ratioAtLeast(metrics.reject.recall, SEMANTIC_GATE_THRESHOLDS.rejectRecall))
    failures.push('REJECT_RECALL');
  if (!ratioAtLeast(metrics.publish.recall, SEMANTIC_GATE_THRESHOLDS.cleanPublishRecall))
    failures.push('CLEAN_PUBLISH_RECALL');
  if (!ratioAtLeast(metrics.accuracy, SEMANTIC_GATE_THRESHOLDS.accuracy)) failures.push('ACCURACY');
  if (!averageAtLeast([metrics.publish.f1, metrics.reject.f1], SEMANTIC_GATE_THRESHOLDS.macroF1))
    failures.push('MACRO_F1');
  if (
    !averageAtLeast(
      NARRATIVE_QUALITY_DIMENSIONS.map((dimension) => metrics.dimensions[dimension].f1),
      SEMANTIC_GATE_THRESHOLDS.dimensionMacroF1,
    )
  )
    failures.push('DIMENSION_MACRO_F1');
  if (
    !ratioAtLeast(
      metrics.criticalReasonCodeRecall,
      SEMANTIC_GATE_THRESHOLDS.criticalReasonCodeRecall,
    )
  )
    failures.push('CRITICAL_REASON_CODE_RECALL');
  if (
    !ratioAtLeast(
      metrics.strictJudgeOutputValidity,
      SEMANTIC_GATE_THRESHOLDS.strictJudgeOutputValidity,
    )
  )
    failures.push('STRICT_JUDGE_OUTPUT_VALIDITY');
  return { passed: failures.length === 0, failures };
}

export interface StabilityMetrics {
  readonly sentinelCount: 8;
  readonly exactDecisionAgreement: MetricRatio;
  readonly criticalFalseAcceptsAcrossRuns: number;
  readonly disagreements: readonly string[];
}

export interface StabilityGateResult {
  readonly passed: boolean;
  readonly failures: readonly ('DECISION_AGREEMENT' | 'CRITICAL_FALSE_ACCEPT')[];
}

export function calculateStabilityMetrics(
  dataset: NarrativeQualityDataset,
  primaryOutcomes: readonly SemanticCaseOutcome[],
  repeatedSentinelOutcomes: readonly SemanticCaseOutcome[],
): StabilityMetrics {
  const primary = indexSemanticOutcomes(dataset, primaryOutcomes);
  const expectedSentinels = new Set<string>(NARRATIVE_QUALITY_SENTINEL_CASE_IDS);
  const repeated = new Map<string, SemanticCaseOutcome>();
  for (const outcome of repeatedSentinelOutcomes) {
    if (
      repeated.has(outcome.caseId) ||
      !expectedSentinels.has(outcome.caseId) ||
      outcome.strictJudgeOutputValid === null
    ) {
      throw new EvalContractError(
        'INVALID_EVAL_INPUT',
        'Stability outcomes must contain the eight exact JUDGE sentinel cases once.',
      );
    }
    assertKnownUniqueValues(
      `Repeated failed dimensions for ${outcome.caseId}`,
      outcome.failedDimensions,
      NARRATIVE_QUALITY_DIMENSIONS,
    );
    assertKnownUniqueValues(
      `Repeated reason codes for ${outcome.caseId}`,
      outcome.reasonCodes,
      NARRATIVE_QUALITY_REASON_CODES,
    );
    repeated.set(outcome.caseId, outcome);
  }
  if (repeated.size !== 8) {
    throw new EvalContractError(
      'INVALID_EVAL_INPUT',
      'Stability outcomes must contain all eight exact sentinel cases.',
    );
  }

  const disagreements: string[] = [];
  let criticalFalseAcceptsAcrossRuns = 0;
  for (const caseId of NARRATIVE_QUALITY_SENTINEL_CASE_IDS) {
    const authored = dataset.cases.find((candidate) => candidate.id === caseId)!;
    const first = primary.get(caseId)!;
    const second = repeated.get(caseId)!;
    if (first.actualDecision !== second.actualDecision) disagreements.push(caseId);
    if (authored.expected.critical) {
      if (first.actualDecision === 'PUBLISH') criticalFalseAcceptsAcrossRuns += 1;
      if (second.actualDecision === 'PUBLISH') criticalFalseAcceptsAcrossRuns += 1;
    }
  }
  return {
    sentinelCount: 8,
    exactDecisionAgreement: ratio(8 - disagreements.length, 8),
    criticalFalseAcceptsAcrossRuns,
    disagreements,
  };
}

export function evaluateStabilityGates(metrics: StabilityMetrics): StabilityGateResult {
  const failures: StabilityGateResult['failures'][number][] = [];
  if (!ratioAtLeast(metrics.exactDecisionAgreement, { numerator: 7, denominator: 8 }))
    failures.push('DECISION_AGREEMENT');
  if (metrics.criticalFalseAcceptsAcrossRuns !== 0) failures.push('CRITICAL_FALSE_ACCEPT');
  return { passed: failures.length === 0, failures };
}

export interface EndToEndCaseOutcome {
  readonly caseId: string;
  readonly generateLogicalCalls: number;
  readonly judgeLogicalCalls: number;
  readonly generatedSchemaValid: boolean;
  readonly exactReferencesValid: boolean;
  readonly actualDecision: NarrativeDecision;
  readonly requiredPropertyCatalogVersion: typeof NARRATIVE_E2E_REQUIRED_PROPERTY_CATALOG_VERSION;
  readonly requiredPropertyResults: readonly NarrativeE2eRequiredPropertyResult[];
  readonly generateAuditSucceeded: boolean;
  readonly judgeAuditSucceeded: boolean;
  /** Validates only publication-bundle construction and exact linkage in memory, not DB writes. */
  readonly publicationBundleLinkageValidInMemory: boolean;
  readonly deterministicStateUnchanged: boolean;
}

export interface EndToEndMetrics {
  readonly caseCount: 4;
  readonly generateLogicalCalls: number;
  readonly judgeLogicalCalls: number;
  readonly locallyValidCandidates: MetricRatio;
  readonly published: MetricRatio;
  readonly requiredPropertiesPassed: MetricRatio;
  readonly casesWithRequiredPropertyFailures: number;
  readonly publishedWithRequiredPropertyFailures: number;
  readonly acceptedWithExactAuditAndPublicationBundleLinkageInMemory: MetricRatio;
  readonly deterministicStateUnchanged: MetricRatio;
}

export interface EndToEndGateResult {
  readonly passed: boolean;
  readonly failures: readonly (
    | 'LOCAL_VALIDITY'
    | 'LOGICAL_CALL_COUNTS'
    | 'PUBLICATION_COUNT'
    | 'REQUIRED_PROPERTY_FAILURE'
    | 'AUDIT_OR_PUBLICATION_BUNDLE_LINKAGE_IN_MEMORY'
    | 'DETERMINISTIC_STATE_MUTATION'
  )[];
}

export function calculateEndToEndMetrics(
  dataset: NarrativeQualityDataset,
  outcomes: readonly EndToEndCaseOutcome[],
): EndToEndMetrics {
  validateNarrativeQualityDatasetContract(dataset);
  const expectedIds = dataset.endToEndCases.map(({ id }) => id);
  const byId = new Map<string, EndToEndCaseOutcome>();
  for (const outcome of outcomes) {
    if (byId.has(outcome.caseId) || !expectedIds.includes(outcome.caseId)) {
      throw new EvalContractError(
        'INVALID_EVAL_INPUT',
        'End-to-end outcomes must contain each exact E2E case once.',
      );
    }
    byId.set(outcome.caseId, outcome);
  }
  if (byId.size !== 4) {
    throw new EvalContractError('INVALID_EVAL_INPUT', 'All four E2E outcomes are required.');
  }
  const ordered = expectedIds.map((id) => byId.get(id)!);
  if (
    ordered.some(
      ({ generateLogicalCalls, judgeLogicalCalls }) =>
        !Number.isSafeInteger(generateLogicalCalls) ||
        generateLogicalCalls < 0 ||
        !Number.isSafeInteger(judgeLogicalCalls) ||
        judgeLogicalCalls < 0,
    )
  ) {
    throw new EvalContractError(
      'INVALID_EVAL_INPUT',
      'End-to-end logical call counts must be non-negative safe integers.',
    );
  }
  const published = ordered.filter(({ actualDecision }) => actualDecision === 'PUBLISH');
  const authoredById = new Map(dataset.endToEndCases.map((authored) => [authored.id, authored]));
  const requiredPropertyResults = ordered.map((outcome) =>
    validateNarrativeE2eRequiredPropertyResults({
      catalogVersion: outcome.requiredPropertyCatalogVersion,
      requiredPropertyIds: authoredById.get(outcome.caseId)!.requiredProperties,
      results: outcome.requiredPropertyResults,
    }),
  );
  const flattenedRequiredPropertyResults = requiredPropertyResults.flat();
  const casesWithRequiredPropertyFailures = requiredPropertyResults.filter((results) =>
    results.some(({ passed }) => !passed),
  ).length;
  const linkedAccepted = published.filter(
    ({ generateAuditSucceeded, judgeAuditSucceeded, publicationBundleLinkageValidInMemory }) =>
      generateAuditSucceeded && judgeAuditSucceeded && publicationBundleLinkageValidInMemory,
  );
  return {
    caseCount: 4,
    generateLogicalCalls: ordered.reduce((sum, outcome) => sum + outcome.generateLogicalCalls, 0),
    judgeLogicalCalls: ordered.reduce((sum, outcome) => sum + outcome.judgeLogicalCalls, 0),
    locallyValidCandidates: ratio(
      ordered.filter(
        ({ generatedSchemaValid, exactReferencesValid }) =>
          generatedSchemaValid && exactReferencesValid,
      ).length,
      4,
    ),
    published: ratio(published.length, 4),
    requiredPropertiesPassed: ratio(
      flattenedRequiredPropertyResults.filter(({ passed }) => passed).length,
      flattenedRequiredPropertyResults.length,
    ),
    casesWithRequiredPropertyFailures,
    publishedWithRequiredPropertyFailures: ordered.filter(
      ({ actualDecision }, index) =>
        actualDecision === 'PUBLISH' &&
        requiredPropertyResults[index]!.some(({ passed }) => !passed),
    ).length,
    acceptedWithExactAuditAndPublicationBundleLinkageInMemory: ratio(
      linkedAccepted.length,
      published.length,
      1,
    ),
    deterministicStateUnchanged: ratio(
      ordered.filter(({ deterministicStateUnchanged }) => deterministicStateUnchanged).length,
      4,
    ),
  };
}

export function evaluateEndToEndGates(metrics: EndToEndMetrics): EndToEndGateResult {
  const failures: EndToEndGateResult['failures'][number][] = [];
  if (metrics.generateLogicalCalls !== 4 || metrics.judgeLogicalCalls !== 4)
    failures.push('LOGICAL_CALL_COUNTS');
  if (metrics.locallyValidCandidates.numerator !== 4) failures.push('LOCAL_VALIDITY');
  if (!ratioAtLeast(metrics.published, { numerator: 3, denominator: 4 }))
    failures.push('PUBLICATION_COUNT');
  if (
    metrics.casesWithRequiredPropertyFailures !== 0 ||
    !ratioAtLeast(metrics.requiredPropertiesPassed, { numerator: 1, denominator: 1 })
  ) {
    failures.push('REQUIRED_PROPERTY_FAILURE');
  }
  if (
    !ratioAtLeast(metrics.acceptedWithExactAuditAndPublicationBundleLinkageInMemory, {
      numerator: 1,
      denominator: 1,
    })
  )
    failures.push('AUDIT_OR_PUBLICATION_BUNDLE_LINKAGE_IN_MEMORY');
  if (!ratioAtLeast(metrics.deterministicStateUnchanged, { numerator: 1, denominator: 1 }))
    failures.push('DETERMINISTIC_STATE_MUTATION');
  return { passed: failures.length === 0, failures };
}

export interface PercentDelta {
  readonly baseline: number;
  readonly current: number;
  /** Null means the baseline is zero and a finite percentage is undefined. */
  readonly percent: number | null;
  readonly increaseAbove25Percent: boolean;
}

export function calculatePercentDelta(current: number, baseline: number): PercentDelta {
  if (
    !Number.isSafeInteger(current) ||
    !Number.isSafeInteger(baseline) ||
    current < 0 ||
    baseline < 0
  ) {
    throw new EvalContractError(
      'INVALID_EVAL_INPUT',
      'Percent deltas require non-negative safe integers.',
    );
  }
  const percent =
    baseline === 0 ? (current === 0 ? 0 : null) : ((current - baseline) * 100) / baseline;
  const increaseAbove25Percent =
    baseline === 0 ? current > 0 : BigInt(current - baseline) * 100n > BigInt(baseline) * 25n;
  return { baseline, current, percent, increaseAbove25Percent };
}

export interface RegressionGateResult {
  readonly passed: boolean;
  readonly newlyIncorrectNonCriticalCaseIds: readonly string[];
  readonly warnings: readonly string[];
}

export function evaluateRegressionAgainstBaseline(
  dataset: NarrativeQualityDataset,
  acceptedBaseline: SemanticQualityMetrics,
  candidate: SemanticQualityMetrics,
  operationalDeltas: Readonly<Record<string, PercentDelta>> = {},
): RegressionGateResult {
  const absolute = evaluateSemanticGates(candidate);
  const baselineCorrect = new Set(acceptedBaseline.correctCaseIds);
  const candidateIncorrect = new Set(candidate.incorrectCaseIds);
  const criticalIds = new Set(
    dataset.cases.filter(({ expected }) => expected.critical).map(({ id }) => id),
  );
  const newlyIncorrectNonCriticalCaseIds = dataset.cases
    .map(({ id }) => id)
    .filter((id) => baselineCorrect.has(id) && candidateIncorrect.has(id) && !criticalIds.has(id));
  const warnings = Object.entries(operationalDeltas)
    .filter(([, delta]) => delta.increaseAbove25Percent)
    .map(([metric]) => `${metric} increased by more than 25%.`)
    .sort();
  return {
    passed: absolute.passed && newlyIncorrectNonCriticalCaseIds.length <= 1,
    newlyIncorrectNonCriticalCaseIds,
    warnings,
  };
}
