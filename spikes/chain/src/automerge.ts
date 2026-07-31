/**
 * ChainAdapter over @automerge/automerge 3.
 *
 * Design notes (see RESULTS.md "findings" for the write-up):
 *
 * - Automerge has NO tree-move operation (SPEC D2 flags this: "move is
 *   published research, not a shipped operation"). The least-bad documented
 *   strategy is a parent-pointer field per node plus an explicit ordered
 *   child-id list per parent (`order[parentId]`); `moveNode` updates both the
 *   node's `parent` field (a last-write-wins register) and splices the
 *   child-order lists. Under concurrent moves of the same node to different
 *   parents, BOTH parents' order lists end up containing the node id after
 *   merge (list inserts always survive; only the LWW `parent` field picks a
 *   winner) — that would duplicate the node under naive traversal. We
 *   reconcile this in `materialize()`/`toFdn()` by only rendering a child
 *   entry from `order[p]` when that child's own `parent` field still equals
 *   `p`, i.e. cross-checking the order list against the LWW-resolved parent
 *   pointer at read time. This is a real workaround, not a CRDT guarantee:
 *   it avoids duplication but it does NOT avoid or detect move/move cycles
 *   (see G5 in RESULTS.md) the way Loro's native movable tree does.
 * - Automerge's `change()` message is a single string with no separate author
 *   field, same limitation as Loro's `commit()`. We use the same
 *   {author, message} JSON-in-message envelope trick in both adapters.
 * - `nativeId` is the real Automerge change hash (SHA-256-based, from
 *   `decodeChange().hash`) — unlike Loro's positional (peer, counter) op id,
 *   this is a genuine content hash, matching SPEC D2's original description
 *   of the Automerge candidate.
 * - Time-travel is comparatively pleasant: `automerge.view(doc, heads)` is a
 *   cheap non-mutating read, unlike Loro's checkout()/re-checkout() dance.
 */

import * as Automerge from '@automerge/automerge'
import type { Doc, Heads, Patch } from '@automerge/automerge'
import type {
  AnchorRef,
  ChainAdapter,
  ChangeMeta,
  ChangeRecord,
  FdnNode,
  NodeId,
  SemanticOp,
} from './contract.js'
import { DeterministicClock, deriveHexActor } from './util.js'

interface AmNode {
  tag: string
  props: Record<string, string>
  styles: Record<string, string>
  text?: string
  parent: string | null
}

interface AmDocShape {
  rootId: string
  nodes: Record<string, AmNode>
  order: Record<string, string[]>
}

interface Envelope {
  author: string
  message: string
}

type UndoRecord =
  | { kind: 'insert'; id: NodeId }
  | { kind: 'remove'; parent: NodeId; index: number; snapshot: FdnNode }
  | { kind: 'move'; id: NodeId; prevParent: NodeId; prevIndex: number }
  | { kind: 'setProp'; id: NodeId; key: string; prevValue: string | undefined }
  | { kind: 'setStyle'; id: NodeId; prop: string; prevValue: string | undefined }
  | { kind: 'setText'; id: NodeId; prevValue: string | undefined }

function encodeEnvelope(meta: ChangeMeta): string {
  return JSON.stringify({ author: meta.author, message: meta.message } satisfies Envelope)
}

function decodeEnvelope(raw: string | null | undefined): ChangeMeta {
  if (raw === null || raw === undefined) return { author: 'unknown', message: '' }
  try {
    const parsed = JSON.parse(raw) as Partial<Envelope>
    return { author: parsed.author ?? 'unknown', message: parsed.message ?? '' }
  } catch {
    return { author: 'unknown', message: raw }
  }
}

function childIndexOf(order: string[] | undefined, id: NodeId): number {
  const idx = (order ?? []).indexOf(id)
  if (idx < 0) throw new Error(`childIndexOf: ${id} not found in order list`)
  return idx
}

export class AutomergeAdapter implements ChainAdapter {
  readonly name = 'automerge' as const

  private doc: Doc<AmDocShape>
  private clock = new DeterministicClock()
  private anchors = new Map<string, Heads>()
  private lastLocalChange: UndoRecord | undefined

  constructor(actor = 'root') {
    this.doc = Automerge.init<AmDocShape>(deriveHexActor(actor))
  }

  // ——— setup ———

  init(root: FdnNode): void {
    this.doc = Automerge.change(
      this.doc,
      { message: encodeEnvelope({ author: 'system', message: 'init' }), time: this.clock.next() },
      (d) => {
        d.rootId = root.id
        d.nodes = {}
        d.order = {}
        d.nodes[root.id] = {
          tag: root.tag,
          props: { ...root.props },
          styles: { ...root.styles },
          parent: null,
          ...(root.text !== undefined ? { text: root.text } : {}),
        }
        d.order[root.id] = []
        root.children.forEach((child, i) => putSubtree(d, root.id, i, child))
      },
    )
  }

