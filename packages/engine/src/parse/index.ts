/**
 * foundation-engine — parse: `.fdn.html` text -> FdnDocument + NormalizationReport.
 *
 * Liberal ingestion, strict projection (D1/D4): this module accepts loose-ish
 * hand-authored HTML (see boards/*.fdn.html) and produces the typed template-form
 * document (SPEC Q10). Every rewrite and drop is named in the returned report.
 */
import { parse } from 'parse5'
import type { DefaultTreeAdapterTypes as T5 } from 'parse5'
import {
  DATA_FDN_PREFIX,
  excludedStylePropertyMessage,
  isExcludedAttr,
  isExcludedElement,
  isKnownTag,
  STATE_STYLE_ATTRS,
} from '../grammar/schema.js'
import type {
  FdnAnnotation,
  FdnComponent,
  FdnDataSet,
  FdnDocument,
  FdnLookup,
  FdnNamedStyle,
  FdnNode,
  FdnParam,
  FdnParamType,
  FdnProp,
  FdnState,
  FdnViewport,
  NormalizationReport,
  ReportLine,
  StateStyleKey,
} from '../types.js'
import { expandShorthand, parseDeclarations, splitDeclarations } from './style.js'

type Node = T5.Node
type ElementNode = T5.Element
type ParentNode = T5.ParentNode

const DEFAULT_SPEC_VERSION = '0.0.1-draft'
const STATE_PLANES: StateStyleKey[] = ['hover', 'focus', 'active', 'disabled']

// ——————————————————————————————————————————————————————————————————————————
// pre-parse text normalization
// ——————————————————————————————————————————————————————————————————————————

/**
 * The HTML5 tree construction algorithm only honors self-closing `/>` for VOID
 * elements and foreign (SVG/MathML) content — for ANY other tag, including every
 * `fdn-*` custom element, a spec-conformant parser (parse5 included — verified
 * empirically against this exact input shape) silently ignores the slash and
 * keeps consuming FOLLOWING SIBLINGS as children until a real closing tag shows
 * up. The board fixtures self-close `fdn-*` leaf elements pervasively
 * (`<fdn-param .../>`, `<fdn-style .../>`, `<fdn-use .../>`, …) as siblings —
 * under real HTML5 parsing this silently nests each one inside the previous,
 * which is not what any author intended and is not what "opens meaningfully in
 * a plain browser" was actually verified against (GRAMMAR-FINDINGS.md's
 * well-formedness check used a non-tree-construction-accurate parser). This is
 * liberal ingestion (D1): rewrite the author's clear intent — self-closing
 * `fdn-*` tags — into an explicit open/close pair BEFORE handing text to
 * parse5, so the rest of the pipeline sees the tree the author meant.
 */
