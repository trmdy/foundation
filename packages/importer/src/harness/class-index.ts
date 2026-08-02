/**
 * classIndex builder — API.md Wave 4 Stage 1, item 5.
 *
 * Tailwind v4 compile approach (documented): v4's programmatic entry point
 * (`tailwindcss`'s `lib.mjs` export) has no PostCSS/CLI plumbing installed
 * in this workspace, and `compile()`'s default `loadStylesheet` throws
 * unless you supply one — normally satisfied by `@tailwindcss/postcss` or
 * the CLI, neither of which is an installed dependency here. It turns out
 * unnecessary: `tailwindcss/index.css` (the package's own default-theme +
 * preflight + utilities stylesheet) has NO `@import` statements of its own
 * — theme tokens are inlined and utilities come from `@tailwind utilities`
 * — so reading that one file's text with `node:fs` and feeding it straight
 * into `__unstable__loadDesignSystem()` is enough to get a fully-configured
 * `DesignSystem`, entirely offline, with zero new dependencies. No config
 * file, no content-globbing: `DesignSystem.parseCandidate` / `.candidatesToAst`
 * are driven directly against exactly the class token set collected from
 * the samples, matching item 5's "content = a synthetic file listing the
 * classes" instruction in spirit (no filesystem synthetic file needed — the
 * design system's AST API takes the candidate strings directly).
 *
 * classIndex KEYING (contract finding, REVISED — dogfood cycle 3 friction §2):
 * API.md types classIndex as `Record<string, ClassIndexEntry>` without saying
 * what the key is. This module keys by the class token with any resolvable
 * state-variant prefix (or unsupported prefix) STRIPPED — e.g. both
 * "bg-primary" and "hover:bg-primary" contribute to the SAME entry
 * ("bg-primary"), the first into `.base`, the second into `.states.hover`.
 * This matches the convention already adopted by the concurrently-built
 * Stage 2 (packages/importer/src/types.ts, "CONTRACT FINDING (classIndex
 * keying)") — Stage 2 (project/style.ts) is the actual consumer of this
 * shape, so this module conforms to it.
 *
 * The "stripped" name was originally computed via tailwind's own
 * `printCandidate({ ...c, variants: [] })`. THAT WAS A BUG: printCandidate
 * NORMALIZES on print — `bg-[var(--color-surface-sunken)]` prints back as
 * `bg-(color:--color-surface-sunken)` — so the key stopped matching the
 * literal token style.ts's naive last-colon split produces for the SAME
 * html's `class=""` attribute. Every var()-referencing arbitrary value
 * missed the classIndex lookup, was reported `import-unprojectable-css`,
 * and force-sealed the component (found dogfooding a real component against
 * document CSS-var tokens — see docs/dogfood/usage-dashboard-run.md §2).
 * Literal arbitrary values (`bg-[#B8842E]`) happened to round-trip
 * unchanged, which is why the bug hid behind "sometimes works". Fixed by
 * keying with `naiveBaseName` (below) UNCONDITIONALLY — the exact same
 * last-colon split project/style.ts's `parseClassToken` performs on the
 * observed html token — so the two sides can never disagree on the string.
 * `printCandidate` is no longer called for keying at all; if a future need
 * arises for Tailwind's canonical candidate text (e.g. dedup/debug output),
 * it must stay strictly internal and never feed the classIndex key.
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { __unstable__loadDesignSystem } from 'tailwindcss'
import type { AstNode, Variant } from './tailwind-ast.js'
import type { ClassIndex, ClassIndexEntry, StateVariant } from '../types.js'

const require = createRequire(import.meta.url)
const STATE_KEYS: StateVariant[] = ['hover', 'focus', 'active', 'disabled']

let designSystemPromise: ReturnType<typeof __unstable__loadDesignSystem> | null = null
function loadDesignSystem() {
  if (!designSystemPromise) {
    const css = readFileSync(require.resolve('tailwindcss/index.css'), 'utf8')
    designSystemPromise = __unstable__loadDesignSystem(css, { base: process.cwd() })
  }
  return designSystemPromise
}

const CLASS_ATTR_RE = /\bclass="([^"]*)"/g

function collectClassTokens(htmls: string[]): string[] {
  const tokens = new Set<string>()
  for (const html of htmls) {
    for (const match of html.matchAll(CLASS_ATTR_RE)) {
      for (const token of (match[1] as string).split(/\s+/)) {
        if (token.length > 0) tokens.add(token)
      }
    }
  }
  return [...tokens].sort()
}

/** THE classIndex key, for every token — Tailwind-recognized or not. Matches
 *  project/style.ts's `parseClassToken` (last-colon split) exactly, so
 *  index[base] and style.ts's own lookup can never disagree: both derive
 *  `base` from the observed html text the same naive way, with no
 *  normalization step in between. (Previously used only as a fallback for
 *  classes Tailwind's own parser doesn't recognize; now used unconditionally
 *  — see the module doc's KEYING note for why.) */
