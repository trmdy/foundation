/**
 * foundation-engine — project: FdnDocument -> canonical text (API.md, deterministic).
 *
 * IMPORTANT parse5 correctness note (verified empirically): the HTML5 tree
 * construction algorithm only honors the self-closing `/>` flag for VOID elements
 * and foreign (SVG/MathML) content — for every other tag (including every `fdn-*`
 * custom element) the trailing slash is silently ignored and the parser keeps
 * reading following siblings AS CHILDREN until it sees a real `</tag>`. Emitting
 * `<fdn-use .../>` followed by more sibling markup would therefore corrupt the
 * very next parse. This projector never self-closes anything except the fixed set
 * of true HTML void elements — every fdn-* element and every non-void HTML element
 * always gets an explicit `<tag>…</tag>`, even when empty.
 */
import type { FdnAnnotation, FdnComponent, FdnDocument, FdnNamedStyle, FdnNode, StateStyleKey } from '../types.js'
import { serializeDeclarations } from '../parse/style.js'
import { STATE_STYLE_ATTRS } from '../grammar/schema.js'

const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr',
])

const STATE_PLANES: StateStyleKey[] = ['hover', 'focus', 'active', 'disabled']

function escapeAttr(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
}

function escapeText(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

class Writer {
  private lines: string[] = []
  push(depth: number, text: string): void {
    this.lines.push(text === '' ? '' : `${'  '.repeat(depth)}${text}`)
  }
  /** Append `suffix` directly onto the most recently pushed line (used to
   *  collapse an empty element's open/close tags onto one line). */
  appendToLast(suffix: string): void {
    const idx = this.lines.length - 1
    if (idx >= 0) this.lines[idx] = `${this.lines[idx]}${suffix}`
  }
  toString(): string {
    return this.lines.join('\n')
  }
}

function attrPairs(pairs: [string, string][]): string {
  return pairs.map(([k, v]) => `${k}="${escapeAttr(v)}"`).join(' ')
}

/** Emit an element with an explicit open/close pair (or a void tag). `inner`
 *  renders the element's content at `depth + 1`; return true if it wrote anything. */
function emitElement(
  w: Writer,
  depth: number,
  tag: string,
  attrs: [string, string][],
  inner: ((depth: number) => boolean) | null,
): void {
  const attrText = attrs.length > 0 ? ` ${attrPairs(attrs)}` : ''
  if (VOID_ELEMENTS.has(tag)) {
    w.push(depth, `<${tag}${attrText}>`)
    return
  }
  if (!inner) {
    w.push(depth, `<${tag}${attrText}></${tag}>`)
    return
  }
  w.push(depth, `<${tag}${attrText}>`)
  const wroteAny = inner(depth + 1)
  if (!wroteAny) {
    // collapse an empty body back onto one line for tidier output
    w.appendToLast(`</${tag}>`)
    return
  }
  w.push(depth, `</${tag}>`)
}

// ——————————————————————————————————————————————————————————————————————————
// FdnNode canonical attribute ordering (API.md "Canonical text rules")
// ——————————————————————————————————————————————————————————————————————————

function nodeAttrPairs(node: FdnNode): [string, string][] {
  const pairs: [string, string][] = [['data-fdn-id', node.id]]
  const rest = { ...node.attrs }
  if (rest.class !== undefined) {
    pairs.push(['class', rest.class])
    delete rest.class
  }
  for (const key of Object.keys(rest).sort()) {
    pairs.push([key, rest[key] as string])
  }
  if (node.when !== undefined) pairs.push(['when', node.when])
  if (node.each !== undefined) pairs.push(['each', node.each])
  if (node.styleRef !== undefined) pairs.push(['data-fdn-style', node.styleRef])
  if (Object.keys(node.style).length > 0) pairs.push(['style', serializeDeclarations(node.style)])
  for (let i = 0; i < STATE_PLANES.length; i++) {
    const plane = STATE_PLANES[i]
    const attrName = STATE_STYLE_ATTRS[i]
    const decls = plane ? node.styleStates[plane] : undefined
    if (decls && Object.keys(decls).length > 0 && attrName) {
      pairs.push([attrName, serializeDeclarations(decls)])
    }
  }
  return pairs
}

function emitNode(w: Writer, depth: number, node: FdnNode): void {
  const attrs = nodeAttrPairs(node)
  const hasChildren = node.children.length > 0
  const hasText = node.text !== undefined && node.text !== ''
  if (!hasChildren && !hasText) {
    emitElement(w, depth, node.tag, attrs, null)
    return
  }
  emitElement(w, depth, node.tag, attrs, (innerDepth) => {
    let wrote = false
    if (hasText) {
      w.push(innerDepth, escapeText(node.text as string))
      wrote = true
    }
    for (const child of node.children) {
      emitNode(w, innerDepth, child)
      wrote = true
    }
    return wrote
  })
}

// ——————————————————————————————————————————————————————————————————————————
// fdn-doc header block
// ——————————————————————————————————————————————————————————————————————————

function fmtDefault(v: unknown): string {
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  return String(v)
}

function emitFdnDoc(w: Writer, depth: number, doc: FdnDocument): void {
  const attrs: [string, string][] = [['hidden', ''], ['data-fdn-spec-version', doc.specVersion]]
  if (doc.title !== undefined) attrs.push(['data-fdn-title', doc.title])
  const boolAttrs = attrs.map(([k, v]) => (v === '' ? k : `${k}="${escapeAttr(v)}"`)).join(' ')
  w.push(depth, `<fdn-doc ${boolAttrs}>`)
  let wroteAny = false

  if (doc.params.length > 0) {
    w.push(depth + 1, '<fdn-params>')
    for (const p of doc.params) {
      const a: [string, string][] = [['name', p.name], ['type', p.type]]
      if (p.values) a.push(['values', p.values.join(',')])
      if (p.default !== undefined) a.push(['default', fmtDefault(p.default)])
      if (p.description) a.push(['description', p.description])
      emitElement(w, depth + 2, 'fdn-param', a, null)
    }
    w.push(depth + 1, '</fdn-params>')
    wroteAny = true
  }

  for (const set of doc.data) {
    w.push(depth + 1, `<fdn-data name="${escapeAttr(set.name)}">`)
    for (const item of set.items) {
      const a: [string, string][] = Object.keys(item)
        .sort((x, y) => (x === 'id' ? -1 : y === 'id' ? 1 : x.localeCompare(y)))
        .map((k) => [k, String(item[k])])
      emitElement(w, depth + 2, 'fdn-item', a, null)
    }
    w.push(depth + 1, '</fdn-data>')
    wroteAny = true
  }

  if (doc.lookups.length > 0) {
    w.push(depth + 1, '<fdn-lookups>')
    for (const lookup of doc.lookups) {
      w.push(depth + 2, `<fdn-lookup name="${escapeAttr(lookup.name)}">`)
      for (const key of Object.keys(lookup.entries).sort()) {
        emitElement(w, depth + 3, 'fdn-entry', [['key', key], ['value', lookup.entries[key] as string]], null)
      }
      w.push(depth + 2, '</fdn-lookup>')
    }
    w.push(depth + 1, '</fdn-lookups>')
    wroteAny = true
  }

  if (doc.states.length > 0) {
    w.push(depth + 1, '<fdn-states>')
    for (const s of doc.states) {
      const a: [string, string][] = [['name', s.name]]
      if (s.viewport !== undefined) a.push(['viewport', s.viewport])
      for (const key of Object.keys(s.assignments).sort()) a.push([key, String(s.assignments[key])])
      emitElement(w, depth + 2, 'fdn-state', a, null)
    }
    w.push(depth + 1, '</fdn-states>')
    wroteAny = true
  }

  if (doc.viewports.length > 0 || doc.matrix.length > 0) {
    w.push(depth + 1, '<fdn-matrix>')
    for (const v of doc.viewports) {
      emitElement(
        w,
        depth + 2,
        'fdn-viewport',
        [['name', v.name], ['width', String(v.width)], ['height', String(v.height)]],
        null,
      )
    }
    for (const cell of doc.matrix) {
      emitElement(w, depth + 2, 'fdn-cell', [['state', cell.state], ['viewport', cell.viewport]], null)
    }
    w.push(depth + 1, '</fdn-matrix>')
    wroteAny = true
  }

  if (doc.annotations.length > 0) {
    w.push(depth + 1, '<fdn-annotations>')
    for (const annotation of doc.annotations) emitAnnotation(w, depth + 2, annotation)
    w.push(depth + 1, '</fdn-annotations>')
    wroteAny = true
  }

  if (!wroteAny) {
    // collapse trailing open tag if the header block is empty
    w.appendToLast('</fdn-doc>')
    return
  }
  w.push(depth, '</fdn-doc>')
}

/**
 * `<fdn-annotation id=… [node-id=…|x=… y=…] [state=…] status=…>text</fdn-annotation>`
 * (SPEC D2/D4/13a — annotations are first-class chain citizens, hidden
 * metadata in projection, never baked into design output). Kept on ONE line
 * (emitTextLeaf's pattern, defined further below) rather than through
 * emitElement's normal indented-child-callback path: annotation text is
 * extracted RAW by parse/index.ts's parseAnnotations (directTextOf, not
 * normalizeTextWhitespace) specifically so authored whitespace round-trips
 * byte-for-byte — re-indenting it here would inject whitespace parse can't
 * tell apart from content, breaking the parse/project fixpoint.
 */
function emitAnnotation(w: Writer, depth: number, annotation: FdnAnnotation): void {
  const a: [string, string][] = [['id', annotation.id]]
  if (annotation.nodeId !== undefined) a.push(['node-id', annotation.nodeId])
  if (annotation.x !== undefined) a.push(['x', String(annotation.x)])
  if (annotation.y !== undefined) a.push(['y', String(annotation.y)])
  if (annotation.state !== undefined) a.push(['state', annotation.state])
  a.push(['status', annotation.status])
  w.push(depth, `<fdn-annotation ${attrPairs(a)}>${escapeText(annotation.text)}</fdn-annotation>`)
}

// ——————————————————————————————————————————————————————————————————————————
// fdn-styles
// ——————————————————————————————————————————————————————————————————————————

function emitNamedStyle(w: Writer, depth: number, style: FdnNamedStyle): void {
  const a: [string, string][] = [['name', style.name]]
  for (const key of Object.keys(style.style).sort()) a.push([key, style.style[key] as string])
  for (let i = 0; i < STATE_PLANES.length; i++) {
    const plane = STATE_PLANES[i]
    const attrName = STATE_STYLE_ATTRS[i]
    const decls = plane ? style.styleStates[plane] : undefined
    if (decls && Object.keys(decls).length > 0 && attrName) a.push([attrName, serializeDeclarations(decls)])
  }
  emitElement(w, depth, 'fdn-style', a, null)
}

function emitFdnStyles(w: Writer, depth: number, doc: FdnDocument): void {
  if (doc.namedStyles.length === 0) return
  w.push(depth, '<fdn-styles hidden>')
  for (const style of doc.namedStyles) emitNamedStyle(w, depth + 1, style)
  w.push(depth, '</fdn-styles>')
}

// ——————————————————————————————————————————————————————————————————————————
// fdn-component definitions (alphabetical, per API.md)
// ——————————————————————————————————————————————————————————————————————————

/**
 * Text-leaf metadata element: `<tag>escaped-content</tag>` — open tag, escaped
 * content, close tag concatenated onto ONE pushed line with NO whitespace
 * added around the content. This is deliberate, not a style choice: unlike
 * ordinary node text (normalizeTextWhitespace collapses it on the way back
 * in, so incidental pretty-printing whitespace never round-trips and never
 * needs to), sealed html/css is extracted RAW (directTextOf, parse/index.ts's
 * parseSealed) specifically to preserve significant whitespace. Putting the
 * content on its own indented line — as emitElement's normal inner-callback
 * pattern does for element children — would inject a leading/trailing
 * newline+indent into the text NODE itself on reparse (HTML has no notion of
 * "pretty-printing" whitespace inside a text node; every byte between `>` and
 * `<` is content), silently breaking the parse/project fixpoint.
 */
function emitTextLeaf(w: Writer, depth: number, tag: string, text: string): void {
  w.push(depth, `<${tag}>${escapeText(text)}</${tag}>`)
}

/**
 * Sealed-capsule canonical representation (SPEC D3/Q3, coordinated with
 * parse/index.ts's parseSealed): html/css survive as entity-escaped text
 * content of dedicated leaf elements — no CDATA needed, since parse5 decodes
 * ordinary entities on any element (not just raw-text elements like
 * <script>/<style>). Kept on one line each (never re-indented line-by-line)
 * because re-indenting arbitrary markup/CSS text would inject whitespace
 * that a subsequent parse could not tell apart from content, breaking the
 * project/parse fixpoint.
 */
function emitSealed(w: Writer, depth: number, sealed: { html: string; css: string }): void {
  w.push(depth, '<fdn-sealed>')
  emitTextLeaf(w, depth + 1, 'fdn-sealed-html', sealed.html)
  emitTextLeaf(w, depth + 1, 'fdn-sealed-css', sealed.css)
  w.push(depth, '</fdn-sealed>')
}

function emitComponent(w: Writer, depth: number, component: FdnComponent): void {
  const attrs: [string, string][] = [['name', component.name]]
  if (component.provenance) {
    attrs.push(['data-fdn-import-source', component.provenance.source])
    attrs.push(['data-fdn-import-sha256', component.provenance.contentSha256])
  }
  w.push(depth, `<fdn-component ${attrPairs(attrs)} hidden>`)
  if (component.props.length > 0) {
    w.push(depth + 1, '<fdn-props>')
    for (const p of component.props) {
      const a: [string, string][] = [['name', p.name], ['type', p.type]]
      if (p.required !== undefined) a.push(['required', p.required ? 'true' : 'false'])
      if (p.default !== undefined) a.push(['default', fmtDefault(p.default)])
      emitElement(w, depth + 2, 'fdn-prop', a, null)
    }
    w.push(depth + 1, '</fdn-props>')
  }
  if (component.sealed) {
    emitSealed(w, depth + 1, component.sealed)
  } else {
    for (const node of component.body) emitNode(w, depth + 1, node)
  }
  w.push(depth, '</fdn-component>')
}

// ——————————————————————————————————————————————————————————————————————————
// :root tokens
// ——————————————————————————————————————————————————————————————————————————

function emitTokens(w: Writer, doc: FdnDocument): void {
  w.push(0, '<style>')
  w.push(1, ':root {')
  for (const name of Object.keys(doc.tokens).sort()) {
    // API contract (types.ts): tokens are stored WITHOUT the leading `--`.
    w.push(2, `--${name}: ${doc.tokens[name]};`)
  }
  w.push(1, '}')
  w.push(0, '</style>')
}

// ——————————————————————————————————————————————————————————————————————————
// entry point
// ——————————————————————————————————————————————————————————————————————————

export function projectDocument(doc: FdnDocument): string {
  const w = new Writer()
  w.push(0, '<!DOCTYPE html>')
  w.push(0, '<html lang="en">')
  w.push(0, '<head>')
  w.push(1, '<meta charset="utf-8">')
  if (doc.title !== undefined) w.push(1, `<title>${escapeText(doc.title)}</title>`)
  emitTokens(w, doc)
  w.push(0, '</head>')
  w.push(0, '<body>')

  emitFdnDoc(w, 1, doc)
  emitFdnStyles(w, 1, doc)
  const sortedComponents = [...doc.components].sort((a, b) => a.name.localeCompare(b.name))
  for (const component of sortedComponents) emitComponent(w, 1, component)

  if (doc.body.length === 0) {
    w.push(1, '<main></main>')
  } else {
    w.push(1, '<main>')
    for (const node of doc.body) emitNode(w, 2, node)
    w.push(1, '</main>')
  }

  w.push(0, '</body>')
  w.push(0, '</html>')

  return `${w.toString()}\n`
}
