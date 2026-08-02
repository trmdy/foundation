/**
 * FdnNode tree utilities shared across the projection pipeline. Every sample
 * (baseline + variants + pairwise probes) is turned into an FdnNode[] tree by
 * REUSING foundation-engine's own `parseDocument` (see html.ts) — this module
 * only adds what parseDocument doesn't: structural alignment between two
 * trees (for when= folding) and id-agnostic structural equality (for the
 * bake-based interaction check).
 */
import type { FdnNode } from 'foundation-engine'

export function cloneNode(n: FdnNode): FdnNode {
  return {
    ...n,
    attrs: { ...n.attrs },
    style: { ...n.style },
    styleStates: Object.fromEntries(Object.entries(n.styleStates).map(([k, v]) => [k, { ...v }])) as FdnNode['styleStates'],
    children: n.children.map(cloneNode),
  }
}

export function cloneTree(nodes: FdnNode[]): FdnNode[] {
  return nodes.map(cloneNode)
}

/**
 * A path into a tree: sequence of child indices from the roots array. Used as
 * a map key (joined with '.') to accumulate per-position folding decisions
 * across multiple samples without needing to mutate shared node identities.
 */
export type NodePath = number[]

export function pathKey(path: NodePath): string {
  return path.join('.')
}

/** Look up a node by path (empty path is invalid — paths always address a
 *  specific element in the roots array or a descendant of one). */
export function getAtPath(roots: FdnNode[], path: NodePath): FdnNode | undefined {
  if (path.length === 0) return undefined
  let cur: FdnNode[] = roots
  let node: FdnNode | undefined
  for (const i of path) {
    node = cur[i]
    if (!node) return undefined
    cur = node.children
  }
  return node
}

/**
 * Align two sibling lists by tag, matching a COMMON PREFIX then a COMMON
 * SUFFIX and treating whatever's left in the middle as inserted (in `b` but
 * not `a`) or removed (in `a` but not `b`). This is a deliberately simple v1
 * heuristic — not a general tree-diff/LCS algorithm — documented as a known
 * limit: it correctly handles the common real-world shape (one optional
 * leading/trailing node, e.g. a conditionally-rendered icon or badge) but can
 * misalign on reordering or multiple scattered insertions. Good enough for
 * the importer's target fixtures (buttons/badges/cards/icons); a genuine
 * misalignment just produces a less-precise `when=` guess or, if bad enough
 * to affect the pairwise interaction check, gets caught and pushed to sealed
 * rather than silently shipping wrong output.
 */
export interface Alignment {
  matched: { a: FdnNode; b: FdnNode; aIndex: number; bIndex: number }[]
  onlyA: { node: FdnNode; index: number }[]
  onlyB: { node: FdnNode; index: number }[]
}

export function alignSiblings(a: FdnNode[], b: FdnNode[]): Alignment {
  let prefixLen = 0
  while (prefixLen < a.length && prefixLen < b.length && a[prefixLen]?.tag === b[prefixLen]?.tag) prefixLen++

  let suffixLen = 0
  const maxSuffix = Math.min(a.length, b.length) - prefixLen
  while (
    suffixLen < maxSuffix &&
    a[a.length - 1 - suffixLen]?.tag === b[b.length - 1 - suffixLen]?.tag
  ) {
    suffixLen++
  }

  const matched: Alignment['matched'] = []
  for (let i = 0; i < prefixLen; i++) {
    matched.push({ a: a[i] as FdnNode, b: b[i] as FdnNode, aIndex: i, bIndex: i })
  }
  const onlyA: Alignment['onlyA'] = []
  const onlyB: Alignment['onlyB'] = []
  for (let i = prefixLen; i < a.length - suffixLen; i++) {
    onlyA.push({ node: a[i] as FdnNode, index: i })
  }
  for (let i = prefixLen; i < b.length - suffixLen; i++) {
    onlyB.push({ node: b[i] as FdnNode, index: i })
  }
  for (let i = 0; i < suffixLen; i++) {
    const ai = a.length - suffixLen + i
    const bi = b.length - suffixLen + i
    matched.push({ a: a[ai] as FdnNode, b: b[bi] as FdnNode, aIndex: ai, bIndex: bi })
  }
  return { matched, onlyA, onlyB }
}

/** Structural equality ignoring minted `id`s (each independent parseDocument
 *  call mints its own n1..nN, so ids are never comparable across two trees
 *  produced by two separate parses) — used by the interaction check to
 *  compare a bake result against a probe sample. */
export function structurallyEqual(a: FdnNode[], b: FdnNode[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (!nodeEqual(a[i] as FdnNode, b[i] as FdnNode)) return false
  }
  return true
}

function recordEqual(a: Record<string, string>, b: Record<string, string>): boolean {
  const ak = Object.keys(a).sort()
  const bk = Object.keys(b).sort()
  if (ak.length !== bk.length) return false
  for (const k of ak) {
    if (a[k] !== b[k]) return false
  }
  return true
}

function nodeEqual(a: FdnNode, b: FdnNode): boolean {
  if (a.tag !== b.tag) return false
  if ((a.text ?? '') !== (b.text ?? '')) return false
  if (!recordEqual(a.attrs, b.attrs)) return false
  if (!recordEqual(a.style, b.style)) return false
  const stateKeys = new Set([...Object.keys(a.styleStates), ...Object.keys(b.styleStates)])
  for (const k of stateKeys) {
    const av = (a.styleStates as Record<string, Record<string, string> | undefined>)[k] ?? {}
    const bv = (b.styleStates as Record<string, Record<string, string> | undefined>)[k] ?? {}
    if (!recordEqual(av, bv)) return false
  }
  return structurallyEqual(a.children, b.children)
}
