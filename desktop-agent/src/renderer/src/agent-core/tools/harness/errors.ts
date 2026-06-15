// Tool error discrimination. The harness maps these to model-facing content so
// the agent can self-correct, vs. fatal failures that should not be retried.

/** A failure the model can plausibly fix and retry: bad params, missing file,
 *  binary content where text was expected, etc. `hint` is shown to the model
 *  alongside the message to steer the retry. */
export class RecoverableToolError extends Error {
  readonly hint?: string
  constructor(message: string, hint?: string) {
    super(message)
    this.name = 'RecoverableToolError'
    this.hint = hint
  }
}

/** A failure that should not be retried (e.g. an internal invariant violation).
 *  Not yet thrown by any P1 tool — kept as the seam for future hard failures. */
export class FatalToolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FatalToolError'
  }
}

/** True if `e` is a recoverable tool error (worth surfacing for model retry). */
export function isRecoverable(e: unknown): boolean {
  return e instanceof RecoverableToolError
}
