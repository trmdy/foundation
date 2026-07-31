/**
 * ChainAdapter over loro-crdt (LoroDoc + LoroTree movable tree).
 *
 * Design notes (see RESULTS.md "findings" for the write-up):
 *
 * - Loro's TreeID is a `${counter}@${peer}` identity assigned BY Loro, not the
 *   stable string NodeId our contract uses. We keep the external NodeId inside
 *   each tree node's metadata map (`data.get('id')`) and maintain a JS-side
 *   Map<NodeId, TreeID> (`idToTree`) rebuilt from doc content after merge/load.
 *   This is the one adapter-side bookkeeping structure Loro needs; Automerge
 *   needs a materially bigger one (see automerge.ts).
 * - Loro has no concept of "author" distinct from the numeric peer id, and no
 *   structured change metadata beyond a single `message` string. We pack the
 *   Foundation envelope {author, message} as JSON into that message string.
 *   This is a finding, not a contract gap: SPEC D2 already anticipates a thin
 *   Foundation envelope wrapping library change blocks for exactly this reason.
 * - `nativeId` for history/roundtrip purposes is `${peer}:${counter}` (Loro's
 *   own op identity) — Loro does not content-hash changes the way Automerge
 *   does (SPEC D2 open question 1 flags this explicitly).
 * - checkout() is destructive to LoroDoc's live state (`doc.checkout` detaches
 *   the whole document). We save/restore frontiers around it so the contract's
 *   "must not disturb current state" requirement holds from the caller's point
 *   of view, at the cost of a small amount of adapter bookkeeping.
 */

import { LoroDoc, LoroMap, LoroTree, LoroTreeNode } from 'loro-crdt'
import type { ContainerID, PeerID, TreeID } from 'loro-crdt'
import type {
  AnchorRef,
  ChainAdapter,
  ChangeMeta,
  ChangeRecord,
  FdnNode,
  NodeId,
  SemanticOp,
} from './contract.js'
import { DeterministicClock, derivePeerId } from './util.js'

type Frontier = { peer: PeerID; counter: number }[]

type ContainerKind = 'props' | 'styles'
interface ContainerInfo {
  nodeId: NodeId
  kind: ContainerKind
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

function decodeEnvelope(raw: string | undefined): ChangeMeta {
  if (raw === undefined) return { author: 'unknown', message: '' }
  try {
    const parsed = JSON.parse(raw) as Partial<Envelope>
    return { author: parsed.author ?? 'unknown', message: parsed.message ?? '' }
  } catch {
    // Non-JSON message (e.g. from a peer that didn't use our envelope convention).
    return { author: 'unknown', message: raw }
  }
}

export class LoroAdapter implements ChainAdapter {
  readonly name = 'loro' as const

  private doc: LoroDoc
  private tree: LoroTree
  private clock = new DeterministicClock()
  private idToTree = new Map<NodeId, TreeID>()
  private treeToId = new Map<TreeID, NodeId>()
  private containerKind = new Map<ContainerID, ContainerInfo>()
  private anchors = new Map<string, Frontier>()
  private lastLocalChange: UndoRecord | undefined

  constructor() {
    this.doc = new LoroDoc()
    this.doc.setPeerId(derivePeerId('root'))
    this.tree = this.doc.getTree('tree')
  }

  // ——— setup ———

  init(root: FdnNode): void {
    this.createSubtree(undefined, 0, root)
    this.doc.commit({
      message: encodeEnvelope({ author: 'system', message: 'init' }),
      timestamp: this.clock.next(),
    })
    this.rebuildIndex()
  }

  fork(actor: string): ChainAdapter {
    const forked = new LoroAdapter()
    forked.doc = this.doc.fork()
    forked.doc.setPeerId(derivePeerId(actor))
    forked.tree = forked.doc.getTree('tree')
    forked.clock = new DeterministicClock()
    forked.rebuildIndex()
    return forked
  }

