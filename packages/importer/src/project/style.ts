/**
 * Tailwind class resolution (API.md projection rules): class lists on a node
 * become merged inline declarations (later class wins — Tailwind's own
 * cascade, matched here by simple in-order Object.assign), split into the
 * `style` plane (unprefixed classes) and `styleStates.<hover|focus|active|
 * disabled>` planes (recognized state-variant classes) — then longhand-
 * normalized with the SAME shorthand-expansion rules the engine's own parse
 * uses (reused directly from foundation-engine/src/parse/style.js, not
 * reimplemented — deep import: that module has no public barrel export, but
 * the package has no "exports" map restricting subpath resolution).
 *
 * classIndex keying: see types.ts's CONTRACT FINDING — key = base utility
 * name, prefix stripped (e.g. "bg-blue-500", not "hover:bg-blue-500").
 */
import { expandShorthand } from 'foundation-engine/src/parse/style.js'
import type { FdnNode, ReportLine, StateStyleKey } from 'foundation-engine'
import type { ClassIndex, StateVariant } from '../types.js'

const STATE_VARIANTS: readonly StateVariant[] = ['hover', 'focus', 'active', 'disabled']

interface ParsedClassToken {
  raw: string
  prefix: string | undefined
  base: string
}

/** Split "hover:bg-blue-500" into { prefix: "hover", base: "bg-blue-500" };
 *  "px-4" into { prefix: undefined, base: "px-4" }. Stacked variants
 *  ("dark:hover:bg-blue-500") keep everything before the LAST colon as one
 *  opaque "prefix" string — never resolvable (not a single recognized state
 *  keyword), always dropped as unsupported. */
function parseClassToken(raw: string): ParsedClassToken {
  const lastColon = raw.lastIndexOf(':')
  if (lastColon === -1) return { raw, prefix: undefined, base: raw }
  return { raw, prefix: raw.slice(0, lastColon), base: raw.slice(lastColon + 1) }
}

function normalizeDecls(decls: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [prop, value] of Object.entries(decls)) {
    const expansion = expandShorthand(prop, value)
    if (expansion) Object.assign(out, expansion.longhand)
    else out[prop] = value
  }
  return out
}

export interface ClassResolution {
  style: Record<string, string>
  styleStates: Partial<Record<StateStyleKey, Record<string, string>>>
  /** Class tokens actually applied (resolved), in source order — used by the
   *  sealed-fallback css builder to know exactly which classes are "in use". */
  used: string[]
}

/**
 * Resolve one node's `class` attribute against `classIndex`. Mutates nothing;
 * returns the merged/normalized declarations and pushes report lines for
 * every dropped class (deduped by the caller across the whole artifact).
 */
export function resolveClassList(classAttr: string, classIndex: ClassIndex, report: (line: ReportLine) => void): ClassResolution {
  const tokens = classAttr.split(/\s+/).filter(Boolean)
  const style: Record<string, string> = {}
  const stateAccum: Partial<Record<StateVariant, Record<string, string>>> = {}
  const used: string[] = []

  for (const raw of tokens) {
    const { prefix, base } = parseClassToken(raw)
    const entry = classIndex[base]
    if (!entry) {
      report({
        code: 'import-unprojectable-css',
        severity: 'warning',
        message: `class "${raw}" is not in the compiled classIndex — its declarations are unknown, so it cannot be faithfully projected`,
        detail: { class: raw },
      })
      continue
    }
    if (prefix === undefined) {
      Object.assign(style, entry.base)
      used.push(raw)
      continue
    }
    if ((STATE_VARIANTS as readonly string[]).includes(prefix)) {
      const stateDecls = entry.states?.[prefix as StateVariant]
      if (!stateDecls) {
        report({
          code: 'import-unsupported-variant',
          severity: 'warning',
          message: `class "${raw}" has no resolved declarations for its "${prefix}:" variant — dropped`,
          detail: { class: raw, prefix },
        })
        continue
      }
      stateAccum[prefix as StateVariant] = { ...(stateAccum[prefix as StateVariant] ?? {}), ...stateDecls }
      used.push(raw)
      continue
    }
    report({
      code: 'import-unsupported-variant',
      severity: 'warning',
      message: `class "${raw}" uses variant prefix "${prefix}:" which the subset cannot express — dropped`,
      detail: { class: raw, prefix },
    })
  }

  const styleStates: Partial<Record<StateStyleKey, Record<string, string>>> = {}
  for (const key of STATE_VARIANTS) {
    const decls = stateAccum[key]
    if (decls && Object.keys(decls).length > 0) styleStates[key] = normalizeDecls(decls)
  }

  return { style: normalizeDecls(style), styleStates, used }
}