  fork(actor: string): ChainAdapter {
    const forked = new AutomergeAdapter(actor)
    forked.doc = Automerge.clone(this.doc, deriveHexActor(actor))
    forked.clock = new DeterministicClock()
    return forked
  }

  merge(other: ChainAdapter): void {
    const peer = this.asAutomerge(other)
    const remote = Automerge.clone(peer.doc)
    this.doc = Automerge.merge(this.doc, remote)
  }

  private asAutomerge(other: ChainAdapter): AutomergeAdapter {
    if (!(other instanceof AutomergeAdapter)) {
      throw new Error('AutomergeAdapter.merge: other adapter is not an AutomergeAdapter')
    }
    return other
  }

  // ——— verbs ———

  insertNode(meta: ChangeMeta, parent: NodeId, index: number, node: FdnNode): void {
    this.doc = Automerge.change(this.doc, this.opts(meta), (d) => {
      putSubtree(d, parent, index, node)
    })
    this.lastLocalChange = { kind: 'insert', id: node.id }
  }

  removeNode(meta: ChangeMeta, id: NodeId): void {
    const current = this.doc.nodes[id]
    if (!current || current.parent === null) throw new Error(`removeNode: cannot remove ${id}`)
    const parent = current.parent
    const index = childIndexOf(this.doc.order[parent], id)
    const snapshot = this.toFdn(this.doc, id)
    this.doc = Automerge.change(this.doc, this.opts(meta), (d) => {
      removeSubtree(d, id)
    })
    this.lastLocalChange = { kind: 'remove', parent, index, snapshot }
  }

  moveNode(meta: ChangeMeta, id: NodeId, newParent: NodeId, index: number): void {
    const current = this.doc.nodes[id]
    if (!current || current.parent === null) throw new Error(`moveNode: cannot move ${id}`)
    const prevParent = current.parent
    const prevIndex = childIndexOf(this.doc.order[prevParent], id)
    this.doc = Automerge.change(this.doc, this.opts(meta), (d) => {
      const node = d.nodes[id]
      if (!node) throw new Error(`moveNode: unknown node ${id}`)
      const oldOrder = d.order[prevParent]
      if (!oldOrder) throw new Error(`moveNode: unknown parent ${prevParent}`)
      const oldIdx = oldOrder.indexOf(id)
      if (oldIdx >= 0) Automerge.deleteAt(oldOrder, oldIdx, 1)
      node.parent = newParent
      const newOrder = d.order[newParent]
      if (!newOrder) throw new Error(`moveNode: unknown parent ${newParent}`)
      Automerge.insertAt(newOrder, index, id)
    })
    this.lastLocalChange = { kind: 'move', id, prevParent, prevIndex }
  }

  setProp(meta: ChangeMeta, id: NodeId, key: string, value: string): void {
    const prevValue = this.doc.nodes[id]?.props[key]
    this.doc = Automerge.change(this.doc, this.opts(meta), (d) => {
      const node = d.nodes[id]
      if (!node) throw new Error(`setProp: unknown node ${id}`)
      node.props[key] = value
    })
    this.lastLocalChange = { kind: 'setProp', id, key, prevValue }
  }

  setStyle(meta: ChangeMeta, id: NodeId, prop: string, value: string): void {
    const prevValue = this.doc.nodes[id]?.styles[prop]
    this.doc = Automerge.change(this.doc, this.opts(meta), (d) => {
      const node = d.nodes[id]
      if (!node) throw new Error(`setStyle: unknown node ${id}`)
      node.styles[prop] = value
    })
    this.lastLocalChange = { kind: 'setStyle', id, prop, prevValue }
  }

  setText(meta: ChangeMeta, id: NodeId, text: string): void {
    const prevValue = this.doc.nodes[id]?.text
    this.doc = Automerge.change(this.doc, this.opts(meta), (d) => {
      const node = d.nodes[id]
      if (!node) throw new Error(`setText: unknown node ${id}`)
      node.text = text
    })
    this.lastLocalChange = { kind: 'setText', id, prevValue }
  }