  merge(other: ChainAdapter): void {
    const peer = this.asLoro(other)
    const update = peer.doc.export({ mode: 'update' })
    this.doc.import(update)
    this.rebuildIndex()
  }

  private asLoro(other: ChainAdapter): LoroAdapter {
    if (!(other instanceof LoroAdapter)) {
      throw new Error('LoroAdapter.merge: other adapter is not a LoroAdapter')
    }
    return other
  }

  // ——— verbs ———

  insertNode(meta: ChangeMeta, parent: NodeId, index: number, node: FdnNode): void {
    const parentTreeId = this.treeIdOf(parent)
    this.createSubtree(parentTreeId, index, node)
    this.lastLocalChange = { kind: 'insert', id: node.id }
    this.commit(meta)
  }

  removeNode(meta: ChangeMeta, id: NodeId): void {
    const treeId = this.treeIdOf(id)
    const node = this.tree.getNodeByID(treeId)
    if (!node) throw new Error(`removeNode: unknown node ${id}`)
    const parentNode = node.parent()
    const parentId = parentNode ? this.externalIdOf(parentNode.id) : undefined
    const index = node.index() ?? 0
    const snapshot = this.toFdn(node)
    if (parentId === undefined) throw new Error(`removeNode: node ${id} has no parent (cannot remove root)`)
    this.tree.delete(treeId)
    this.lastLocalChange = { kind: 'remove', parent: parentId, index, snapshot }
    this.commit(meta)
  }

  moveNode(meta: ChangeMeta, id: NodeId, newParent: NodeId, index: number): void {
    const treeId = this.treeIdOf(id)
    const node = this.tree.getNodeByID(treeId)
    if (!node) throw new Error(`moveNode: unknown node ${id}`)
    const prevParentNode = node.parent()
    const prevParentId = prevParentNode ? this.externalIdOf(prevParentNode.id) : undefined
    const prevIndex = node.index() ?? 0
    if (prevParentId === undefined) throw new Error(`moveNode: node ${id} has no parent (cannot move root)`)
    const newParentTreeId = this.treeIdOf(newParent)
    this.tree.move(treeId, newParentTreeId, index)
    this.lastLocalChange = { kind: 'move', id, prevParent: prevParentId, prevIndex }
    this.commit(meta)
  }

  setProp(meta: ChangeMeta, id: NodeId, key: string, value: string): void {
    const node = this.nodeOf(id)
    const props = node.data.get('props') as LoroMap
    const prevValue = props.get(key) as string | undefined
    props.set(key, value)
    this.lastLocalChange = { kind: 'setProp', id, key, prevValue }
    this.commit(meta)
  }

  setStyle(meta: ChangeMeta, id: NodeId, prop: string, value: string): void {
    const node = this.nodeOf(id)
    const styles = node.data.get('styles') as LoroMap
    const prevValue = styles.get(prop) as string | undefined
    styles.set(prop, value)
    this.lastLocalChange = { kind: 'setStyle', id, prop, prevValue }
    this.commit(meta)
  }

  setText(meta: ChangeMeta, id: NodeId, text: string): void {
    const node = this.nodeOf(id)
    const prevValue = node.data.get('text') as string | undefined
    node.data.set('text', text)
    this.lastLocalChange = { kind: 'setText', id, prevValue }
    this.commit(meta)
  }