/** Resolve every `class` attribute in a tree in place, deleting `class`
 *  afterward (API.md: "class attributes are consumed (not emitted)"). */
export function resolveClassesInTree(roots: FdnNode[], classIndex: ClassIndex, report: (line: ReportLine) => void): void {
  const walk = (node: FdnNode): void => {
    const classAttr = node.attrs['class']
    if (classAttr !== undefined) {
      const resolved = resolveClassList(classAttr, classIndex, report)
      node.style = { ...resolved.style, ...node.style }
      for (const [key, decls] of Object.entries(resolved.styleStates)) {
        node.styleStates[key as StateStyleKey] = { ...decls, ...(node.styleStates[key as StateStyleKey] ?? {}) }
      }
      delete node.attrs['class']
    }
    for (const child of node.children) walk(child)
  }
  for (const node of roots) walk(node)
}

// ——— sealed-fallback css (unscoped — bake scopes it, SPEC Q3) ———

function escapeCssIdent(raw: string): string {
  return raw.replace(/[^A-Za-z0-9_-]/g, (c) => `\\${c}`)
}

function serializeCssDecls(decls: Record<string, string>): string {
  return Object.keys(decls)
    .sort()
    .map((k) => `${k}: ${decls[k]};`)
    .join(' ')
}

/** Collect every class token used anywhere in a tree (source order, first
 *  occurrence), for the sealed-fallback css builder. */
export function collectUsedClasses(roots: FdnNode[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  const walk = (node: FdnNode): void => {
    const classAttr = node.attrs['class']
    if (classAttr !== undefined) {
      for (const raw of classAttr.split(/\s+/).filter(Boolean)) {
        if (!seen.has(raw)) {
          seen.add(raw)
          out.push(raw)
        }
      }
    }
    for (const child of node.children) walk(child)
  }
  for (const node of roots) walk(node)
  return out
}

/**
 * Serialize the classIndex rules for `usedClasses` into plain (unscoped) css
 * — API.md: "css = the classIndex rules for the classes used, serialized
 * (base + state pseudo-classes), unscoped (bake scopes it)". Selectors use
 * the LITERAL class token (escaped for CSS, since Tailwind's own colon-bearing
 * variant classes like "hover:bg-blue-500" are exactly what appears in the
 * sealed html's untouched class="" attribute).
 */
export function serializeSealedCss(usedClasses: string[], classIndex: ClassIndex, report: (line: ReportLine) => void): string {
  const rules: string[] = []
  for (const raw of usedClasses) {
    const { prefix, base } = parseClassToken(raw)
    const entry = classIndex[base]
    if (!entry) {
      report({
        code: 'import-unprojectable-css',
        severity: 'warning',
        message: `class "${raw}" is not in the compiled classIndex — omitted from the sealed capsule's css`,
        detail: { class: raw },
      })
      continue
    }
    const selector = `.${escapeCssIdent(raw)}`
    if (prefix === undefined) {
      if (Object.keys(entry.base).length > 0) rules.push(`${selector} { ${serializeCssDecls(entry.base)} }`)
      continue
    }
    if ((STATE_VARIANTS as readonly string[]).includes(prefix)) {
      const decls = entry.states?.[prefix as StateVariant]
      if (decls && Object.keys(decls).length > 0) rules.push(`${selector}:${prefix} { ${serializeCssDecls(decls)} }`)
      continue
    }
    // unsupported prefix — sealed capsules also can't express @media-shaped
    // variants (SPEC Q3: pseudo-classes + transitions only); silently omitted
    // here (already reported once during the native attempt in most cases;
    // when sealed is forced up front — e.g. --sealed — report it now).
    report({
      code: 'import-unsupported-variant',
      severity: 'warning',
      message: `class "${raw}" uses variant prefix "${prefix}:" which sealed capsule css cannot express — omitted`,
      detail: { class: raw, prefix },
    })
  }
  return rules.join('\n')
}