  undo(meta: ChangeMeta): void {
    const record = this.lastLocalChange
    if (!record) throw new Error('undo: no local change to undo')
    this.doc = Automerge.change(this.doc, this.opts(meta), (d) => {
      switch (record.kind) {
        case 'insert': {
          removeSubtree(d, record.id)
          break
        }
        case 'remove': {
          putSubtree(d, record.parent, record.index, record.snapshot)
          break
        }
        case 'move': {
          const node = d.nodes[record.id]
          if (!node) throw new Error(`undo move: unknown node ${record.id}`)
          const curParent = node.parent
          if (curParent !== null) {
            const curOrder = d.order[curParent]
            if (curOrder) {
              const idx = curOrder.indexOf(record.id)
              if (idx >= 0) Automerge.deleteAt(curOrder, idx, 1)
            }
          }
          node.parent = record.prevParent
          const prevOrder = d.order[record.prevParent]
          if (!prevOrder) throw new Error(`undo move: unknown parent ${record.prevParent}`)
          Automerge.insertAt(prevOrder, record.prevIndex, record.id)
          break
        }
        case 'setProp': {
          const node = d.nodes[record.id]
          if (!node) throw new Error(`undo setProp: unknown node ${record.id}`)
          if (record.prevValue === undefined) delete node.props[record.key]
          else node.props[record.key] = record.prevValue
          break
        }
        case 'setStyle': {
          const node = d.nodes[record.id]
          if (!node) throw new Error(`undo setStyle: unknown node ${record.id}`)
          if (record.prevValue === undefined) delete node.styles[record.prop]
          else node.styles[record.prop] = record.prevValue
          break
        }
        case 'setText': {
          const node = d.nodes[record.id]
          if (!node) throw new Error(`undo setText: unknown node ${record.id}`)
          if (record.prevValue === undefined) delete node.text
          else node.text = record.prevValue
          break
        }
      }
    })
    this.lastLocalChange = undefined
  }

  // ——— reads ———

  materialize(): FdnNode {
    return this.toFdn(this.doc, this.doc.rootId)
  }

  anchor(name: string): AnchorRef {
    this.anchors.set(name, Automerge.getHeads(this.doc))
    return name
  }

  checkout(ref: AnchorRef): FdnNode {
    const heads = this.anchors.get(ref)
    if (!heads) throw new Error(`checkout: unknown anchor ${ref}`)
    const viewed = Automerge.view(this.doc, heads)
    return this.toFdn(viewed, viewed.rootId)
  }

  // SEMANTIC-DIFF-LIFT-START (see run.ts S2 LOC count) — method body only;
  // the bulk of the translation work is in liftPatches() below, separately
  // marked, since it isn't reusable for anything else in this adapter.
  diff(a: AnchorRef, b: AnchorRef): SemanticOp[] {
    const from = this.anchors.get(a)
    const to = this.anchors.get(b)
    if (!from) throw new Error(`diff: unknown anchor ${a}`)
    if (!to) throw new Error(`diff: unknown anchor ${b}`)
    const patches = Automerge.diff(this.doc, from, to)
    const target = Automerge.view(this.doc, to)
    return liftPatches(patches, target)
  }
  // SEMANTIC-DIFF-LIFT-END

  history(): ChangeRecord[] {
    const changes = Automerge.getAllChanges(this.doc)
    const decoded = changes.map((c) => Automerge.decodeChange(c))
    decoded.sort((x, y) => x.time - y.time)
    return decoded.map((c) => ({ meta: decodeEnvelope(c.message), nativeId: c.hash }))
  }

  save(): Uint8Array {
    return Automerge.save(this.doc)
  }

  load(data: Uint8Array): void {
    this.doc = Automerge.load<AmDocShape>(data)
    this.anchors.clear()
  }

  // ——— internals ———

  private opts(meta: ChangeMeta): Automerge.ChangeOptions<AmDocShape> {
    return { message: encodeEnvelope(meta), time: this.clock.next() }
  }

  private toFdn(doc: AmDocShape, id: NodeId): FdnNode {
    const n = doc.nodes[id]
    if (!n) throw new Error(`toFdn: unknown node ${id}`)
    const childIds = doc.order[id] ?? []
    // Reconciliation workaround (see file header): only trust an order-list
    // entry as a real child if that child's own parent pointer still agrees.
    const children = childIds
      .filter((cid) => doc.nodes[cid]?.parent === id)
      .map((cid) => this.toFdn(doc, cid))
    return {
      id,
      tag: n.tag,
      props: { ...n.props },
      styles: { ...n.styles },
      ...(n.text !== undefined ? { text: n.text } : {}),
      children,
    }
  }
}

function putSubtree(d: AmDocShape, parent: NodeId, index: number, node: FdnNode): void {
  d.nodes[node.id] = {
    tag: node.tag,
    props: { ...node.props },
    styles: { ...node.styles },
    parent,
    ...(node.text !== undefined ? { text: node.text } : {}),
  }
  d.order[node.id] = []
  const list = d.order[parent]
  if (!list) throw new Error(`putSubtree: unknown parent ${parent}`)
  Automerge.insertAt(list, index, node.id)
  node.children.forEach((child, i) => putSubtree(d, node.id, i, child))
}

