/**
 * foundation-importer — structured harness errors.
 *
 * Every failure mode the Wave 4 Stage 1 contract calls out ("legible error",
 * "structured error, not a crash") surfaces as a HarnessError with a stable
 * `code` so a caller (Stage 2, the CLI, a test) can branch on failure kind
 * without string-matching messages.
 */

export type HarnessErrorCode =
  | 'compile-error' // esbuild bundling failed (includes network-import attempts)
  | 'schema-unresolvable' // prop schema could not be extracted and no override covers the gap
  | 'banned-api' // a banned global/module was touched inside the sandbox
  | 'render-error' // the component itself threw during renderToStaticMarkup

export class HarnessError extends Error {
  readonly code: HarnessErrorCode
  readonly detail?: unknown

  constructor(code: HarnessErrorCode, message: string, opts?: { cause?: unknown; detail?: unknown }) {
    super(message, opts?.cause !== undefined ? { cause: opts.cause } : undefined)
    this.name = 'HarnessError'
    this.code = code
    this.detail = opts?.detail
  }
}