function naiveBaseName(token: string): string {
  const i = token.lastIndexOf(':')
  return i === -1 ? token : token.slice(i + 1)
}

function describeVariant(v: Variant): string {
  switch (v.kind) {
    case 'static':
      return v.root
    case 'functional':
      return v.root
    case 'compound':
      return `${v.root}-${describeVariant(v.variant)}`
    case 'arbitrary':
      return 'arbitrary-selector'
    default:
      return 'unknown-variant'
  }
}

/** Flatten a candidatesToAst() result into declarations, skipping
 *  `@property` custom-property registration blocks (not visual state). */
function flattenDeclarations(nodes: AstNode[], out: Record<string, string>): void {
  for (const node of nodes) {
    if (node.kind === 'declaration') {
      if (node.value !== undefined) out[node.property] = node.value
    } else if (node.kind === 'rule') {
      flattenDeclarations(node.nodes, out)
    } else if (node.kind === 'at-rule') {
      if (node.name === '@property') continue
      flattenDeclarations(node.nodes, out)
    } else if (node.kind === 'context' || node.kind === 'at-root') {
      flattenDeclarations(node.nodes, out)
    }
  }
}

function sortRecord(rec: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of Object.keys(rec).sort()) out[key] = rec[key] as string
  return out
}

interface Draft {
  base: Record<string, string>
  states: Partial<Record<StateVariant, Record<string, string>>>
  unsupported: Set<string>
}

export async function buildClassIndex(htmls: string[]): Promise<ClassIndex> {
  const tokens = collectClassTokens(htmls)
  if (tokens.length === 0) return {}

  const design = await loadDesignSystem()
  const drafts = new Map<string, Draft>()

  function draftFor(baseName: string): Draft {
    let d = drafts.get(baseName)
    if (!d) {
      d = { base: {}, states: {}, unsupported: new Set() }
      drafts.set(baseName, d)
    }
    return d
  }

  const astLists = design.candidatesToAst(tokens) as unknown as AstNode[][]

  tokens.forEach((token, i) => {
    const candidates = design.parseCandidate(token)
    if (candidates.length === 0) {
      // Non-Tailwind class: empty base. Tailwind can't tell us its "real"
      // base name, so key it the same way project/style.ts's own naive
      // last-colon split would (see naiveBaseName doc above).
      draftFor(naiveBaseName(token))
      return
    }
    const candidate = candidates[0] as (typeof candidates)[number]
    const variants = candidate.variants as unknown as Variant[]
    // KEYING FIX (dogfood cycle 3, friction §2): the key MUST be the raw
    // token's own base text (naiveBaseName — the same last-colon split
    // project/style.ts's parseClassToken uses), never Tailwind's
    // `printCandidate` round-trip. printCandidate NORMALIZES arbitrary
    // values that reference a CSS var — `bg-[var(--x)]` prints back as
    // `bg-(color:--x)` — so a key built from it no longer equals the
    // literal class token style.ts looks up when resolving the SAME html's
    // `class=""` attribute. Declarations are still resolved via Tailwind's
    // real candidate/variant parsing (astLists[i] below); only the KEY
    // reverts to the observed text, so index[base] and style.ts's
    // classIndex[base] are guaranteed to agree for every token, including
    // literal values (which happened to round-trip fine) and var()
    // references (which didn't).
    const baseName = naiveBaseName(token)

    const declarations: Record<string, string> = {}
    flattenDeclarations(astLists[i] ?? [], declarations)

    if (variants.length === 0) {
      Object.assign(draftFor(baseName).base, declarations)
    } else if (variants.length === 1 && variants[0]?.kind === 'static' && STATE_KEYS.includes(variants[0].root as StateVariant)) {
      const stateKey = (variants[0] as { root: StateVariant }).root
      const draft = draftFor(baseName)
      draft.states[stateKey] = { ...(draft.states[stateKey] ?? {}), ...declarations }
    } else {
      const draft = draftFor(baseName)
      for (const v of variants) draft.unsupported.add(describeVariant(v))
    }
  })

  const out: ClassIndex = {}
  for (const key of [...drafts.keys()].sort()) {
    const d = drafts.get(key) as Draft
    const entry: ClassIndexEntry = { base: sortRecord(d.base) }
    if (Object.keys(d.states).length > 0) {
      const states: ClassIndexEntry['states'] = {}
      for (const sk of STATE_KEYS) {
        const val = d.states[sk]
        if (val) states[sk] = sortRecord(val)
      }
      entry.states = states
    }
    if (d.unsupported.size > 0) entry.unsupported = [...d.unsupported].sort()
    out[key] = entry
  }
  return out
}