function removeSubtree(d: AmDocShape, id: NodeId): void {
  const node = d.nodes[id]
  if (!node) return
  const order = d.order[id] ?? []
  for (const childId of [...order]) removeSubtree(d, childId)
  if (node.parent !== null) {
    const parentOrder = d.order[node.parent]
    if (parentOrder) {
      const idx = parentOrder.indexOf(id)
      if (idx >= 0) Automerge.deleteAt(parentOrder, idx, 1)
    }
  }
  delete d.nodes[id]
  delete d.order[id]
}

/**
 * Lift Automerge's raw JSON patches to the contract's SemanticOp vocabulary.
 *
 * This is the S2 secondary in the README: how much adapter code it takes to
 * reconstruct insert/remove/move/set-prop/set-style/set-text from Automerge's
 * primitive patches against our {nodes, order} shape. Compare this function's
 * length against LoroAdapter.diff() in loro.ts — Loro's native TreeDiff
 * already speaks almost exactly our vocabulary, Automerge's doesn't (see
 * RESULTS.md).
 *
 * Wrinkle discovered while building this (a finding in its own right):
 * Automerge represents *every* string-valued put as a `put ""` (or the old
 * value) followed by one or more `splice` patches that fill in the new
 * content character-by-character — even for plain scalar string fields that
 * are never edited concurrently at the character level (our `tag`, prop and
 * style values, `order` list entries which are node ids). Reconstructing the
 * final string by replaying those splices is possible but fragile and closely
 * coupled to Automerge's internal diff-encoding choices. Instead we use the
 * patch stream only to learn WHICH (node, field) changed and WHAT KIND of
 * change it was (put/del/insert), then resolve the actual resulting value by
 * reading it straight out of a `view()` of the document at the target anchor
 * — a cheap, non-mutating read. Patch shapes are matched with an exact path
 * length so the deeper `splice` patches (which share the same path prefix)
 * don't cause duplicate emission.
 */
// SEMANTIC-DIFF-LIFT-START (see run.ts S2 LOC count)
function liftPatches(patches: Patch[], target: AmDocShape): SemanticOp[] {
  const ops: SemanticOp[] = []
  const createdIds = new Set<NodeId>()

  for (const p of patches) {
    if (p.path[0] === 'nodes' && p.path.length === 3 && p.path[2] === 'tag') {
      const id = p.path[1]
      if (typeof id === 'string') createdIds.add(id)
    }
  }

  for (const p of patches) {
    if (p.path[0] === 'nodes') {
      const id = p.path[1]
      if (typeof id !== 'string') continue
      if (p.path.length === 2 && p.action === 'del') {
        ops.push({ op: 'remove-node', id })
        continue
      }
      if (p.path.length === 4 && p.path[2] === 'props' && typeof p.path[3] === 'string') {
        const key = p.path[3]
        const value = target.nodes[id]?.props[key]
        ops.push({ op: 'set-prop', id, key, value: value === undefined ? null : value })
        continue
      }
      if (p.path.length === 4 && p.path[2] === 'styles' && typeof p.path[3] === 'string') {
        const prop = p.path[3]
        const value = target.nodes[id]?.styles[prop]
        ops.push({ op: 'set-style', id, prop, value: value === undefined ? null : value })
        continue
      }
      if (p.path.length === 3 && p.path[2] === 'text') {
        const value = target.nodes[id]?.text
        if (value !== undefined) ops.push({ op: 'set-text', id, text: value })
        continue
      }
      // 'tag' / 'parent' path puts don't map to a standalone SemanticOp on
      // their own; they're folded into insert-node / move-node below via the
      // order-list patches, which is where position (index) lives.
    } else if (p.path[0] === 'order') {
      const parent = p.path[1]
      const index = p.path[2]
      if (typeof parent !== 'string' || typeof index !== 'number') continue
      if (p.action === 'insert') {
        for (let i = 0; i < p.values.length; i++) {
          const id = target.order[parent]?.[index + i]
          if (typeof id !== 'string') continue
          if (createdIds.has(id)) {
            const tag = target.nodes[id]?.tag ?? ''
            ops.push({ op: 'insert-node', id, parent, index: index + i, tag })
          } else {
            ops.push({ op: 'move-node', id, parent, index: index + i })
          }
        }
      }
      // 'del' on an order list is redundant with either the corresponding
      // nodes/<id> delete patch (remove-node) or the new parent's insert
      // patch (move-node) — no separate SemanticOp needed.
    }
  }

  return ops
}
// SEMANTIC-DIFF-LIFT-END