  undo(meta: ChangeMeta): void {
    const record = this.lastLocalChange
    if (!record) throw new Error('undo: no local change to undo')
    switch (record.kind) {
      case 'insert': {
        this.tree.delete(this.treeIdOf(record.id))
        break
      }
      case 'remove': {
        const parentTreeId = this.treeIdOf(record.parent)
        this.createSubtree(parentTreeId, record.index, record.snapshot)
        break
      }
      case 'move': {
        const treeId = this.treeIdOf(record.id)
        const prevParentTreeId = this.treeIdOf(record.prevParent)
        this.tree.move(treeId, prevParentTreeId, record.prevIndex)
        break
      }
      case 'setProp': {
        const node = this.nodeOf(record.id)
        const props = node.data.get('props') as LoroMap
        if (record.prevValue === undefined) props.delete(record.key)
        else props.set(record.key, record.prevValue)
        break
      }
      case 'setStyle': {
        const node = this.nodeOf(record.id)
        const styles = node.data.get('styles') as LoroMap
        if (record.prevValue === undefined) styles.delete(record.prop)
        else styles.set(record.prop, record.prevValue)
        break
      }
      case 'setText': {
        const node = this.nodeOf(record.id)
        if (record.prevValue === undefined) node.data.delete('text')
        else node.data.set('text', record.prevValue)
        break
      }
    }
    this.lastLocalChange = undefined
    this.commit(meta)
  }

  // ——— reads ———

  materialize(): FdnNode {
    const roots = this.tree.roots()
    const root = roots[0]
    if (!root) throw new Error('materialize: tree has no root')
    return this.toFdn(root)
  }

  anchor(name: string): AnchorRef {
    this.anchors.set(name, this.doc.frontiers())
    return name
  }

  checkout(ref: AnchorRef): FdnNode {
    const target = this.anchors.get(ref)
    if (!target) throw new Error(`checkout: unknown anchor ${ref}`)
    const saved = this.doc.frontiers()
    this.doc.checkout(target)
    try {
      const roots = this.tree.roots()
      const root = roots[0]
      if (!root) throw new Error('checkout: tree has no root at anchor')
      return this.toFdn(root)
    } finally {
      this.doc.checkout(saved)
    }
  }

  // SEMANTIC-DIFF-LIFT-START (see run.ts S2 LOC count)
  diff(a: AnchorRef, b: AnchorRef): SemanticOp[] {
    const from = this.anchors.get(a)
    const to = this.anchors.get(b)
    if (!from) throw new Error(`diff: unknown anchor ${a}`)
    if (!to) throw new Error(`diff: unknown anchor ${b}`)
    const raw = this.doc.diff(from, to, false)
    const ops: SemanticOp[] = []
    for (const [cid, d] of raw) {
      if (d.type === 'tree') {
        for (const item of d.diff) {
          if (item.action === 'create') {
            ops.push({
              op: 'insert-node',
              id: this.externalIdOf(item.target),
              parent: item.parent ? this.externalIdOf(item.parent) : '',
              index: item.index,
              tag: this.tagOf(item.target),
            })
          } else if (item.action === 'delete') {
            ops.push({ op: 'remove-node', id: this.externalIdOf(item.target) })
          } else if (item.action === 'move') {
            ops.push({
              op: 'move-node',
              id: this.externalIdOf(item.target),
              parent: item.parent ? this.externalIdOf(item.parent) : '',
              index: item.index,
            })
          }
        }
      } else if (d.type === 'map') {
        const info = this.containerKind.get(cid)
        if (!info) continue
        for (const [key, value] of Object.entries(d.updated)) {
          if (info.kind === 'props') {
            ops.push({ op: 'set-prop', id: info.nodeId, key, value: value === undefined ? null : String(value) })
          } else {
            ops.push({ op: 'set-style', id: info.nodeId, prop: key, value: value === undefined ? null : String(value) })
          }
        }
      }
    }
    return ops
  }
  // SEMANTIC-DIFF-LIFT-END

  history(): ChangeRecord[] {
    const all = this.doc.getAllChanges()
    const flat: { lamport: number; peer: PeerID; counter: number; message: string | undefined }[] = []
    for (const changes of all.values()) {
      for (const c of changes) {
        flat.push({ lamport: c.lamport, peer: c.peer, counter: c.counter, message: c.message })
      }
    }
    flat.sort((x, y) => x.lamport - y.lamport)
    return flat.map((c) => ({
      meta: decodeEnvelope(c.message),
      nativeId: `${c.peer}:${c.counter}`,
    }))
  }

