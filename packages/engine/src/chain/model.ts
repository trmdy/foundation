/**
 * Pure, Loro-free helpers over the FdnDocument/PatchOp/SemanticOp vocabulary:
 * node-location indexing (used by both undo-inversion and diff), PatchOp
 * inversion, and the structural diff that backs FdnChain.diff().
 *
 * Kept Loro-free deliberately: everything here operates on plain materialized
 * FdnDocument snapshots, so it is trivial to unit-test and never needs to
 * know about TreeID/ContainerID bookkeeping.
 */

import type {
  FdnAnnotation,
  FdnComponent,
  FdnDataSet,
  FdnDocument,
  FdnLookup,
  FdnNamedStyle,
  FdnNode,
  FdnParam,
  FdnState,
  FdnViewport,
  NodeId,
  PatchOp,
  SemanticOp,
  StateStyleKey,
} from '../types.js'

// ——— node location index (shared by undo-inversion and tree diff) ———

export interface NodeLocation {
  parent: NodeId | null
  index: number
  node: FdnNode
}

export function indexNodes(body: FdnNode[]): Map<NodeId, NodeLocation> {
  const map = new Map<NodeId, NodeLocation>()
  const walk = (nodes: FdnNode[], parent: NodeId | null): void => {
    nodes.forEach((n, i) => {
      map.set(n.id, { parent, index: i, node: n })
      walk(n.children, n.id)
    })
  }
  walk(body, null)
  return map
}

// ——— PatchOp inversion (undo) ———

/**
 * Inverting one PatchOp against the document as it was immediately before
 * the batch containing it was applied. Returns:
 *   - a PatchOp: the typed, granular inverse (the common case)
 *   - null: no inverse is needed (e.g. removing something that never existed)
 *   - 'fallback': no typed inverse exists in the PatchOp vocabulary (see
 *     findings below) — the caller should escalate the WHOLE batch's undo to
 *     a single `replace-document` restoring the pre-batch snapshot instead.
 *
 * Findings (contract gaps discovered while writing this):
 *   - set-param/set-lookup/set-state have no remove-param/remove-lookup/
 *     remove-state counterpart. Undoing a *first-time* set-param (etc.) has
 *     no typed inverse — 'fallback'.
 *   - set-text's `text` field is a non-nullable string, so a node that had
 *     no text before this batch has no way to be inverted back to
 *     "no text" — the closest legal inverse is `text: ''`.
 */
export function invertOp(
  op: PatchOp,
  beforeDoc: FdnDocument,
  nodeIndex: Map<NodeId, NodeLocation>,
): PatchOp | null | 'fallback' {
  switch (op.op) {
    case 'insert-node':
      return { op: 'remove-node', id: op.node.id }
    case 'remove-node': {
      const loc = nodeIndex.get(op.id)
      if (!loc) return 'fallback'
      return { op: 'insert-node', parent: loc.parent, index: loc.index, node: loc.node }
    }
    case 'move-node': {
      const loc = nodeIndex.get(op.id)
      if (!loc) return 'fallback'
      return { op: 'move-node', id: op.id, parent: loc.parent, index: loc.index }
    }
    case 'set-attr': {
      const loc = nodeIndex.get(op.id)
      if (!loc) return 'fallback'
      const prev = loc.node.attrs[op.key] ?? null
      return { op: 'set-attr', id: op.id, key: op.key, value: prev }
    }
    case 'set-style': {
      const loc = nodeIndex.get(op.id)
      if (!loc) return 'fallback'
      const plane = op.state ? loc.node.styleStates[op.state] : loc.node.style
      const prev = plane?.[op.prop] ?? null
      return { op: 'set-style', id: op.id, prop: op.prop, value: prev, state: op.state }
    }
    case 'set-style-ref': {
      const loc = nodeIndex.get(op.id)
      if (!loc) return 'fallback'
      return { op: 'set-style-ref', id: op.id, styleRef: loc.node.styleRef ?? null }
    }
    case 'set-text': {
      const loc = nodeIndex.get(op.id)
      if (!loc) return 'fallback'
      return { op: 'set-text', id: op.id, text: loc.node.text ?? '' }
    }
    case 'set-when': {
      const loc = nodeIndex.get(op.id)
      if (!loc) return 'fallback'
      return { op: 'set-when', id: op.id, when: loc.node.when ?? null }
    }
    case 'set-token': {
      const prev = beforeDoc.tokens[op.name] ?? null
      return { op: 'set-token', name: op.name, value: prev }
    }
    case 'set-named-style': {
      const prev = beforeDoc.namedStyles.find((s) => s.name === op.style.name)
      return prev ? { op: 'set-named-style', style: prev } : { op: 'remove-named-style', name: op.style.name }
    }
    case 'remove-named-style': {
      const prev = beforeDoc.namedStyles.find((s) => s.name === op.name)
      return prev ? { op: 'set-named-style', style: prev } : null
    }
    case 'set-component': {
      const prev = beforeDoc.components.find((c) => c.name === op.component.name)
      return prev ? { op: 'set-component', component: prev } : { op: 'remove-component', name: op.component.name }
    }
    case 'remove-component': {
      const prev = beforeDoc.components.find((c) => c.name === op.name)
      return prev ? { op: 'set-component', component: prev } : null
    }
    case 'set-param': {
      const prev = beforeDoc.params.find((p) => p.name === op.param.name)
      return prev ? { op: 'set-param', param: prev } : 'fallback'
    }
    case 'set-lookup': {
      const prev = beforeDoc.lookups.find((l) => l.name === op.lookup.name)
      return prev ? { op: 'set-lookup', lookup: prev } : 'fallback'
    }
    case 'set-state': {
      const prev = beforeDoc.states.find((s) => s.name === op.state.name)
      return prev ? { op: 'set-state', state: prev } : 'fallback'
    }
    case 'annotate': {
      const prev = beforeDoc.annotations.find((a) => a.id === op.annotation.id)
      return prev ? { op: 'annotate', annotation: prev } : { op: 'remove-annotation', id: op.annotation.id }
    }
    case 'set-annotation-status': {
      const prev = beforeDoc.annotations.find((a) => a.id === op.id)
      return prev ? { op: 'set-annotation-status', id: op.id, status: prev.status } : 'fallback'
    }
    case 'remove-annotation': {
      const prev = beforeDoc.annotations.find((a) => a.id === op.id)
      return prev ? { op: 'annotate', annotation: prev } : null
    }
    case 'replace-document':
      return { op: 'replace-document', doc: beforeDoc }
  }
}

