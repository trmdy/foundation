/**
 * Chain spike — the shared contract both library adapters implement.
 *
 * This file is the fixed interface of the spike (SPEC.md D2 + open question 1).
 * Adapters (loro.ts, automerge.ts) implement ChainAdapter; the gauntlet and perf
 * runners are written once against this contract. Do not widen it to fit a
 * library — where a library cannot express an operation, that is a FINDING to
 * record in RESULTS.md, not an interface problem to engineer around.
 *
 * Semantics under test (SPEC D2):
 * - one verb call = one change = one envelope (author, message) = one undo unit
 * - history is append-only; undo appends the inverse change
 * - anchors name chain points; checkout/diff operate between anchors
 * - materialization is a pure, deterministic fold over the chain
 */

export type NodeId = string

/** The materialized document tree. Plain data — no library types may leak out. */
export interface FdnNode {
  id: NodeId
  tag: string
  props: Record<string, string>
  styles: Record<string, string>
  /** Text content for leaf text nodes; undefined for element-only nodes. */
  text?: string
  children: FdnNode[]
}

export interface ChangeMeta {
  /** "agent:<bee>" | "user:<id>" */
  author: string
  message: string
}

/** Opaque anchor handle; adapters map it to heads/frontiers internally. */
export type AnchorRef = string

/** The verb vocabulary a diff must be lifted into (SPEC §6, structural plane). */
export type SemanticOp =
  | { op: 'insert-node'; id: NodeId; parent: NodeId; index: number; tag: string }
  | { op: 'remove-node'; id: NodeId }
  | { op: 'move-node'; id: NodeId; parent: NodeId; index: number }
  | { op: 'set-prop'; id: NodeId; key: string; value: string | null }
  | { op: 'set-style'; id: NodeId; prop: string; value: string | null }
  | { op: 'set-text'; id: NodeId; text: string }

export interface ChangeRecord {
  meta: ChangeMeta
  /** Adapter-native change identity (hash, opId…) — for the metadata-roundtrip check. */
  nativeId: string
}

export interface ChainAdapter {
  readonly name: 'loro' | 'automerge'

  init(root: FdnNode): void

  /** Independent offline copy (a second author). Must not share mutable state. */
  fork(actor: string): ChainAdapter

  /** Import all changes from `other` (sync in one direction; call both ways to converge). */
  merge(other: ChainAdapter): void

  // ——— verbs: each call is exactly one change ———
  insertNode(meta: ChangeMeta, parent: NodeId, index: number, node: FdnNode): void
  removeNode(meta: ChangeMeta, id: NodeId): void
  moveNode(meta: ChangeMeta, id: NodeId, newParent: NodeId, index: number): void
  setProp(meta: ChangeMeta, id: NodeId, key: string, value: string): void
  setStyle(meta: ChangeMeta, id: NodeId, prop: string, value: string): void
  setText(meta: ChangeMeta, id: NodeId, text: string): void

  materialize(): FdnNode
  anchor(name: string): AnchorRef
  /** Read-only materialization at an anchor (time travel). Must not disturb current state. */
  checkout(ref: AnchorRef): FdnNode
  /** Changes between two anchors, lifted to the semantic vocabulary. */
  diff(a: AnchorRef, b: AnchorRef): SemanticOp[]
  /** Append the inverse of the last local change. */
  undo(meta: ChangeMeta): void

  history(): ChangeRecord[]
  save(): Uint8Array
  load(data: Uint8Array): void
}

// ——— invariants (the gauntlet's disqualifier checks) ———

export class TreeInvariantError extends Error {}

/** No duplicate ids, no cycles (guaranteed by traversal), every child reachable once. */
export function assertValidTree(root: FdnNode): void {
  const seen = new Set<NodeId>()
  const walk = (n: FdnNode): void => {
    if (seen.has(n.id)) throw new TreeInvariantError(`duplicate/readmitted node: ${n.id}`)
    seen.add(n.id)
    n.children.forEach(walk)
  }
  walk(root)
}

/** Deterministic serialization for convergence comparison across peers. */
export function canonical(root: FdnNode): string {
  const norm = (n: FdnNode): unknown => ({
    id: n.id,
    tag: n.tag,
    props: Object.fromEntries(Object.entries(n.props).sort(([a], [b]) => (a < b ? -1 : 1))),
    styles: Object.fromEntries(Object.entries(n.styles).sort(([a], [b]) => (a < b ? -1 : 1))),
    ...(n.text !== undefined ? { text: n.text } : {}),
    children: n.children.map(norm),
  })
  return JSON.stringify(norm(root))
}

export function collectIds(root: FdnNode, into: Set<NodeId> = new Set()): Set<NodeId> {
  into.add(root.id)
  root.children.forEach((c) => collectIds(c, into))
  return into
}