  save(): Uint8Array {
    return this.doc.export({ mode: 'snapshot' })
  }

  load(data: Uint8Array): void {
    this.doc = LoroDoc.fromSnapshot(data)
    this.tree = this.doc.getTree('tree')
    this.rebuildIndex()
  }

  // ——— internals ———

  private commit(meta: ChangeMeta): void {
    this.doc.commit({ message: encodeEnvelope(meta), timestamp: this.clock.next() })
  }

  private treeIdOf(id: NodeId): TreeID {
    const treeId = this.idToTree.get(id)
    if (!treeId) throw new Error(`unknown NodeId: ${id}`)
    return treeId
  }

  private externalIdOf(treeId: TreeID): NodeId {
    const cached = this.treeToId.get(treeId)
    if (cached) return cached
    const node = this.tree.getNodeByID(treeId)
    const id = node?.data.get('id') as NodeId | undefined
    if (!id) throw new Error(`unknown TreeID: ${treeId}`)
    this.treeToId.set(treeId, id)
    this.idToTree.set(id, treeId)
    return id
  }

  private tagOf(treeId: TreeID): string {
    const node = this.tree.getNodeByID(treeId)
    return (node?.data.get('tag') as string | undefined) ?? ''
  }

  private nodeOf(id: NodeId): LoroTreeNode {
    const treeId = this.treeIdOf(id)
    const node = this.tree.getNodeByID(treeId)
    if (!node) throw new Error(`unknown NodeId: ${id}`)
    return node
  }

  /** Create `fdn` (and its descendants) as one subtree, without committing. */
  private createSubtree(parent: TreeID | undefined, index: number, fdn: FdnNode): void {
    const node = this.tree.createNode(parent, index)
    node.data.set('id', fdn.id)
    node.data.set('tag', fdn.tag)
    if (fdn.text !== undefined) node.data.set('text', fdn.text)
    const props = node.data.setContainer('props', new LoroMap())
    for (const [k, v] of Object.entries(fdn.props)) props.set(k, v)
    const styles = node.data.setContainer('styles', new LoroMap())
    for (const [k, v] of Object.entries(fdn.styles)) styles.set(k, v)
    this.idToTree.set(fdn.id, node.id)
    this.treeToId.set(node.id, fdn.id)
    this.containerKind.set(props.id, { nodeId: fdn.id, kind: 'props' })
    this.containerKind.set(styles.id, { nodeId: fdn.id, kind: 'styles' })
    fdn.children.forEach((child, i) => this.createSubtree(node.id, i, child))
  }

  private toFdn(node: LoroTreeNode): FdnNode {
    const id = node.data.get('id') as NodeId
    const tag = node.data.get('tag') as string
    const propsMap = node.data.get('props') as LoroMap
    const stylesMap = node.data.get('styles') as LoroMap
    const props: Record<string, string> = {}
    for (const [k, v] of propsMap.entries()) props[k] = v as string
    const styles: Record<string, string> = {}
    for (const [k, v] of stylesMap.entries()) styles[k] = v as string
    const text = node.data.get('text') as string | undefined
    const children = (node.children() ?? []).map((c) => this.toFdn(c))
    return { id, tag, props, styles, ...(text !== undefined ? { text } : {}), children }
  }

  private rebuildIndex(): void {
    this.idToTree.clear()
    this.treeToId.clear()
    this.containerKind.clear()
    for (const node of this.tree.nodes()) {
      const id = node.data.get('id') as NodeId | undefined
      if (id === undefined) continue
      this.idToTree.set(id, node.id)
      this.treeToId.set(node.id, id)
      const props = node.data.get('props') as LoroMap | undefined
      const styles = node.data.get('styles') as LoroMap | undefined
      if (props) this.containerKind.set(props.id, { nodeId: id, kind: 'props' })
      if (styles) this.containerKind.set(styles.id, { nodeId: id, kind: 'styles' })
    }
  }
}
