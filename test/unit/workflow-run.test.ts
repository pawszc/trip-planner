import { describe, expect, it } from 'vitest';
import { DomainError } from '../../srv/domain/trip-request.js';
import {
  ALLOWED_WORKFLOW_TRANSITIONS,
  isWorkflowState,
  transitionWorkflowState,
  WORKFLOW_STATE_VALUES,
} from '../../srv/domain/workflow-run.js';
import type { WorkflowState } from '../../srv/domain/workflow-run.js';

const allowedTransitions: readonly (readonly [WorkflowState, WorkflowState])[] = [
  ['COLLECTING', 'NEEDS_CLARIFICATION'],
  ['NEEDS_CLARIFICATION', 'CONSTRAINTS_CONFIRMED'],
  ['COLLECTING', 'CONSTRAINTS_CONFIRMED'],
  ['CONSTRAINTS_CONFIRMED', 'SEARCHING'],
  ['SEARCHING', 'CANDIDATES_VALIDATED'],
  ['CANDIDATES_VALIDATED', 'OPTIONS_READY'],
  ['OPTIONS_READY', 'OPTION_SELECTED'],
  ['OPTION_SELECTED', 'ITINERARY_GENERATED'],
  ['ITINERARY_GENERATED', 'VALIDATED'],
  ['VALIDATED', 'READY'],
  ['READY', 'REVISING'],
  ['REVISING', 'ITINERARY_GENERATED'],
];

const invalidTransitions: readonly (readonly [WorkflowState, WorkflowState])[] = [
  ['COLLECTING', 'SEARCHING'],
  ['SEARCHING', 'COLLECTING'],
  ['OPTIONS_READY', 'READY'],
  ['READY', 'READY'],
  ['REVISING', 'READY'],
];

describe('Workflow state machine', () => {
  it('defines exactly the eleven workflow states', () => {
    expect(WORKFLOW_STATE_VALUES).toEqual([
      'COLLECTING',
      'NEEDS_CLARIFICATION',
      'CONSTRAINTS_CONFIRMED',
      'SEARCHING',
      'CANDIDATES_VALIDATED',
      'OPTIONS_READY',
      'OPTION_SELECTED',
      'ITINERARY_GENERATED',
      'VALIDATED',
      'READY',
      'REVISING',
    ]);
  });

  it('contains exactly the twelve allowed edges', () => {
    expect(Object.values(ALLOWED_WORKFLOW_TRANSITIONS).flat()).toHaveLength(12);
  });

  it('narrows only known workflow states at runtime', () => {
    expect(isWorkflowState('READY')).toBe(true);
    expect(isWorkflowState('BROKEN')).toBe(false);
    expect(isWorkflowState(null)).toBe(false);
  });

  it.each(allowedTransitions)('allows %s -> %s', (sourceState, targetState) => {
    expect(transitionWorkflowState(sourceState, targetState)).toBe(targetState);
  });

  it.each(invalidTransitions)('rejects %s -> %s', (sourceState, targetState) => {
    expect(() => transitionWorkflowState(sourceState, targetState)).toThrowError(
      /Niedozwolone przejście workflow/,
    );
  });

  it('reports the code, source state, target state and readable message', () => {
    let capturedError: unknown;
    try {
      transitionWorkflowState('COLLECTING', 'READY');
    } catch (error) {
      capturedError = error;
    }

    expect(capturedError).toBeInstanceOf(DomainError);
    expect(capturedError).toMatchObject({
      code: 'INVALID_WORKFLOW_TRANSITION',
      sourceState: 'COLLECTING',
      targetState: 'READY',
      message: 'Niedozwolone przejście workflow ze stanu COLLECTING do READY.',
    });
  });

  it('does not change the source state after a rejected transition', () => {
    const sourceState: WorkflowState = 'COLLECTING';

    expect(() => transitionWorkflowState(sourceState, 'READY')).toThrowError(DomainError);
    expect(sourceState).toBe('COLLECTING');
  });

  it.each([
    ['BROKEN', 'READY'],
    ['READY', 'BROKEN'],
  ] as const)(
    'reports a controlled error for an unknown runtime transition %s -> %s',
    (sourceState, targetState) => {
      let capturedError: unknown;
      const originalSourceState = sourceState;
      const originalTargetState = targetState;

      try {
        transitionWorkflowState(sourceState, targetState);
      } catch (error) {
        capturedError = error;
      }

      expect(capturedError).toBeInstanceOf(DomainError);
      expect(capturedError).toMatchObject({
        code: 'INVALID_WORKFLOW_TRANSITION',
        sourceState,
        targetState,
        message: `Niedozwolone przejście workflow ze stanu ${sourceState} do ${targetState}.`,
      });
      expect(sourceState).toBe(originalSourceState);
      expect(targetState).toBe(originalTargetState);
    },
  );

  it('creates the confirmed target state from collecting', () => {
    expect(transitionWorkflowState('COLLECTING', 'CONSTRAINTS_CONFIRMED')).toBe(
      'CONSTRAINTS_CONFIRMED',
    );
  });
});