const SELF_CLOSING_FDN_TAG_RE =
  /<(fdn-[a-z0-9-]+)((?:\s+[a-zA-Z][a-zA-Z0-9-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*\/>/g

function normalizeSelfClosingFdnTags(html: string, lines: ReportLine[]): string {
  let count = 0
  const out = html.replace(SELF_CLOSING_FDN_TAG_RE, (_m, tag: string, attrs: string) => {
    count++
    return `<${tag}${attrs}></${tag}>`
  })
  if (count > 0) {
    lines.push({
      code: 'self-closing-tag-normalized',
      severity: 'info',
      message: `${count} self-closing fdn-* tag(s) rewritten to explicit open/close pairs — HTML5 tree construction ignores "/>" on non-void, non-foreign elements`,
      detail: { count },
    })
  }
  return out
}

// ——————————————————————————————————————————————————————————————————————————
// parse5 tree helpers
// ——————————————————————————————————————————————————————————————————————————

function isElement(n: Node): n is ElementNode {
  return 'tagName' in n
}

function isText(n: Node): n is T5.TextNode {
  return n.nodeName === '#text'
}

function isComment(n: Node): n is T5.CommentNode {
  return n.nodeName === '#comment'
}

function childNodesOf(n: Node): Node[] {
  return 'childNodes' in n ? (n as ParentNode).childNodes : []
}

function childElements(n: Node): ElementNode[] {
  return childNodesOf(n).filter(isElement)
}

function directChildrenByTag(n: Node, tag: string): ElementNode[] {
  return childElements(n).filter((e) => e.tagName.toLowerCase() === tag)
}

function findDeep(n: Node, tag: string): ElementNode | null {
  if (isElement(n) && n.tagName.toLowerCase() === tag) return n
  for (const c of childNodesOf(n)) {
    const found = findDeep(c, tag)
    if (found) return found
  }
  return null
}

function attrsOf(el: ElementNode): Record<string, string> {
  const out: Record<string, string> = {}
  for (const a of el.attrs) out[a.name] = a.value
  return out
}

function directTextOf(el: ElementNode): string {
  return childNodesOf(el)
    .filter(isText)
    .map((t) => t.value)
    .join('')
}

// ——————————————————————————————————————————————————————————————————————————
// value coercion
// ——————————————————————————————————————————————————————————————————————————

/**
 * Coerce a raw attribute string through a param/prop's declared type — shared
 * by `<fdn-param default="…">` and `<fdn-state>` assignments (friction §2:
 * these MUST agree, or a state can silently bind a string where bake expects
 * a real boolean/number). Only the two literal spellings "true"/"false" are
 * recognized booleans and only numeric text is a real number; anything else
 * is left as the original string so validate can flag the mismatch (typeof
 * won't match the declared type) instead of silently miscoercing it.
 */
function coerce(type: FdnParamType | undefined, raw: string): unknown {
  switch (type) {
    case 'boolean':
      if (raw === 'true') return true
      if (raw === 'false') return false
      return raw
    case 'number': {
      const n = Number(raw)
      return Number.isNaN(n) ? raw : n
    }
    default:
      return raw
  }
}

// ——————————————————————————————————————————————————————————————————————————
// node-id minting (API.md "node identity")
// ——————————————————————————————————————————————————————————————————————————

const MINTED_ID_RE = /^n(\d+)$/

function scanMaxMintedId(root: Node): number {
  let max = 0
  const walk = (n: Node): void => {
    if (isElement(n)) {
      const id = attrsOf(n)['data-fdn-id']
      if (id) {
        const m = MINTED_ID_RE.exec(id)
        if (m?.[1] !== undefined) max = Math.max(max, Number(m[1]))
      }
    }
    for (const c of childNodesOf(n)) walk(c)
  }
  walk(root)
  return max
}

class IdMinter {
  constructor(private counter: number) {}
  mint(): string {
    this.counter += 1
    return `n${this.counter}`
  }
}

// ——————————————————————————————————————————————————————————————————————————
// style declaration normalization (shared by style="" lift and named styles)
// ——————————————————————————————————————————————————————————————————————————

function normalizeDeclBag(
  input: Record<string, string>,
  nodeId: string | undefined,
  lines: ReportLine[],
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [prop, value] of Object.entries(input)) {
    const excludedMsg = excludedStylePropertyMessage(prop)
    if (excludedMsg) {
      lines.push({
        code: 'excluded-style-property-dropped',
        severity: 'warning',
        message: excludedMsg,
        ...(nodeId ? { nodeId } : {}),
        detail: { property: prop, value },
      })
      continue
    }
    const expansion = expandShorthand(prop, value)
    if (expansion) {
      Object.assign(out, expansion.longhand)
      lines.push({
        code: 'shorthand-expanded',
        severity: 'info',
        message: `${prop}: ${value} -> ${expansion.expandedTo.join(', ')}`,
        ...(nodeId ? { nodeId } : {}),
        detail: { property: prop, value, expandedTo: expansion.expandedTo },
      })
    } else {
      out[prop] = value
    }
  }
  return out
}

function parseAndNormalizeDeclString(text: string, nodeId: string | undefined, lines: ReportLine[]): Record<string, string> {
  return normalizeDeclBag(parseDeclarations(text), nodeId, lines)
}

// ——————————————————————————————————————————————————————————————————————————
// element -> FdnNode conversion (main body + component bodies, template form)
// ——————————————————————————————————————————————————————————————————————————

interface ConvertCtx {
  minter: IdMinter
  lines: ReportLine[]
  /** Count of text nodes whose whitespace was collapsed/trimmed — summarized
   *  once at the end rather than per-node (see normalizeTextWhitespace). */
  textNormalizedCount: number
}

/**
 * Collapse HTML's insignificant pretty-printing whitespace: leading/trailing
 * runs and internal runs of whitespace (spaces, tabs, newlines from indented
 * source) collapse to a single space, matching how a browser visually renders
 * block-formatted markup. This is NOT the D1 "arbitrary values are never
 * snapped" rule (that governs style/CSS values) — it is standard HTML
 * whitespace handling, and without it `parse(project(doc))` can never reach a
 * fixpoint: this module's own canonical projection never re-emits the source's
 * incidental indentation, so an ingested document that kept it raw would never
 * match what re-parsing its own projection produces.
 */
function normalizeTextWhitespace(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim()
}

function hasNonWhitespaceContent(el: ElementNode): boolean {
  for (const c of childNodesOf(el)) {
    if (isText(c) && c.value.trim()) return true
    if (isElement(c)) return true
  }
  return false
}

function convertElement(el: ElementNode, ctx: ConvertCtx): FdnNode | null {
  const tag = el.tagName.toLowerCase()

  if (isExcludedElement(tag)) {
    ctx.lines.push({
      code: 'excluded-element-dropped',
      severity: 'warning',
      message: `<${tag}> is not in the subset (scripting/embedded-browsing-context exclusion) and was dropped`,
      detail: { tag },
    })
    return null
  }
  if (!isKnownTag(tag)) {
    ctx.lines.push({
      code: 'unknown-element-dropped',
      severity: 'warning',
      message: `<${tag}> is neither an HTML5 element nor a declared fdn-* element and was dropped`,
      detail: { tag },
    })
    return null
  }

  const rawAttrs = attrsOf(el)
  const id = rawAttrs['data-fdn-id'] ?? ctx.minter.mint()

  const attrs: Record<string, string> = {}
  let style: Record<string, string> = {}
  let styleRef: string | undefined
  const styleStates: Partial<Record<StateStyleKey, Record<string, string>>> = {}
  let when: string | undefined
  let each: string | undefined
  const legacyWhenParts: string[] = []

  for (const [name, value] of Object.entries(rawAttrs)) {
    const lower = name.toLowerCase()
    if (lower === 'data-fdn-id') continue
    if (lower === 'style') {
      style = parseAndNormalizeDeclString(value, id, ctx.lines)
      continue
    }
    if (lower === 'data-fdn-style') {
      styleRef = value
      continue
    }
    if (lower === 'when') {
      when = value
      continue
    }
    if (lower === 'data-fdn-when') {
      // legacy convention seen in boards/inbox-unified.fdn.html — folded into `when`
      // (types.ts has no separate field for it; see final-report contract finding).
      legacyWhenParts.push(value)
      continue
    }
    if (lower === 'each') {
      each = value
      continue
    }
    if (lower === 'data-fdn-each-filter') {
      // legacy convention: an extra per-iteration guard alongside `each`. `when`
      // already means "conditional presence", so it is the correct home for this.
      legacyWhenParts.push(value)
      continue
    }
    const stateIdx = (STATE_STYLE_ATTRS as readonly string[]).indexOf(lower)
    if (stateIdx !== -1) {
      const plane = STATE_PLANES[stateIdx]
      if (plane) styleStates[plane] = parseAndNormalizeDeclString(value, id, ctx.lines)
      continue
    }
    if (isExcludedAttr(lower)) {
      ctx.lines.push({
        code: 'excluded-attribute-dropped',
        severity: 'warning',
        message: `attribute "${lower}" is not in the subset (event-handler / live-media-behavior exclusion) and was dropped`,
        nodeId: id,
        detail: { attribute: lower, value },
      })
      continue
    }
    attrs[name] = value
  }

  if (legacyWhenParts.length > 0) {
    const combined = when ? [when, ...legacyWhenParts] : legacyWhenParts
    when = combined.length === 1 ? combined[0] : combined.map((p) => `(${p})`).join(' && ')
    ctx.lines.push({
      code: 'legacy-attr-folded',
      severity: 'info',
      message: 'legacy data-fdn-when / data-fdn-each-filter attribute folded into `when`',
      nodeId: id,
      detail: { when },
    })
  }

  const node: FdnNode = {
    id,
    tag,
    attrs,
    style,
    styleStates,
    children: [],
  }
  if (styleRef !== undefined) node.styleRef = styleRef
  if (when !== undefined) node.when = when
  if (each !== undefined) node.each = each

  if (tag === 'fdn-use') {
    // SPEC Q10 / API.md: resolved <fdn-use> children are derived bake output, not
    // canonical. Collapse back to template form: keep the instance + its prop
    // bindings, drop any resolved subtree that came along in the source text.
    if (hasNonWhitespaceContent(el)) {
      ctx.lines.push({
        code: 'resolved-instance-collapsed',
        severity: 'info',
        message: 'resolved <fdn-use> children are a derived bake artifact — collapsed to template form',
        nodeId: id,
      })
    }
    return node
  }

  const textParts: string[] = []
  const children: FdnNode[] = []
  for (const c of childNodesOf(el)) {
    if (isText(c)) {
      textParts.push(c.value)
    } else if (isComment(c)) {
      // author comments are not part of the document model (D1: lossy-but-total).
      continue
    } else if (isElement(c)) {
      const child = convertElement(c, ctx)
      if (child) children.push(child)
    }
  }
  const raw = textParts.join('')
  const text = normalizeTextWhitespace(raw)
  if (text !== raw) ctx.textNormalizedCount++
  if (text) node.text = text
  node.children = children
  return node
}

/**
 * friction §1: `<main>`/`<body>` are treated as pure wrappers — only their
 * CHILDREN become the document body, so any `style`/`data-fdn-style` the
 * wrapper itself carries (page padding, page background, …) is silently
 * discarded. Honoring those styles is a bigger model change (the document
 * model has no "root wrapper" node to carry them on — recorded as a follow-up
 * rather than done here); until then, name what was lost so it's at least
 * discoverable instead of a same-render-cycle-as-the-bee mystery.
 */
function reportRootWrapperStylesDropped(el: ElementNode, tag: string, lines: ReportLine[]): void {
  const raw = attrsOf(el)
  const lost: Record<string, string> = {}
  if (raw.style) lost.style = raw.style
  if (raw['data-fdn-style']) lost['data-fdn-style'] = raw['data-fdn-style']
  if (Object.keys(lost).length === 0) return
  const described = Object.entries(lost)
    .map(([k, v]) => `${k}="${v}"`)
    .join(' ')
  lines.push({
    code: 'root-wrapper-styles-dropped',
    severity: 'warning',
    message: `<${tag}> carries its own ${described} — only <${tag}>'s CHILDREN become the document body, so this was dropped, not honored. Honoring page-level wrapper styles is a bigger model change (recorded follow-up, not fixed here); for now, wrap the intended content in an inner element to carry these styles instead.`,
    detail: { tag, ...lost },
  })
}

function convertChildren(parent: Node, ctx: ConvertCtx): FdnNode[] {
  const out: FdnNode[] = []
  for (const c of childElements(parent)) {
    const node = convertElement(c, ctx)
    if (node) out.push(node)
  }
  return out
}

// ——————————————————————————————————————————————————————————————————————————
// :root token block
// ——————————————————————————————————————————————————————————————————————————

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

function parseTokens(headEl: ElementNode | undefined, lines: ReportLine[]): Record<string, string> {
  const tokens: Record<string, string> = {}
  if (!headEl) return tokens
  for (const styleEl of directChildrenByTag(headEl, 'style')) {
    const css = directTextOf(styleEl)
    for (const rule of splitTopLevelRules(css)) {
      if (rule.selector !== ':root') {
        lines.push({
          code: 'non-root-style-rule-dropped',
          severity: 'warning',
          message: `<style> rule "${rule.selector}" is not a :root token declaration and was dropped — the subset carries styles on nodes/named styles, not stylesheets`,
          detail: { selector: rule.selector },
        })
        continue
      }
      for (const raw of splitDeclarations(rule.body)) {
        const decl = raw.trim()
        if (!decl) continue
        const colon = decl.indexOf(':')
        if (colon === -1) continue
        const name = decl.slice(0, colon).trim()
        const value = decl.slice(colon + 1).trim()
        if (!name.startsWith('--') || !value) continue
        // API contract (types.ts): tokens are stored WITHOUT the leading `--`.
        tokens[name.slice(2)] = value
      }
    }
  }
  return tokens
}

// ——————————————————————————————————————————————————————————————————————————
// fdn-doc header block
// ——————————————————————————————————————————————————————————————————————————

function parseParams(fdnDoc: ElementNode): FdnParam[] {
  const wrapper = directChildrenByTag(fdnDoc, 'fdn-params')[0]
  if (!wrapper) return []
  return directChildrenByTag(wrapper, 'fdn-param').map((el) => {
    const a = attrsOf(el)
    const type = (a.type as FdnParamType) ?? 'string'
    const param: FdnParam = { name: a.name ?? '', type }
    if (a.values) param.values = a.values.split(',').map((s) => s.trim())
    if (a.default !== undefined) param.default = coerce(type, a.default)
    if (a.description) param.description = a.description
    return param
  })
}

function parseDataSets(fdnDoc: ElementNode): FdnDataSet[] {
  return directChildrenByTag(fdnDoc, 'fdn-data').map((el) => {
    const name = attrsOf(el).name ?? ''
    const items = directChildrenByTag(el, 'fdn-item').map((itemEl) => {
      const a = attrsOf(itemEl)
      const item: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(a)) item[k] = v
      return item
    })
    return { name, items }
  })
}

function parseLookups(fdnDoc: ElementNode): FdnLookup[] {
  const out: FdnLookup[] = []
  const collect = (lookupEl: ElementNode): void => {
    const name = attrsOf(lookupEl).name ?? ''
    const entries: Record<string, string> = {}
    for (const entryEl of directChildrenByTag(lookupEl, 'fdn-entry')) {
      const a = attrsOf(entryEl)
      if (a.key !== undefined && a.value !== undefined) entries[a.key] = a.value
    }
    out.push({ name, entries })
  }
  for (const el of directChildrenByTag(fdnDoc, 'fdn-lookup')) collect(el)
  const wrapper = directChildrenByTag(fdnDoc, 'fdn-lookups')[0]
  if (wrapper) for (const el of directChildrenByTag(wrapper, 'fdn-lookup')) collect(el)
  return out
}

function parseStates(fdnDoc: ElementNode, params: FdnParam[]): FdnState[] {
  const wrapper = directChildrenByTag(fdnDoc, 'fdn-states')[0]
  if (!wrapper) return []
  const paramByName = new Map(params.map((p) => [p.name, p]))
  return directChildrenByTag(wrapper, 'fdn-state').map((el) => {
    const a = attrsOf(el)
    const state: FdnState = { name: a.name ?? '', assignments: {} }
    if (a.viewport) state.viewport = a.viewport
    for (const [k, v] of Object.entries(a)) {
      if (k === 'name' || k === 'viewport') continue
      const param = paramByName.get(k)
      if (!param) continue
      // friction §2 (real bug): defaults go through `coerce(type, …)`, state
      // assignments did not — a boolean param assigned "false" by a state
      // bound the STRING "false", which isTruthy() treats as true. Route
      // assignments through the identical coercion defaults already use.
      state.assignments[k] = coerce(param.type, v)
    }
    return state
  })
}

function parseMatrix(fdnDoc: ElementNode): { viewports: FdnViewport[]; matrix: { state: string; viewport: string }[] } {
  const wrapper = directChildrenByTag(fdnDoc, 'fdn-matrix')[0]
  if (!wrapper) return { viewports: [], matrix: [] }
  const viewports = directChildrenByTag(wrapper, 'fdn-viewport').map((el) => {
    const a = attrsOf(el)
    return { name: a.name ?? '', width: Number(a.width ?? 0), height: Number(a.height ?? 0) }
  })
  const matrix = directChildrenByTag(wrapper, 'fdn-cell').map((el) => {
    const a = attrsOf(el)
    return { state: a.state ?? '', viewport: a.viewport ?? '' }
  })
  return { viewports, matrix }
}

/**
 * `<fdn-annotations>` (SPEC D2/D4/13a: spatial annotations are first-class
 * chain citizens, hidden metadata in projection — never rendered, never
 * baked). Lives inside `<fdn-doc>` alongside fdn-params/fdn-states/etc.
 * Annotation text is extracted RAW via directTextOf (not
 * normalizeTextWhitespace) — same reasoning as parseSealed's html/css:
 * significant whitespace in an author's annotation text must round-trip
 * byte-for-byte for the parse(project(doc)) fixpoint to hold, and
 * project/index.ts's emitAnnotation mirrors this with a one-line
 * emitTextLeaf-style emission for exactly that reason.
 */
function parseAnnotations(fdnDoc: ElementNode): FdnAnnotation[] {
  const wrapper = directChildrenByTag(fdnDoc, 'fdn-annotations')[0]
  if (!wrapper) return []
  return directChildrenByTag(wrapper, 'fdn-annotation').map((el) => {
    const a = attrsOf(el)
    const annotation: FdnAnnotation = {
      id: a.id ?? '',
      text: directTextOf(el),
      status: (a.status as FdnAnnotation['status']) ?? 'open',
    }
    if (a['node-id'] !== undefined) annotation.nodeId = a['node-id']
    if (a.x !== undefined) annotation.x = Number(a.x)
    if (a.y !== undefined) annotation.y = Number(a.y)
    if (a.state !== undefined) annotation.state = a.state
    return annotation
  })
}

// ——————————————————————————————————————————————————————————————————————————
// fdn-styles
// ——————————————————————————————————————————————————————————————————————————

function parseNamedStyles(body: ElementNode, lines: ReportLine[]): FdnNamedStyle[] {
  const wrapper = directChildrenByTag(body, 'fdn-styles')[0]
  if (!wrapper) return []
  return directChildrenByTag(wrapper, 'fdn-style').map((el) => {
    const a = attrsOf(el)
    const name = a.name ?? ''
    const base: Record<string, string> = {}
    const styleStates: Partial<Record<StateStyleKey, Record<string, string>>> = {}
    for (const [k, v] of Object.entries(a)) {
      if (k === 'name') continue
      const stateIdx = (STATE_STYLE_ATTRS as readonly string[]).indexOf(k)
      if (stateIdx !== -1) {
        const plane = STATE_PLANES[stateIdx]
        if (plane) styleStates[plane] = parseAndNormalizeDeclString(v, undefined, lines)
        continue
      }
      Object.assign(base, normalizeDeclBag({ [k]: v }, undefined, lines))
    }
    return { name, style: base, styleStates }
  })
}

// ——————————————————————————————————————————————————————————————————————————
// fdn-component
// ——————————————————————————————————————————————————————————————————————————

function collectSlotNames(nodes: FdnNode[], out: Set<string>): void {
  for (const n of nodes) {
    if (n.tag === 'fdn-slot' && n.attrs.name) out.add(n.attrs.name)
    collectSlotNames(n.children, out)
  }
}

/**
 * `<fdn-sealed><fdn-sealed-html>…</fdn-sealed-html><fdn-sealed-css>…</fdn-sealed-css></fdn-sealed>`
 * — the sealed-capsule canonical representation (SPEC D3/Q3, coordinated with
 * project/index.ts's emitSealed). html/css are carried as ordinary (entity-escaped)
 * text content, decoded automatically by parse5's tree construction — no CDATA
 * trick needed since parse5 treats these as regular elements, not raw-text
 * elements like <script>/<style>. Extraction uses directTextOf (NOT
 * normalizeTextWhitespace) because sealed content must round-trip byte-for-byte:
 * collapsing whitespace here would break the parse(project(doc)) fixpoint for
 * any capsule whose html/css contains significant whitespace.
 */
function parseSealed(componentEl: ElementNode): { html: string; css: string } | undefined {
  const wrapper = directChildrenByTag(componentEl, 'fdn-sealed')[0]
  if (!wrapper) return undefined
  const htmlEl = directChildrenByTag(wrapper, 'fdn-sealed-html')[0]
  const cssEl = directChildrenByTag(wrapper, 'fdn-sealed-css')[0]
  return {
    html: htmlEl ? directTextOf(htmlEl) : '',
    css: cssEl ? directTextOf(cssEl) : '',
  }
}

function parseComponents(body: ElementNode, ctx: ConvertCtx): FdnComponent[] {
  return directChildrenByTag(body, 'fdn-component').map((el) => {
    const a = attrsOf(el)
    const name = a.name ?? ''
    const propsWrapper = directChildrenByTag(el, 'fdn-props')[0]
    const props: FdnProp[] = propsWrapper
      ? directChildrenByTag(propsWrapper, 'fdn-prop').map((propEl) => {
          const pa = attrsOf(propEl)
          const type = (pa.type as FdnParamType) ?? 'string'
          const prop: FdnProp = { name: pa.name ?? '', type }
          if (pa.required !== undefined) prop.required = pa.required === 'true'
          if (pa.default !== undefined) prop.default = coerce(type, pa.default)
          return prop
        })
      : []

    const sealed = parseSealed(el)

    const bodyNodes: FdnNode[] = []
    for (const c of childElements(el)) {
      const ctag = c.tagName.toLowerCase()
      if (ctag === 'fdn-props' || ctag === 'fdn-sealed') continue
      const node = convertElement(c, ctx)
      if (node) bodyNodes.push(node)
    }
    const slots = new Set<string>()
    collectSlotNames(bodyNodes, slots)

    const component: FdnComponent = { name, props, slots: [...slots], body: bodyNodes }
    if (sealed) component.sealed = sealed
    if (a['data-fdn-import-source'] !== undefined || a['data-fdn-import-sha256'] !== undefined) {
      component.provenance = {
        source: a['data-fdn-import-source'] ?? '',
        contentSha256: a['data-fdn-import-sha256'] ?? '',
      }
    }
    return component
  })
}

// ——————————————————————————————————————————————————————————————————————————
// main entry
// ——————————————————————————————————————————————————————————————————————————

export function parseDocument(html: string): { doc: FdnDocument; report: NormalizationReport } {
  const lines: ReportLine[] = []
  const normalizedHtml = normalizeSelfClosingFdnTags(html, lines)
  const document = parse(normalizedHtml)

  const htmlEl = childElements(document).find((e) => e.tagName.toLowerCase() === 'html')
  const headEl = htmlEl ? directChildrenByTag(htmlEl, 'head')[0] : undefined
  const bodyEl = htmlEl ? directChildrenByTag(htmlEl, 'body')[0] : (findDeep(document, 'body') ?? undefined)

  const tokens = parseTokens(headEl, lines)

  const fdnDoc = bodyEl ? (directChildrenByTag(bodyEl, 'fdn-doc')[0] ?? findDeep(bodyEl, 'fdn-doc')) : null

  let specVersion = DEFAULT_SPEC_VERSION
  let title: string | undefined
  let params: FdnParam[] = []
  let data: FdnDataSet[] = []
  let lookups: FdnLookup[] = []
  let states: FdnState[] = []
  let viewports: FdnViewport[] = []
  let matrix: { state: string; viewport: string }[] = []
  let annotations: FdnAnnotation[] = []

  if (fdnDoc) {
    const a = attrsOf(fdnDoc)
    if (a['data-fdn-spec-version']) specVersion = a['data-fdn-spec-version']
    else
      lines.push({
        code: 'spec-version-defaulted',
        severity: 'warning',
        message: `no data-fdn-spec-version on <fdn-doc> — defaulted to ${DEFAULT_SPEC_VERSION}`,
      })
    if (a['data-fdn-title']) title = a['data-fdn-title']
    params = parseParams(fdnDoc)
    data = parseDataSets(fdnDoc)
    lookups = parseLookups(fdnDoc)
    states = parseStates(fdnDoc, params)
    const m = parseMatrix(fdnDoc)
    viewports = m.viewports
    matrix = m.matrix
    annotations = parseAnnotations(fdnDoc)
  } else {
    lines.push({
      code: 'spec-version-defaulted',
      severity: 'warning',
      message: `no <fdn-doc> header block found — defaulted specVersion to ${DEFAULT_SPEC_VERSION}`,
    })
  }

  const namedStyles = bodyEl ? parseNamedStyles(bodyEl, lines) : []

  // node-id minting: continue from the highest existing minted id anywhere in the
  // raw document (API.md "node identity" — deterministic for a given input text).
  const minter = new IdMinter(scanMaxMintedId(document))
  const ctx: ConvertCtx = { minter, lines, textNormalizedCount: 0 }

  const components = bodyEl ? parseComponents(bodyEl, ctx) : []
  components.sort((a, b) => a.name.localeCompare(b.name))

  let bodyNodes: FdnNode[] = []
  if (bodyEl) {
    reportRootWrapperStylesDropped(bodyEl, 'body', lines)
    const main = directChildrenByTag(bodyEl, 'main')[0]
    if (main) {
      reportRootWrapperStylesDropped(main, 'main', lines)
      bodyNodes = convertChildren(main, ctx)
    } else {
      const skip = new Set(['fdn-doc', 'fdn-styles', 'fdn-component', 'style', 'script', 'title', 'meta', 'link'])
      for (const c of childElements(bodyEl)) {
        if (skip.has(c.tagName.toLowerCase())) continue
        const node = convertElement(c, ctx)
        if (node) bodyNodes.push(node)
      }
    }
  }

  const doc: FdnDocument = {
    specVersion,
    tokens,
    params,
    data,
    lookups,
    states,
    viewports,
    matrix,
    namedStyles,
    components,
    body: bodyNodes,
    annotations,
  }
  if (title !== undefined) doc.title = title

  if (ctx.textNormalizedCount > 0) {
    lines.push({
      code: 'text-whitespace-normalized',
      severity: 'info',
      message: `${ctx.textNormalizedCount} text node(s) had insignificant pretty-printing whitespace collapsed/trimmed`,
      detail: { count: ctx.textNormalizedCount },
    })
  }

  return { doc, report: { lines } }
}
