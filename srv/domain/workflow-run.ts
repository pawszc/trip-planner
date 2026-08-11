import { DomainError } from './domain-error.ts';

/** Stany deterministycznego workflow planowania. */
export const WORKFLOW_STATE_VALUES = [
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
] as const;

export type WorkflowState = (typeof WORKFLOW_STATE_VALUES)[number];

/** Zawęża dane z granic runtime, w tym wartości odczytane z persistence. */
export function isWorkflowState(value: unknown): value is WorkflowState {
  return WORKFLOW_STATE_VALUES.some((state) => state === value);
}

/** Trwały stan pojedynczego przebiegu workflow powiązanego z briefem. */
export interface WorkflowRun {
  ID: string;
  tripRequest_ID: string;
  state: WorkflowState;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  modifiedAt: string;
}

/** Kompletna i zamknięta mapa dozwolonych krawędzi maszyny stanów. */
export const ALLOWED_WORKFLOW_TRANSITIONS = {
  COLLECTING: ['NEEDS_CLARIFICATION', 'CONSTRAINTS_CONFIRMED'],
  NEEDS_CLARIFICATION: ['CONSTRAINTS_CONFIRMED'],
  CONSTRAINTS_CONFIRMED: ['SEARCHING'],
  SEARCHING: ['CANDIDATES_VALIDATED'],
  CANDIDATES_VALIDATED: ['OPTIONS_READY'],
  OPTIONS_READY: ['OPTION_SELECTED'],
  OPTION_SELECTED: ['ITINERARY_GENERATED'],
  ITINERARY_GENERATED: ['VALIDATED'],
  VALIDATED: ['READY'],
  READY: ['REVISING'],
  REVISING: ['ITINERARY_GENERATED'],
} as const satisfies Record<WorkflowState, readonly WorkflowState[]>;

/**
 * Zwraca stan docelowy wyłącznie dla jawnie dozwolonej krawędzi.
 * Funkcja nie mutuje źródła ani żadnego rekordu workflow.
 */
export function transitionWorkflowState(sourceState: string, targetState: string): WorkflowState {
  const allowedTargets = isWorkflowState(sourceState)
    ? ALLOWED_WORKFLOW_TRANSITIONS[sourceState]
    : undefined;
  if (
    !allowedTargets ||
    !isWorkflowState(targetState) ||
    !allowedTargets.some((allowedTarget) => allowedTarget === targetState)
  ) {
    throw new DomainError(
      'INVALID_WORKFLOW_TRANSITION',
      `Niedozwolone przejście workflow ze stanu ${sourceState} do ${targetState}.`,
      { sourceState, targetState },
    );
  }

  return targetState;
}
