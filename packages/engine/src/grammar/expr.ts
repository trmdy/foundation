/**
 * foundation-engine — expression grammar (resolved SPEC open question 9).
 *
 * `{{ <expr> }}` and `when`/`each` admit exactly the non-Turing-complete grammar
 * documented in src/types.ts:
 *
 *   ref        := ('prop' | 'item' | 'param') '.' ident ('.' ident)*
 *   ternary    := <cond> '?' <value> ':' <value>
 *   lookupref  := ident '[' ref ']'
 *   value      := ref | lookupref | quoted-string-literal
 *   cond       := ref | ref ('==' | '!=') (quoted-string-literal | number | boolean)
 *   when       := <cond> plus '&&' / '||' / '!' composition
 *
 * This module is a pragmatic reference-extraction SCANNER, not a full parser
 * generator: it is enough to (a) pull every dotted ref and lookup-ref out of an
 * expression string for undeclared-reference checking, and (b) recognize the
 * shapes above well enough to flag gross syntax the grammar doesn't admit
 * (arithmetic, method calls, string concatenation). It does not evaluate.
 *
 * Ref roots: `prop` / `item` / `param`, PLUS the currently-bound `each` alias
 * (`each="topic in data.guideTopics"` binds `topic` as a legal ref root for
 * `{{ topic.label }}` within that subtree) — types.ts's expression-grammar
 * comment names this explicitly ("<active-each-binding-name>"; `item` is the
 * default binding name). Earlier drafts of this module treated `item` as the
 * only literal loop-alias root, which the fixture boards' real `each` usage
 * (arbitrary aliases, never literally `item`) contradicted; the contract now
 * documents the dynamically-scoped-alias reading directly.
 */

export interface Ref {
  root: string
  path: string[]
  /** Character offset within the expression, for diagnostics. */
  index: number
}

export interface LookupRef {
  lookupName: string
  ref: Ref
  index: number
}

const INTERPOLATION_RE = /\{\{\s*([\s\S]*?)\s*\}\}/g
const REF_RE = /([A-Za-z_][A-Za-z0-9_]*)((?:\.[A-Za-z_][A-Za-z0-9_]*)+)/g
const LOOKUP_RE = /([A-Za-z_][A-Za-z0-9_]*)\[\s*([^\]]+?)\s*\]/g

/** Extract the inner expression text of every `{{ … }}` span in `text`. */
export function extractInterpolations(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(INTERPOLATION_RE)) {
    if (m[1] !== undefined) out.push(m[1])
  }
  return out
}

/** Mask quoted string literals so ref-scanning doesn't match identifiers inside them. */
function maskStringLiterals(expr: string): string {
  return expr.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g, (m) => ' '.repeat(m.length))
}

/** Extract every dotted reference (`prop.x`, `item.y.z`, `topic.label`, …) from an expression. */
export function extractRefs(expr: string): Ref[] {
  const masked = maskStringLiterals(expr)
  const refs: Ref[] = []
  for (const m of masked.matchAll(REF_RE)) {
    const root = m[1]
    const rest = m[2]
    if (root === undefined || rest === undefined) continue
    const path = rest.split('.').filter(Boolean)
    refs.push({ root, path, index: m.index ?? 0 })
  }
  return refs
}

/** Extract lookup-table references: `lookupName[ref]`. */
export function extractLookupRefs(expr: string): LookupRef[] {
  const masked = maskStringLiterals(expr)
  const out: LookupRef[] = []
  for (const m of masked.matchAll(LOOKUP_RE)) {
    const lookupName = m[1]
    const inner = m[2]
    if (lookupName === undefined || inner === undefined) continue
    const innerRefs = extractRefs(inner)
    const first = innerRefs[0]
    if (first) out.push({ lookupName, ref: first, index: m.index ?? 0 })
  }
  return out
}

/** The fixed set of ref roots the grammar names literally. */
export const FIXED_REF_ROOTS = new Set(['prop', 'param', 'item'])

/**
 * Parse a top-level `each="<alias> in <ref-expr>"` binding.
 * Returns the bound alias name and the source reference (e.g. `data.guideTopics`,
 * `prop.keyGroups.split(' · ')` — the split-call form is a known, reported
 * grammar-budget overrun, see extractRefs still finding `prop.keyGroups`).
 */
export function parseEachBinding(each: string): { alias: string; source: string } | null {
  const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s+in\s+(.+)$/.exec(each)
  if (!m) return null
  const alias = m[1]
  const source = m[2]
  if (alias === undefined || source === undefined) return null
  return { alias, source: source.trim() }
}

/** Detect constructs the grammar explicitly does NOT admit (SPEC Q9: "no
 *  arithmetic, no method calls, no string operations"), for corrective errors.
 *  Best-effort: flags method calls (`.split(`, `.toUpperCase(`, …) only — the
 *  one shape the grammar spike actually hit (GRAMMAR-FINDINGS.md b.4). */
export function findDisallowedConstructs(expr: string): string[] {
  const masked = maskStringLiterals(expr)
  const issues: string[] = []
  if (/\.[A-Za-z_][A-Za-z0-9_]*\s*\(/.test(masked)) issues.push('method call')
  return issues
}
