/**
 * Sealed-capsule bake support (SPEC D3 / Q3, resolved; API.md Wave 4).
 *
 * A sealed FdnComponent's body is opaque: `{ html, css }` produced by the
 * importer, excluded from edit/diff. At bake time it becomes:
 *   - a `<div class="fdn-capsule-<name>">` wrapper around the parsed html
 *     (parsed here — NOT re-run through the subset grammar/validator, since
 *     sealed content is explicitly exempt from D1 normalization; it is
 *     rendered as-authored),
 *   - its css, naive-selector-prefixed under `.fdn-capsule-<name>` and
 *     collected into the document's <style> block by bake/index.ts.
 *
 * Kept as its own module (not folded into bake/index.ts) to keep the
 * sealed-capsule surface — the one piece of "surgical" bake work this wave
 * asked for — reviewable in isolation.
 */
import { parseFragment } from 'parse5'
import type { DefaultTreeAdapterTypes as T5 } from 'parse5'
import type { FdnNode } from '../types.js'

type Node = T5.Node
type ElementNode = T5.Element

function isElement(n: Node): n is ElementNode {
  return 'tagName' in n
}

function isText(n: Node): n is T5.TextNode {
  return n.nodeName === '#text'
}

function childNodesOf(n: Node): Node[] {
  return 'childNodes' in n ? (n as T5.ParentNode).childNodes : []
}

interface Counter {
  n: number
}

/**
 * Convert one parsed element into the same FdnNode shape the rest of bake's
 * emit pipeline already knows how to render — reusing emit.ts's generic
 * renderNode instead of inventing a second raw-HTML rendering path. Sealed
 * content is opaque (D3): attributes (including `class`) are copied verbatim,
 * with no grammar/exclusion filtering — this is authored output, not subset
 * input. Known engine-wide limitation, same one native bodies already have
 * (see types.ts's FdnNode.text doc comment and bake/index.ts's
 * buildRegularNode): text and element children are mutually exclusive in the
 * render path, so interleaved text ("Hello <b>World</b>") loses the text runs
 * when the node also has element children. Acceptable for the importer's
 * target fixtures (buttons/badges/icons are leaf-text or element-only).
 */
function convertSealedElement(el: ElementNode, idPrefix: string, counter: Counter): FdnNode {
  const attrs: Record<string, string> = {}
  for (const a of el.attrs) attrs[a.name] = a.value

  const children: FdnNode[] = []
  for (const c of childNodesOf(el)) {
    if (isElement(c)) children.push(convertSealedElement(c, idPrefix, counter))
  }
  let text: string | undefined
  if (children.length === 0) {
    const raw = childNodesOf(el)
      .filter(isText)
      .map((t) => t.value)
      .join('')
    if (raw) text = raw
  }

  counter.n += 1
  return {
    id: `${idPrefix}~${counter.n}`,
    tag: el.tagName.toLowerCase(),
    attrs,
    style: {},
    styleStates: {},
    text,
    children,
  }
}

/** Parse a sealed capsule's raw html fragment into FdnNode-shaped roots,
 *  ready to embed as children of the `<div class="fdn-capsule-…">` wrapper. */
export function parseSealedFragment(html: string, idPrefix: string): FdnNode[] {
  const frag = parseFragment(html)
  const counter: Counter = { n: 0 }
  const roots: FdnNode[] = []
  for (const c of frag.childNodes) {
    if (isElement(c)) roots.push(convertSealedElement(c, idPrefix, counter))
  }
  return roots
}

// ——— naive CSS selector scoping (v1: documented limit, see module doc) ———

/** Split a flat CSS text into top-level `selector { body }` rules. Does not
 *  understand at-rules (`@media`, `@supports`, …) — a sealed capsule's css is
 *  produced by the importer from resolved Tailwind declarations (base +
 *  pseudo-class state planes only, SPEC Q3), which never contains at-rules in
 *  v0; a stray at-rule block is left untouched (selector text is emitted as
 *  the literal at-rule with NO capsule prefix — recorded limitation, not a
 *  silent drop). */
function splitTopLevelRules(css: string): { selector: string; body: string }[] {
  const rules: { selector: string; body: string }[] = []
  let i = 0
  while (i < css.length) {
    const open = css.indexOf('{', i)
    if (open === -1) break
    const selector = css.slice(i, open).trim()
    let depth = 1
    let j = open + 1
    while (j < css.length && depth > 0) {
      if (css[j] === '{') depth++
      else if (css[j] === '}') depth--
      j++
    }
    const body = css.slice(open + 1, Math.max(open + 1, j - 1))
    if (selector) rules.push({ selector, body })
    i = j
  }
  return rules
}

/** Naive v1 scoping (API.md: "naive prefix is acceptable v1 — document
 *  limits"): every comma-separated selector in every top-level rule gets
 *  `.fdn-capsule-<name> ` prepended as a descendant combinator. Known limits:
 *  no at-rule support (@media/@supports pass through unprefixed — see
 *  splitTopLevelRules doc), no handling of `:root`/`html`/`body` selectors
 *  (which a capsule's rules should never contain — importer-produced css is
 *  always plain class + state-pseudo-class selectors), and the wrapper div
 *  adds one extra layout box the original render output did not have. */
export function scopeCss(css: string, capsuleClass: string): string {
  const rules = splitTopLevelRules(css)
  const out: string[] = []
  for (const { selector, body } of rules) {
    const scoped = selector
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => `.${capsuleClass} ${s}`)
      .join(', ')
    out.push(`${scoped} {${body}}`)
  }
  return out.join('\n')
}

export function capsuleClassName(componentName: string): string {
  return `fdn-capsule-${componentName}`
}
