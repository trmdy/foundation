/**
 * foundation-engine — freeze: `FdnDocument` <-> lock-headered frozen text
 * (SPEC D4 + §7, PRD §4 "Freeze / crystallization").
 *
 * Freeze = canonical projection + a single-line lock header on line 1. Frozen
 * text is dead text with a verifiable pedigree: reviewable in a PR beside the
 * component it describes, and re-hydratable into a live chain on demand. It
 * is deliberately NOT truth-preserving in the chain sense — thaw() re-parses
 * the projection into a fresh FdnDocument; re-attaching a thawed document to
 * its original chain (so further edits append rather than fork) is a
 * recorded follow-up, not solved here (see thawFrozen's doc comment).
 *
 * Lock header format (integrator-fixed, exactly one comment line, line 1):
 *
 *   <!-- fdn-frozen spec=<specVersion> engine=<engineVersion>
 *        doc-sha256=<hex sha256 of everything after this line>
 *        chain-head=<envelope hash | "none"> frozen-by=<author>
 *        message=<uri-encoded message> -->
 *
 * Deterministic: no timestamps, no randomness. `doc-sha256` is computed over
 * exactly the bytes that follow the header line's trailing "\n" — i.e. the
 * canonical projection text, unchanged — so a verifier never needs anything
 * but the frozen file itself to catch a single tampered byte anywhere in the
 * body.
 *
 * Field encoding: every field except `message` is written verbatim (spec
 * versions, engine semver, hex hashes, and `author` strings are not expected
 * to contain whitespace in practice). `message` is free text and MAY contain
 * spaces/newlines/`=`/etc., so it alone is `encodeURIComponent`-escaped —
 * this keeps the header a single whitespace-delimited line without needing a
 * general quoting/escaping scheme for the other fields.
 */
import { createHash } from 'node:crypto'
import { parseDocument } from '../parse/index.js'
import { projectDocument } from '../project/index.js'
import type { FdnDocument } from '../types.js'

export interface FrozenHeader {
  spec: string
  engine: string
  docSha256: string
  chainHead: string
  frozenBy: string
  message: string
}

export interface FreezeOpts {
  author: string
  message?: string
  chainHead?: string | null
  engineVersion: string
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** Matches exactly one frozen header line — see module doc for the format.
 *  Every field but `message` is required to be non-whitespace (`\S+`);
 *  `message` may be empty (`\S*`, since an empty string is a legal
 *  `encodeURIComponent` output for the empty message). */
const HEADER_RE =
  /^<!-- fdn-frozen spec=(\S+) engine=(\S+) doc-sha256=([0-9a-f]{64}) chain-head=(\S+) frozen-by=(\S+) message=(\S*) -->$/

function buildHeaderLine(opts: {
  spec: string
  engine: string
  docSha256: string
  chainHead: string
  frozenBy: string
  message: string
}): string {
  return (
    `<!-- fdn-frozen spec=${opts.spec} engine=${opts.engine} doc-sha256=${opts.docSha256} ` +
    `chain-head=${opts.chainHead} frozen-by=${opts.frozenBy} message=${encodeURIComponent(opts.message)} -->`
  )
}

/** Split frozen text into (header line, everything after its trailing "\n").
 *  Returns null when there is no line 1 to speak of (no newline at all). */
function splitHeaderLine(text: string): { headerLine: string; body: string } | null {
  const nl = text.indexOf('\n')
  if (nl === -1) return null
  return { headerLine: text.slice(0, nl), body: text.slice(nl + 1) }
}

function parseHeaderLine(headerLine: string): FrozenHeader | null {
  const m = HEADER_RE.exec(headerLine)
  if (!m) return null
  const spec = m[1] ?? ''
  const engine = m[2] ?? ''
  const docSha256 = m[3] ?? ''
  const chainHead = m[4] ?? ''
  const frozenBy = m[5] ?? ''
  const messageEnc = m[6] ?? ''
  let message: string
  try {
    message = decodeURIComponent(messageEnc)
  } catch {
    return null
  }
  return { spec, engine, docSha256, chainHead, frozenBy, message }
}

/**
 * doc -> full frozen text (lock header line + canonical projection).
 * `opts.chainHead` is the document's `.chain` envelope head hash when one
 * exists, or `null`/omitted for a document with no chain yet (serialized as
 * the literal string "none" — freeze does not require a chain).
 */
export function freezeDocument(doc: FdnDocument, opts: FreezeOpts): string {
  const projection = projectDocument(doc)
  const docSha256 = sha256Hex(projection)
  const headerLine = buildHeaderLine({
    spec: doc.specVersion,
    engine: opts.engineVersion,
    docSha256,
    chainHead: opts.chainHead ?? 'none',
    frozenBy: opts.author,
    message: opts.message ?? '',
  })
  return `${headerLine}\n${projection}`
}

/**
 * Structural verification: parses the lock header and recomputes the body's
 * sha256, comparing against the header's declared `doc-sha256`. Never
 * throws — malformed input is a `{ ok: false, reason }` result, not an
 * exception, so callers (notably the CLI's `--verify`) can report cleanly on
 * arbitrary/foreign/corrupted files.
 */
export function verifyFrozen(text: string): { ok: boolean; reason?: string; header?: FrozenHeader } {
  const split = splitHeaderLine(text)
  if (!split) return { ok: false, reason: 'no header line found (file has no newline after line 1)' }
  const header = parseHeaderLine(split.headerLine)
  if (!header) return { ok: false, reason: 'malformed fdn-frozen lock header on line 1' }
  const actual = sha256Hex(split.body)
  if (actual !== header.docSha256) {
    return {
      ok: false,
      reason: `doc-sha256 mismatch: header declares ${header.docSha256}, body hashes to ${actual}`,
      header,
    }
  }
  return { ok: true, header }
}

/**
 * frozen text -> { doc, header } (re-hydration v0). Strips the lock header
 * and runs the remaining canonical projection back through `parseDocument`,
 * producing a fresh, chain-less `FdnDocument` — this is the "re-hydratable
 * into a live chain on demand" half of SPEC D4's freeze definition, minus
 * the "on demand" chain re-attachment itself: thaw hands back a document a
 * caller can `createChain()` from directly, but does NOT try to reconnect it
 * to whatever `.chain` file produced the original `chain-head` (that would
 * require correlating the frozen file with a chain store the caller hasn't
 * named here). Divergence detection (frozen file drifted from its source
 * chain) is therefore also a follow-up, not attempted by this function.
 *
 * Unlike `verifyFrozen`, this DOES throw on a structurally malformed header
 * (there is no document to hand back otherwise) but deliberately does NOT
 * insist the body's hash matches the header's `doc-sha256` — thawing a file
 * whose body was hand-edited after freezing is a legitimate (if unusual)
 * ingestion path (SPEC D4: "any edit to projected text ... is ingested");
 * callers that care about pedigree should call `verifyFrozen` first and act
 * on `ok` themselves.
 */
export function thawFrozen(text: string): { doc: FdnDocument; header: FrozenHeader } {
  const split = splitHeaderLine(text)
  if (!split) throw new Error('thawFrozen: no header line found (file has no newline after line 1)')
  const header = parseHeaderLine(split.headerLine)
  if (!header) throw new Error('thawFrozen: malformed fdn-frozen lock header on line 1')
  const { doc } = parseDocument(split.body)
  return { doc, header }
}