// ——— structural diff (backs FdnChain.diff) ———

const STATE_KEYS: StateStyleKey[] = ['hover', 'focus', 'active', 'disabled']

type SectionName = Extract<SemanticOp, { op: 'section-changed' }>['section']

function diffAttrLike(before: Record<string, string>, after: Record<string, string>, emit: (key: string, value: string | null) => void): void {
  for (const [k, v] of Object.entries(after)) {
    if (before[k] !== v) emit(k, v)
  }
  for (const k of Object.keys(before)) {
    if (!(k in after)) emit(k, null)
  }
}

function diffTree(a: FdnDocument, b: FdnDocument, out: SemanticOp[]): void {
  const locA = indexNodes(a.body)
  const locB = indexNodes(b.body)

  for (const [id, locB1] of locB) {
    if (!locA.has(id)) {
      out.push({ op: 'insert-node', id, parent: locB1.parent, index: locB1.index, tag: locB1.node.tag })
    }
  }
  for (const id of locA.keys()) {
    if (!locB.has(id)) out.push({ op: 'remove-node', id })
  }
  for (const [id, lb] of locB) {
    const la = locA.get(id)
    if (!la) continue
    if (la.parent !== lb.parent || la.index !== lb.index) {
      out.push({ op: 'move-node', id, parent: lb.parent, index: lb.index })
    }
    diffAttrLike(la.node.attrs, lb.node.attrs, (key, value) => out.push({ op: 'set-attr', id, key, value }))
    diffAttrLike(la.node.style, lb.node.style, (prop, value) => out.push({ op: 'set-style', id, prop, value }))
    for (const state of STATE_KEYS) {
      const before = la.node.styleStates[state] ?? {}
      const after = lb.node.styleStates[state] ?? {}
      diffAttrLike(before, after, (prop, value) => out.push({ op: 'set-style', id, prop, value, state }))
    }
    const beforeText = la.node.text
    const afterText = lb.node.text
    if (beforeText !== afterText) out.push({ op: 'set-text', id, text: afterText ?? '' })

    const beforeStyleRef = la.node.styleRef ?? null
    const afterStyleRef = lb.node.styleRef ?? null
    if (beforeStyleRef !== afterStyleRef) out.push({ op: 'set-style-ref', id, styleRef: afterStyleRef })

    const beforeWhen = la.node.when ?? null
    const afterWhen = lb.node.when ?? null
    if (beforeWhen !== afterWhen) out.push({ op: 'set-when', id, when: afterWhen })
  }
}

