/** Dodatkowy kontekst kontrolowanego błędu domenowego. */
export interface DomainErrorContext {
  sourceState?: string;
  targetState?: string;
}

/** Kontrolowany błąd reguły biznesowej; kod jest stabilny dla klientów i testów. */
export class DomainError extends Error {
  public readonly code: string;
  public readonly sourceState?: string;
  public readonly targetState?: string;

  constructor(code: string, message: string, context: DomainErrorContext = {}) {
    super(message);
    this.code = code;
    if (context.sourceState !== undefined) {
      this.sourceState = context.sourceState;
    }
    if (context.targetState !== undefined) {
      this.targetState = context.targetState;
    }
    this.name = 'DomainError';
  }
}
