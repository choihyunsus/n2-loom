// Leave space for a pending tool receipt, verification and the final immutable result.
export const TRACE_RESERVE = 786432;
export class DialogueBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DialogueBudgetError';
  }
}