function diffKeyedSection<T>(
  section: SectionName,
  before: T[],
  after: T[],
  nameOf: (item: T) => string,
  out: SemanticOp[],
): void {
  const beforeMap = new Map(before.map((item) => [nameOf(item), item]))
  const afterMap = new Map(after.map((item) => [nameOf(item), item]))
  const names = new Set<string>([...beforeMap.keys(), ...afterMap.keys()])
  for (const name of names) {
    const b = beforeMap.get(name)
    const a = afterMap.get(name)
    if (JSON.stringify(b) !== JSON.stringify(a)) out.push({ op: 'section-changed', section, name })
  }
}

function diffSections(a: FdnDocument, b: FdnDocument, out: SemanticOp[]): void {
  const tokenNames = new Set<string>([...Object.keys(a.tokens), ...Object.keys(b.tokens)])
  for (const name of tokenNames) {
    if (a.tokens[name] !== b.tokens[name]) out.push({ op: 'section-changed', section: 'tokens', name })
  }
  diffKeyedSection<FdnParam>('params', a.params, b.params, (p) => p.name, out)
  diffKeyedSection<FdnDataSet>('data', a.data, b.data, (d) => d.name, out)
  diffKeyedSection<FdnLookup>('lookups', a.lookups, b.lookups, (l) => l.name, out)
  diffKeyedSection<FdnState>('states', a.states, b.states, (s) => s.name, out)
  diffKeyedSection<FdnViewport>('viewports', a.viewports, b.viewports, (v) => v.name, out)
  diffKeyedSection<FdnNamedStyle>('namedStyles', a.namedStyles, b.namedStyles, (s) => s.name, out)
  diffKeyedSection<FdnComponent>('components', a.components, b.components, (c) => c.name, out)
  diffKeyedSection<FdnAnnotation>('annotations', a.annotations, b.annotations, (an) => an.id, out)

  // matrix entries have no natural name (finding: section-changed.name doesn't
  // fit unnamed list sections) — synthesize "state::viewport" and diff as a set.
  const matrixName = (m: { state: string; viewport: string }): string => `${m.state}::${m.viewport}`
  const beforeMatrix = new Set(a.matrix.map(matrixName))
  const afterMatrix = new Set(b.matrix.map(matrixName))
  const matrixNames = new Set<string>([...beforeMatrix, ...afterMatrix])
  for (const name of matrixNames) {
    if (beforeMatrix.has(name) !== afterMatrix.has(name)) out.push({ op: 'section-changed', section: 'matrix', name })
  }

  // 'meta' (contract amendment 2026-07-31): document-level scalars with no
  // natural per-item name — use the field name itself as `name`.
  if (a.specVersion !== b.specVersion) out.push({ op: 'section-changed', section: 'meta', name: 'specVersion' })
  if (a.title !== b.title) out.push({ op: 'section-changed', section: 'meta', name: 'title' })
}

/**
 * Structural diff between two materialized FdnDocument snapshots, lifted to
 * SemanticOp[] (SPEC §6). Emits set-style-ref/set-when for per-node changes
 * and 'meta' section-changed (name: 'specVersion'|'title') for document-level
 * scalars — both added to SemanticOp as a contract amendment (2026-07-31)
 * responding to this module's own findings; previously these changes were
 * silently unrepresentable and were dropped rather than shoehorned into the
 * wrong op shape.
 */
export function structuralDiff(a: FdnDocument, b: FdnDocument): SemanticOp[] {
  const out: SemanticOp[] = []
  diffTree(a, b, out)
  diffSections(a, b, out)
  return out
}

// re-exported for callers that want to sanity-check equality without a full diff
export function documentsEqual(a: FdnDocument, b: FdnDocument): boolean {
  return structuralDiff(a, b).length === 0 && a.specVersion === b.specVersion && a.title === b.title
}

// ——— annotation id minting (shared by the CLI's `annotate` command, MCP's
//      foundation_annotate, and engine serve's POST /api/annotate — one
//      scheme so an id minted through any surface never collides with one
//      minted through another) ———

const MINTED_ANNOTATION_ID_RE = /^a(\d+)$/

/** Mints the next `a<N>` id from a document's current annotations —
 *  deterministic "scan max, mint max+1" scheme, same shape as parse/index.ts's
 *  node-id IdMinter (never Date.now()/Math.random(), per SPEC D2). */
export function mintAnnotationId(existing: FdnAnnotation[]): string {
  let max = 0
  for (const a of existing) {
    const m = MINTED_ANNOTATION_ID_RE.exec(a.id)
    if (m?.[1] !== undefined) max = Math.max(max, Number(m[1]))
  }
  return `a${max + 1}`
}