// ——— theme var resolution (follow-up wave: "Tailwind theme vars become
//      Foundation tokens on import") ———
//
// A resolved declaration's VALUE routinely still contains a var(--x)
// reference — `background-color: var(--color-green-100)`,
// `border-radius: calc(infinity * 1px)` has none, but
// `line-height: var(--tw-leading, var(--text-xs--line-height))` has two
// (one of which is itself a fallback arg, not a "primary" value — CSS
// doesn't distinguish the two for our purposes, both need SOME resolution
// path). Those var() names are never inlined into the declaration text
// itself (D1: declarations are carried through as Tailwind emitted them,
// arbitrary values are legal, never snapped) — instead the CLI (Stage 3)
// declares them as document tokens (`doc.tokens`) alongside the component,
// the same way a hand-authored document would declare `--color-accent`,
// so the var() reference the declaration already has resolves for real in
// a browser. Without this, a component bakes and validates clean (the
// declaration text is syntactically fine either way) but silently renders
// unpigmented/unsized — the exact gap flagged in the Stage 3 acceptance
// report and closed here.
//
// "Theme vars may reference other vars" (e.g. `--text-xs`'s OWN definition
// is `0.75rem`, no nesting, but `line-height` above references
// `--text-xs--line-height`, itself a SEPARATE top-level theme entry with no
// further nesting in this default theme) — so resolution is a small BFS:
// seed the queue from every declaration in the classIndex, resolve each
// name against the design system's theme, then also scan the RESOLVED
// value text for further var(--y) references and enqueue those too. A name
// with no theme definition (e.g. `--tw-leading`, `--tw-font-weight` — these
// are Tailwind's own cascade-plumbing custom properties, SET by a utility
// class's own declaration, not defined in the theme) is left unresolved,
// not an error: the declaration already has a working CSS fallback chain
// (`var(--tw-leading, var(--text-xs--line-height))` falls through to the
// theme value when `--tw-leading` is unset, which is exactly the state a
// freshly imported component is in) — D1's "report, never reject" applies
// here exactly as it does to every other importer finding.
const VAR_REF_RE = /var\(\s*(--[A-Za-z0-9_-]+)/g

function collectVarRefs(value: string, out: Set<string>): void {
  for (const m of value.matchAll(VAR_REF_RE)) out.add(m[1] as string)
}

function allDeclarationValues(classIndex: ClassIndex): string[] {
  const values: string[] = []
  for (const entry of Object.values(classIndex)) {
    values.push(...Object.values(entry.base))
    for (const bag of Object.values(entry.states ?? {})) {
      if (bag) values.push(...Object.values(bag))
    }
  }
  return values
}

export interface ThemeVarResolution {
  /** Resolved theme var definitions, keyed WITHOUT the leading `--` (the
   *  same convention `FdnDocument.tokens` already uses — see types.ts's
   *  EXPRESSION GRAMMAR note: "doc.tokens keys are stored WITHOUT the
   *  leading '--'"), sorted. Ready to merge into `doc.tokens` as-is. */
  themeVars: Record<string, string>
  /** Full `--name` (WITH the leading dashes, for a legible report message)
   *  of every var() referenced by some declaration that has no resolvable
   *  theme definition — left out of `themeVars` entirely; reported at
   *  projection time (import-unresolved-theme-var), never treated as an
   *  import failure. Sorted. */
  unresolvedThemeVars: string[]
}

/** Resolves every `var(--x)` referenced (directly or transitively, through
 *  other theme vars' own definitions) by any declaration in `classIndex`
 *  against the design system's compiled theme (`tailwindcss/index.css`'s
 *  `@theme` block — the same design system buildClassIndex already
 *  compiled the declarations against, so a var() name found here is
 *  guaranteed to mean what that design system says it means). */
export async function resolveThemeVars(classIndex: ClassIndex): Promise<ThemeVarResolution> {
  const design = await loadDesignSystem()

  const seed = new Set<string>()
  for (const value of allDeclarationValues(classIndex)) collectVarRefs(value, seed)

  const resolved: Record<string, string> = {}
  const unresolved = new Set<string>()
  const visited = new Set<string>()
  const queue = [...seed]

  while (queue.length > 0) {
    const name = queue.shift() as string
    if (visited.has(name)) continue
    visited.add(name)

    const value = design.theme.get([name as `--${string}`])
    if (value === null) {
      unresolved.add(name)
      continue
    }
    resolved[name.slice(2)] = value

    const nested = new Set<string>()
    collectVarRefs(value, nested)
    for (const n of nested) if (!visited.has(n)) queue.push(n)
  }

  return { themeVars: sortRecord(resolved), unresolvedThemeVars: [...unresolved].sort() }
}
