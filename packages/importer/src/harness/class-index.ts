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
 * classIndex KEYING (contract finding): API.md types classIndex as
 * `Record<string, ClassIndexEntry>` without saying what the key is. This
 * module keys by the class token with any resolvable state-variant prefix
 * (or unsupported prefix) STRIPPED — e.g. both "bg-primary" and
 * "hover:bg-primary" contribute to the SAME entry ("bg-primary"), the first
 * into `.base`, the second into `.states.hover`. This matches the
 * convention already adopted by the concurrently-built Stage 2
 * (packages/importer/src/types.ts, "CONTRACT FINDING (classIndex keying)"),
 * confirmed by cross-checking that file mid-build — Stage 2 is the actual
 * consumer of this shape, so this module conforms to it rather than
 * re-litigating a genuinely underspecified point in API.md. The "stripped"
 * name is computed via tailwind's own `printCandidate({ ...c, variants: [] })`,
 * not string-splitting on ':' (arbitrary-variant tokens like `[&>svg]:size-4`
 * contain colons that aren't variant separators, so tailwind's own candidate
 * parser is the only robust way to find the split point).
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

/** Matches project/style.ts's `parseClassToken` (last-colon split) exactly,
 *  so a class tailwind's own parser doesn't recognize still keys under the
 *  same name Stage 2 will look up (base:{} then reads as "unresolved" via
 *  its own report path, rather than silently missing the key). */
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
    const baseName = design.printCandidate({ ...candidate, variants: [] })

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
