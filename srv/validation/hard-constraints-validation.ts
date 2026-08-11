import { DomainError } from '../domain/domain-error.ts';
import type { HardConstraints } from '../domain/trip-request.ts';

const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

function validateBooleanConstraint(value: boolean, fieldName: string): void {
  if (typeof value !== 'boolean') {
    throw new DomainError(
      'INVALID_BOOLEAN_CONSTRAINT',
      `Ograniczenie ${fieldName} musi być wartością logiczną.`,
    );
  }
}

function validateOptionalTime(value: string | null, code: string, fieldName: string): void {
  if (value !== null && (typeof value !== 'string' || !TIME_PATTERN.test(value))) {
    throw new DomainError(code, `${fieldName} musi mieć format HH:mm.`);
  }
}

/** Waliduje jawny profil twardych ograniczeń bez uzupełniania brakujących wartości. */
export function validateHardConstraints(input: HardConstraints): void {
  validateBooleanConstraint(input.hardBudgetLimit, 'hardBudgetLimit');
  validateBooleanConstraint(input.allowFlight, 'allowFlight');
  validateBooleanConstraint(input.allowTrain, 'allowTrain');
  validateBooleanConstraint(input.allowBus, 'allowBus');

  if (!Number.isInteger(input.maxConnections) || input.maxConnections < 0) {
    throw new DomainError(
      'INVALID_MAX_CONNECTIONS',
      'Maksymalna liczba przesiadek musi być nieujemną liczbą całkowitą.',
    );
  }

  if (
    input.maxTravelMinutes !== null &&
    (!Number.isInteger(input.maxTravelMinutes) || input.maxTravelMinutes <= 0)
  ) {
    throw new DomainError(
      'INVALID_MAX_TRAVEL_MINUTES',
      'Maksymalny czas podróży musi być dodatnią liczbą całkowitą minut.',
    );
  }

  validateOptionalTime(
    input.earliestDepartureTime,
    'INVALID_EARLIEST_DEPARTURE_TIME',
    'Najwcześniejsza godzina wyjazdu',
  );
  validateOptionalTime(
    input.latestReturnTime,
    'INVALID_LATEST_RETURN_TIME',
    'Najpóźniejsza godzina powrotu',
  );

  if (input.allowFlight !== true && input.allowTrain !== true && input.allowBus !== true) {
    throw new DomainError(
      'NO_TRANSPORT_MODE_ALLOWED',
      'Co najmniej jeden środek transportu musi być dozwolony.',
    );
  }
}
