import {
  REJECTION_CODE_VALUES,
  type MachineReadableValue,
  type RejectionCode,
  type RejectionReason,
  type RejectionSubject,
} from '../domain/candidate.js';

export const REJECTION_CODES = REJECTION_CODE_VALUES;

const REJECTION_MESSAGES = {
  BUDGET_EXCEEDED: 'Całkowity koszt przekracza twardy limit budżetu.',
  DEPARTURE_TOO_EARLY: 'Wyjazd rozpoczyna się przed najwcześniejszą dozwoloną godziną.',
  RETURN_TOO_LATE: 'Powrót kończy się po najpóźniejszej dozwolonej godzinie.',
  TOO_MANY_CONNECTIONS: 'Liczba przesiadek przekracza dozwolony limit.',
  TRANSPORT_MODE_NOT_ALLOWED: 'Wybrany środek transportu jest niedozwolony.',
  TRAVEL_TIME_EXCEEDED: 'Czas podróży przekracza dozwolony limit.',
  REQUIRED_PRICE_UNKNOWN: 'Brakuje wymaganej ceny do obliczenia całkowitego kosztu.',
  SOURCE_MISSING: 'Wymagana dana nie ma jawnego źródła.',
  CURRENCY_MISMATCH: 'Waluta ceny jest niezgodna z walutą briefu.',
  DUPLICATE_CANDIDATE: 'Kandydatura powiela semantycznie równoważny wariant.',
  INSUFFICIENT_TIME_AT_DESTINATION: 'Efektywny czas na miejscu jest zbyt krótki.',
  INVALID_DATES: 'Daty lub kolejność czasów kandydatury są niepoprawne.',
  INCOMPLETE_DATA: 'Kandydatura nie zawiera wszystkich wymaganych danych.',
} as const satisfies Record<RejectionCode, string>;

export type RejectionReasonInput = RejectionSubject & {
  code: RejectionCode;
  details?: Readonly<Record<string, MachineReadableValue>>;
  expected?: MachineReadableValue;
  actual?: MachineReadableValue;
};

/** Buduje stabilny tekst i jawne pola maszynowe bez udziału LLM. */
export function createRejectionReason(input: RejectionReasonInput): RejectionReason {
  const subject: RejectionSubject =
    'candidateId' in input ? { candidateId: input.candidateId } : { optionId: input.optionId };

  return {
    code: input.code,
    ...subject,
    details: input.details ?? {},
    message: REJECTION_MESSAGES[input.code],
    expected: input.expected ?? null,
    actual: input.actual ?? null,
  };
}
