/**
 * FdnChain over loro-crdt (LoroDoc + LoroTree movable tree) — the Foundation
 * chain module (SPEC D2 + resolved open question 1). Ports the proven
 * patterns from spikes/chain/src/loro.ts (LoroTree for hierarchy, one
 * LoroMap per node for attrs/style/styleStates, deterministic peer-id
 * derivation, {author,message} packed into the commit message, save/restore
 * around detaching checkout(), TreeID<->NodeId bookkeeping) and extends them
 * to the full FdnDocument (tokens/params/data/lookups/states/viewports/
 * matrix/namedStyles/components), the Foundation envelope hash chain, and
 * undo via PatchOp inversion. See model.ts for the Loro-free op-inversion and
 * structural-diff logic, and envelope.ts for the exact hash method.
 *
 * Container layout (one LoroDoc, all containers are roots on it):
 *   - `tree`: LoroTree. Each top-level FdnDocument.body[] entry is a Loro
 *     tree ROOT (no single wrapping root node — body is genuinely an array,
 *     and LoroTree supports multiple roots natively, ordered like siblings).
 *     Every node's `data` map holds: id, tag, text, styleRef, when, each
 *     (scalars, null = absent) plus THREE child containers for the fields
 *     PatchOp can address at key/prop granularity: `attrs` (LoroMap),
 *     `style` (LoroMap), `styleStates` (LoroMap of up to 4 lazily-created
 *     sub-LoroMaps keyed by StateStyleKey).
 *   - `meta`: LoroMap — specVersion, title (document-level scalars; no
 *     PatchOp addresses these individually, only replace-document touches
 *     them — a contract finding, see below).
 *   - `tokens`: LoroMap<string,string> — set-token is scalar-per-key, so a
 *     flat map matches the op grain exactly.
 *   - `params`/`data`/`lookups`/`states`/`viewports`/`namedStyles`/
 *     `components`: LoroMap keyed by each item's `.name`, value = a
 *     stableStringify'd JSON blob of the WHOLE item. None of these ops are
 *     finer than "replace the whole named item" (set-param, set-named-style,
 *     ...), so a JSON blob per map key matches the op grain exactly while
 *     still giving concurrent edits to DIFFERENT names real CRDT
 *     independence (only same-name concurrent edits collapse to LWW).
 *   - `matrix`: LoroList<string> of stableStringify'd {state,viewport} JSON
 *     blobs — matrix entries have no natural key and no PatchOp reaches them
 *     individually (only replace-document does), so this is a plain ordered
 *     list, cleared+repopulated wholesale on replace-document.
 *   - `annotations`: LoroMap keyed by FdnAnnotation.id (same JSON-blob-per-key
 *     shape as params/lookups/states/namedStyles/components — the three
 *     annotation PatchOps are whole-item or single-scalar-field writes, same
 *     grain). Concurrent annotations from different authors merge for free
 *     (different keys); concurrent status writes to the SAME annotation
 *     collapse to Loro's last-writer-wins on that map entry, same as any
 *     other same-key concurrent write in this file.
 *
 * Contract findings (see final report for the full list):
 *   - No PatchOp touches `data`/`viewports`/`matrix` at all — only
 *     replace-document does. They still get real Loro containers per the
 *     task brief, so a future finer-grained op could reach them without a
 *     storage migration.
 *   - No remove-param/remove-lookup/remove-state exists — undoing a
 *     first-time set-param/set-lookup/set-state has no typed inverse and
 *     falls back to a whole-document replace-document undo (model.ts).
 *   - (RESOLVED 2026-07-31, contract amendment) SemanticOp gained
 *     set-style-ref/set-when variants and a 'meta' section-changed section
 *     for title/specVersion — diff() now emits all of these (model.ts).
 *   - (RESOLVED 2026-07-31, contract amendment) loadChain(bytes, opts?)
 *     now takes an optional `{actor?: string}`, matching createChain. When
 *     omitted, the peer id for the loaded chain's future local edits still
 *     falls back to a hash of the snapshot bytes (documented below), which
 *     remains collision-prone for two independent loads of the same bytes
 *     that both edit locally before merging — callers that anticipate that
 *     scenario should pass distinct actors explicitly.
 *   - (Wave 3, contract amendment) SPEC 13a-i mints a document id at
 *     creation and wants it "carried ... in the chain's metadata". types.ts
 *     (FdnDocument) has no field for it and is off-limits, so it does NOT
 *     round-trip through FdnDocument/PatchOp at all — it lives ONLY in the
 *     chain's own `meta` LoroMap (a plain scalar, exactly like specVersion/
 *     title already are), set ONCE at creation via a new optional
 *     `createChain(doc, meta, { docId })` field (additive, mirrors the
 *     existing `actor` precedent above) and read via the new `docId()`
 *     accessor. Folding the `meta.set('docId', …)` into the SAME mutation
 *     batch as the initial `replace-document` apply (see `LoroChain.create`)
 *     means it rides along on that one commit's explicit `loro.commit()` —
 *     no separate envelope, no risk of an anonymous/unmessaged Loro Change
 *     from a later implicit flush (export/checkout auto-commit pending ops
 *     with whatever message was last explicitly set, or none). There is
 *     deliberately no `setDocId()` — every caller that needs one sets it at
 *     creation time (see packages/cli commands/{new,chain}.ts). The CLI
 *     stamps the same id into the `.fdn.html` text as `data-fdn-doc-id` on
 *     `<fdn-doc>` by a small string-level insert (packages/cli/src/docid.ts)
 *     — NOT through projectDocument — since parse/project's Wave-1-fixed
 *     signatures have no channel to carry it.
 *   - (Wave 3, contract amendment) `changes()` and `importUpdate()` added
 *     for the blob-exchange wire format (SPEC 13a-iv, API.md "chain
 *     exchange"): `changes()` exposes the same per-Loro-Change envelope +
 *     raw update-bytes pairing that `log()`/`save()` already compute
 *     internally (log() now just maps over it), and `importUpdate()` is
 *     `merge()`'s existing `loro.import(...); rebuildIndex()` pattern
 *     generalized to accept a single change's bytes (as produced by
 *     `changes()` on the sending side) instead of a whole other chain's
 *     full update export.
 */

import { LoroDoc, LoroMap } from 'loro-crdt'
import type { Change, LoroList, LoroTree, LoroTreeNode, PeerID, TreeID } from 'loro-crdt'
import type {
  AnchorRef,
  ChangeMeta,
  EnvelopeRecord,
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
import { computeEnvelopeHash, decodeEnvelope, encodeEnvelope, type PackedEnvelope } from './envelope.js'
import { indexNodes, invertOp, structuralDiff } from './model.js'
import { comparePeerIds, derivePeerId, DeterministicClock, stableStringify } from './util.js'
import { createHash } from 'node:crypto'

const STATE_KEYS: StateStyleKey[] = ['hover', 'focus', 'active', 'disabled']

type Frontier = { peer: PeerID; counter: number }[]

/** Fixed public interface (API.md) — no Loro types appear anywhere here.
 *  docId()/changes()/importUpdate() are Wave 3 additions (see module doc's
 *  "contract amendment" notes) — not part of the API.md wave-1 signature
 *  list, additive only, needed by the blob-exchange functions in
 *  exchange.ts. */
export interface FdnChain {
  doc(): FdnDocument
  apply(meta: ChangeMeta, ops: PatchOp[]): EnvelopeRecord
  anchor(name: string): AnchorRef
  checkout(ref: AnchorRef): FdnDocument
  diff(a: AnchorRef, b: AnchorRef): SemanticOp[]
  undo(meta: ChangeMeta): EnvelopeRecord
  head(): EnvelopeRecord
  log(): EnvelopeRecord[]
  fork(actor: string): FdnChain
  merge(other: FdnChain): void
  save(): Uint8Array
  verify(): { ok: boolean; brokenAt?: string }
  /** Wave 3 (SPEC 13a-i): the document id, or null if this chain predates/
   *  never received one. Immutable once set — see createChain's `docId` opt. */
  docId(): string | null
  /** Wave 3 (SPEC 13a-iv): one entry per Loro Change (== one apply() batch),
   *  oldest first, pairing each envelope with the exact update bytes that
   *  reproduce it — the unit exportBlobs() writes one-per-file. */
  changes(): { envelope: EnvelopeRecord; bytes: Uint8Array }[]
  /** Wave 3 (SPEC 13a-iv): import one change's raw update bytes (as found in
   *  a `changes()` entry / a `.fdnc` blob) into this chain. Like merge(), but
   *  for a single change instead of another chain's whole update export. */
  importUpdate(bytes: Uint8Array): void
  /** Wave 3 (exchange.ts overlap heuristic): materializes the document you'd
   *  get by importing exactly the given list of raw update-bytes spans (each
   *  as produced by `changes()` / a decoded `.fdnc` blob), in order, into a
   *  fresh empty chain — a pure function of the bytes, unrelated to this
   *  chain's own current state. Used to reconstruct a true common ancestor
   *  (pass a prefix of `changes()`) or "what the other side alone claims"
   *  (ancestor prefix + only their incoming changes, excluding any of our
   *  own unshared local edits) without needing a checkout()-able named
   *  anchor at that exact point. */
  docFromUpdates(updates: Uint8Array[]): FdnDocument
}

export function createChain(doc: FdnDocument, meta: ChangeMeta, opts?: { actor?: string; docId?: string }): FdnChain {
  return LoroChain.create(doc, meta, opts?.actor ?? meta.author, opts?.docId)
}

export function loadChain(bytes: Uint8Array, opts?: { actor?: string }): FdnChain {
  return LoroChain.load(bytes, opts?.actor)
}

class LoroChain implements FdnChain {
  private loro: LoroDoc
  private tree: LoroTree
  private meta: LoroMap
  private tokens: LoroMap
  private params: LoroMap
  private data: LoroMap
  private lookups: LoroMap
  private states: LoroMap
  private viewports: LoroMap
  private matrix: LoroList
  private namedStyles: LoroMap
  private components: LoroMap
  /** Wave "annotations first-class citizen" (SPEC D2/D4/13a, types.ts's
   *  FdnAnnotation): LoroMap keyed by annotation `.id`, one stableStringify'd
   *  JSON blob per key — same "whole-item replace matches the op grain"
   *  reasoning as params/lookups/states/namedStyles/components above. The
   *  three PatchOps (annotate/set-annotation-status/remove-annotation) are
   *  all either whole-item or single-scalar-field writes, so a flat keyed
   *  map (not a nested per-field container) is the right grain here too. */
  private annotations: LoroMap

  private clock = new DeterministicClock()
  private idToTree = new Map<NodeId, TreeID>()
  private peerId: number
  private peerIdStr: PeerID
  private anchors = new Map<string, Frontier>()
  private lastLocalChange: PatchOp[] | undefined

  constructor(actor: string, loro?: LoroDoc) {
    this.peerId = derivePeerId(actor)
    this.peerIdStr = String(this.peerId) as PeerID
    this.loro = loro ?? new LoroDoc()
    this.loro.setPeerId(this.peerId)
    // Loro auto-merges same-peer changes whose commit timestamps are within
    // `mergeInterval` seconds of each other (default 1000s) into one oplog
    // Change. Our DeterministicClock increments by 1 per commit, so without
    // this the whole chain would silently collapse into a single Change —
    // disable it so "one apply() = one Loro commit" actually holds.
    this.loro.setChangeMergeInterval(0)
    this.tree = this.loro.getTree('tree')
    this.meta = this.loro.getMap('meta')
    this.tokens = this.loro.getMap('tokens')
    this.params = this.loro.getMap('params')
    this.data = this.loro.getMap('data')
    this.lookups = this.loro.getMap('lookups')
    this.states = this.loro.getMap('states')
    this.viewports = this.loro.getMap('viewports')
    this.matrix = this.loro.getList('matrix')
    this.namedStyles = this.loro.getMap('namedStyles')
    this.components = this.loro.getMap('components')
    this.annotations = this.loro.getMap('annotations')
  }

  static create(doc: FdnDocument, meta: ChangeMeta, actor: string, docId?: string): LoroChain {
    const chain = new LoroChain(actor)
    // Set BEFORE apply() so it rides along inside that call's own explicit
    // commit (see module doc's Wave 3 contract-amendment note) instead of
    // sitting as a separate, unmessaged pending mutation.
    if (docId !== undefined) chain.meta.set('docId', docId)
    chain.apply(meta, [{ op: 'replace-document', doc }])
    return chain
  }

  static load(bytes: Uint8Array, actor?: string): LoroChain {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const anchorsLen = view.getUint32(0, true)
    const anchorsBytes = bytes.subarray(4, 4 + anchorsLen)
    const snapshotBytes = bytes.subarray(4 + anchorsLen)
    const entries = JSON.parse(new TextDecoder().decode(anchorsBytes)) as [string, Frontier][]
    const loro = LoroDoc.fromSnapshot(snapshotBytes)
    // Explicit actor (contract amendment 2026-07-31) always wins. Falling
    // back to a hash of the snapshot bytes keeps behavior deterministic (no
    // Date.now/Math.random) for callers that don't supply one, but remains
    // collision-prone: two independent loadChain(sameBytes) calls with no
    // actor derive the SAME peer id, which is only safe if at most one of
    // them ever commits locally before any merge.
    const resolvedActor = actor ?? `loaded:${createHash('sha256').update(snapshotBytes).digest('hex')}`
    const chain = new LoroChain(resolvedActor, loro)
    chain.rebuildIndex()
    for (const [name, frontier] of entries) chain.anchors.set(name, frontier)
    return chain
  }

  // ——— public interface ———

  doc(): FdnDocument {
    return this.materialize()
  }

  apply(meta: ChangeMeta, ops: PatchOp[]): EnvelopeRecord {
    if (ops.length === 0) throw new Error('apply: ops must not be empty')
    const beforeDoc = this.materialize()
    const nodeIndex = indexNodes(beforeDoc.body)
    const beforeVV = this.loro.version()
    const startCounter = beforeVV.get(this.peerIdStr) ?? 0
    // Must read `head`/prevHash BEFORE mutating: log()/head() walk
    // getAllChanges(), which implicitly flushes any pending uncommitted ops
    // (see chain.ts module doc) — calling it after mutating but before our
    // own explicit commit() would silently steal our message.
    const prevHash = this.tryHead()?.hash ?? null
    const inverses: PatchOp[] = []
    let fallback = false
    for (const op of ops) {
      const inv = invertOp(op, beforeDoc, nodeIndex)
      if (inv === 'fallback') fallback = true
      else if (inv !== null) inverses.push(inv)
      this.applyOp(op)
    }
    this.lastLocalChange = fallback ? [{ op: 'replace-document', doc: beforeDoc }] : inverses.reverse()
    return this.commitEnvelope(meta, startCounter, prevHash)
  }

  undo(meta: ChangeMeta): EnvelopeRecord {
    const inverseOps = this.lastLocalChange
    if (!inverseOps) throw new Error('undo: no local change to undo')
    return this.apply(meta, inverseOps)
  }

  anchor(name: string): AnchorRef {
    this.anchors.set(name, this.loro.frontiers())
    return name
  }

  checkout(ref: AnchorRef): FdnDocument {
    const frontier = this.anchors.get(ref)
    if (!frontier) throw new Error(`checkout: unknown anchor ${ref}`)
    // checkout() always detaches the live doc (Loro semantics), even when
    // the target frontier IS the current latest — so restoring via
    // `checkout(savedFrontiers)` would still leave the doc detached
    // (read-only). checkoutToLatest() is the only way back to a live,
    // editable doc, which is the invariant every other public method here
    // relies on (the doc is always attached before/after any call).
    this.loro.checkout(frontier)
    try {
      return this.materialize()
    } finally {
      this.loro.checkoutToLatest()
    }
  }

  diff(a: AnchorRef, b: AnchorRef): SemanticOp[] {
    return structuralDiff(this.checkout(a), this.checkout(b))
  }

  head(): EnvelopeRecord {
    const h = this.tryHead()
    if (!h) throw new Error('head: chain has no changes yet')
    return h
  }

  log(): EnvelopeRecord[] {
    return this.changes().map((c) => c.envelope)
  }

  docId(): string | null {
    return (this.meta.get('docId') as string | undefined) ?? null
  }

  changes(): { envelope: EnvelopeRecord; bytes: Uint8Array }[] {
    const out: { envelope: EnvelopeRecord; bytes: Uint8Array }[] = []
    for (const c of this.sortedChanges()) {
      const decoded = decodeEnvelope(c.message)
      const bytes = this.bytesForSpan(c.peer, c.counter, c.length)
      const hash = computeEnvelopeHash(decoded.prevHash, decoded.author, decoded.message, decoded.specVersion, bytes)
      out.push({
        envelope: { hash, prevHash: decoded.prevHash, author: decoded.author, message: decoded.message, specVersion: decoded.specVersion },
        bytes,
      })
    }
    return out
  }

  importUpdate(bytes: Uint8Array): void {
    this.loro.import(bytes)
    this.rebuildIndex()
  }

  docFromUpdates(updates: Uint8Array[]): FdnDocument {
    const scratch = new LoroChain(`scratch:${this.peerIdStr}:${updates.length}`)
    for (const bytes of updates) {
      if (bytes.length > 0) scratch.importUpdate(bytes)
    }
    return scratch.doc()
  }

  fork(actor: string): FdnChain {
    const forked = new LoroChain(actor, this.loro.fork())
    forked.rebuildIndex()
    return forked
  }

  merge(other: FdnChain): void {
    if (!(other instanceof LoroChain)) throw new Error('merge: other chain is not a LoroChain instance')
    this.loro.import(other.loro.export({ mode: 'update' }))
    this.rebuildIndex()
  }

  save(): Uint8Array {
    const snapshot = this.loro.export({ mode: 'snapshot' })
    const anchorsBytes = new TextEncoder().encode(JSON.stringify(Array.from(this.anchors.entries())))
    const header = new Uint8Array(4)
    new DataView(header.buffer).setUint32(0, anchorsBytes.length, true)
    const out = new Uint8Array(4 + anchorsBytes.length + snapshot.length)
    out.set(header, 0)
    out.set(anchorsBytes, 4)
    out.set(snapshot, 4 + anchorsBytes.length)
    return out
  }

  verify(): { ok: boolean; brokenAt?: string } {
    const seen = new Set<string>()
    for (const c of this.sortedChanges()) {
      const decoded = decodeEnvelope(c.message)
      const bytes = this.bytesForSpan(c.peer, c.counter, c.length)
      const hash = computeEnvelopeHash(decoded.prevHash, decoded.author, decoded.message, decoded.specVersion, bytes)
      if (decoded.prevHash !== null && !seen.has(decoded.prevHash)) return { ok: false, brokenAt: hash }
      seen.add(hash)
    }
    return { ok: true }
  }

  // ——— envelope internals ———

  private tryHead(): EnvelopeRecord | null {
    const records = this.log()
    return records.length > 0 ? (records[records.length - 1] as EnvelopeRecord) : null
  }

  private commitEnvelope(meta: ChangeMeta, startCounter: number, prevHash: string | null): EnvelopeRecord {
    const specVersion = (this.meta.get('specVersion') as string | undefined) ?? ''
    const packed: PackedEnvelope = { author: meta.author, message: meta.message, specVersion, prevHash }
    this.loro.commit({ message: encodeEnvelope(packed), timestamp: this.clock.next() })
    const endCounter = this.loro.version().get(this.peerIdStr) ?? 0
    const len = endCounter - startCounter
    const bytes = this.bytesForSpan(this.peerIdStr, startCounter, len)
    const hash = computeEnvelopeHash(prevHash, meta.author, meta.message, specVersion, bytes)
    return { hash, prevHash, author: meta.author, message: meta.message, specVersion }
  }

  private bytesForSpan(peer: PeerID, counter: number, len: number): Uint8Array {
    if (len <= 0) return new Uint8Array(0)
    return this.loro.export({ mode: 'updates-in-range', spans: [{ id: { peer, counter }, len }] })
  }

  private sortedChanges(): Change[] {
    const flat: Change[] = []
    for (const changes of this.loro.getAllChanges().values()) flat.push(...changes)
    flat.sort((a, b) => a.lamport - b.lamport || comparePeerIds(a.peer, b.peer) || a.counter - b.counter)
    return flat
  }

  // ——— mutation ———

  private applyOp(op: PatchOp): void {
    switch (op.op) {
      case 'insert-node': {
        const parentTreeId = op.parent === null ? undefined : this.treeIdOf(op.parent)
        this.createSubtree(parentTreeId, op.index, op.node)
        break
      }
      case 'remove-node': {
        this.tree.delete(this.treeIdOf(op.id))
        break
      }
      case 'move-node': {
        const treeId = this.treeIdOf(op.id)
        const parentTreeId = op.parent === null ? undefined : this.treeIdOf(op.parent)
        this.tree.move(treeId, parentTreeId, op.index)
        break
      }
      case 'set-attr': {
        const attrs = this.nodeContainer(op.id, 'attrs')
        if (op.value === null) attrs.delete(op.key)
        else attrs.set(op.key, op.value)
        break
      }
      case 'set-style': {
        const map = op.state ? this.styleStateContainer(op.id, op.state) : this.nodeContainer(op.id, 'style')
        if (op.value === null) map.delete(op.prop)
        else map.set(op.prop, op.value)
        break
      }
      case 'set-style-ref': {
        this.treeNodeOf(op.id).data.set('styleRef', op.styleRef)
        break
      }
      case 'set-text': {
        this.treeNodeOf(op.id).data.set('text', op.text)
        break
      }
      case 'set-when': {
        this.treeNodeOf(op.id).data.set('when', op.when)
        break
      }
      case 'set-token': {
        if (op.value === null) this.tokens.delete(op.name)
        else this.tokens.set(op.name, op.value)
        break
      }
      case 'set-named-style': {
        this.namedStyles.set(op.style.name, stableStringify(op.style))
        break
      }
      case 'remove-named-style': {
        this.namedStyles.delete(op.name)
        break
      }
      case 'set-component': {
        this.components.set(op.component.name, stableStringify(op.component))
        break
      }
      case 'remove-component': {
        this.components.delete(op.name)
        break
      }
      case 'set-param': {
        this.params.set(op.param.name, stableStringify(op.param))
        break
      }
      case 'set-lookup': {
        this.lookups.set(op.lookup.name, stableStringify(op.lookup))
        break
      }
      case 'set-state': {
        this.states.set(op.state.name, stableStringify(op.state))
        break
      }
      case 'annotate': {
        this.annotations.set(op.annotation.id, stableStringify(op.annotation))
        break
      }
      case 'set-annotation-status': {
        const existing = this.annotations.get(op.id) as string | undefined
        if (!existing) throw new Error(`chain: unknown annotation ${op.id}`)
        const annotation = JSON.parse(existing) as FdnAnnotation
        annotation.status = op.status
        this.annotations.set(op.id, stableStringify(annotation))
        break
      }
      case 'remove-annotation': {
        this.annotations.delete(op.id)
        break
      }
      case 'replace-document': {
        this.replaceDocumentContent(op.doc)
        break
      }
    }
  }

  private nodeContainer(id: NodeId, key: 'attrs' | 'style'): LoroMap {
    return this.treeNodeOf(id).data.get(key) as LoroMap
  }

  private styleStateContainer(id: NodeId, state: StateStyleKey): LoroMap {
    const parent = this.treeNodeOf(id).data.get('styleStates') as LoroMap
    const existing = parent.get(state) as LoroMap | undefined
    return existing ?? parent.setContainer(state, new LoroMap())
  }

  private treeNodeOf(id: NodeId): LoroTreeNode {
    const node = this.tree.getNodeByID(this.treeIdOf(id))
    if (!node) throw new Error(`chain: unknown node ${id}`)
    return node
  }

  private treeIdOf(id: NodeId): TreeID {
    const treeId = this.idToTree.get(id)
    if (!treeId) throw new Error(`chain: unknown node ${id}`)
    return treeId
  }

  private createSubtree(parent: TreeID | undefined, index: number, fdn: FdnNode): void {
    const node = this.tree.createNode(parent, index)
    node.data.set('id', fdn.id)
    node.data.set('tag', fdn.tag)
    node.data.set('text', fdn.text ?? null)
    node.data.set('styleRef', fdn.styleRef ?? null)
    node.data.set('when', fdn.when ?? null)
    node.data.set('each', fdn.each ?? null)
    const attrs = node.data.setContainer('attrs', new LoroMap())
    for (const [k, v] of Object.entries(fdn.attrs)) attrs.set(k, v)
    const style = node.data.setContainer('style', new LoroMap())
    for (const [k, v] of Object.entries(fdn.style)) style.set(k, v)
    const styleStates = node.data.setContainer('styleStates', new LoroMap())
    for (const state of STATE_KEYS) {
      const plane = fdn.styleStates[state]
      if (plane && Object.keys(plane).length > 0) {
        const sub = styleStates.setContainer(state, new LoroMap())
        for (const [k, v] of Object.entries(plane)) sub.set(k, v)
      }
    }
    this.idToTree.set(fdn.id, node.id)
    fdn.children.forEach((child, i) => this.createSubtree(node.id, i, child))
  }

  private replaceDocumentContent(doc: FdnDocument): void {
    for (const root of this.tree.roots() ?? []) this.tree.delete(root.id)
    this.idToTree.clear()
    doc.body.forEach((n, i) => this.createSubtree(undefined, i, n))

    this.meta.set('specVersion', doc.specVersion)
    this.meta.set('title', doc.title ?? null)

    this.replaceScalarMap(this.tokens, doc.tokens)
    this.replaceKeyedMap(this.params, doc.params, (p) => p.name)
    this.replaceKeyedMap(this.data, doc.data, (d) => d.name)
    this.replaceKeyedMap(this.lookups, doc.lookups, (l) => l.name)
    this.replaceKeyedMap(this.states, doc.states, (s) => s.name)
    this.replaceKeyedMap(this.viewports, doc.viewports, (v) => v.name)
    this.replaceKeyedMap(this.namedStyles, doc.namedStyles, (s) => s.name)
    this.replaceKeyedMap(this.components, doc.components, (c) => c.name)
    this.replaceKeyedMap(this.annotations, doc.annotations, (a) => a.id)

    if (this.matrix.length > 0) this.matrix.delete(0, this.matrix.length)
    for (const m of doc.matrix) this.matrix.push(stableStringify(m))
  }

  private replaceScalarMap(map: LoroMap, record: Record<string, string>): void {
    for (const key of map.keys() as string[]) if (!(key in record)) map.delete(key)
    for (const [key, value] of Object.entries(record)) map.set(key, value)
  }

  private replaceKeyedMap<T>(map: LoroMap, items: T[], nameOf: (item: T) => string): void {
    const names = new Set(items.map(nameOf))
    for (const key of map.keys() as string[]) if (!names.has(key)) map.delete(key)
    for (const item of items) map.set(nameOf(item), stableStringify(item))
  }

  // ——— materialization ———

  private materialize(): FdnDocument {
    const roots = this.tree.roots() ?? []
    const body = roots.map((r) => this.materializeNode(r))
    const title = this.meta.get('title') as string | null | undefined
    return {
      specVersion: (this.meta.get('specVersion') as string | undefined) ?? '',
      ...(title != null ? { title } : {}),
      tokens: this.mapToRecord(this.tokens),
      params: this.mapValuesSorted<FdnParam>(this.params),
      data: this.mapValuesSorted<FdnDataSet>(this.data),
      lookups: this.mapValuesSorted<FdnLookup>(this.lookups),
      states: this.mapValuesSorted<FdnState>(this.states),
      viewports: this.mapValuesSorted<FdnViewport>(this.viewports),
      matrix: this.listValuesSorted(),
      namedStyles: this.mapValuesSorted<FdnNamedStyle>(this.namedStyles),
      components: this.mapValuesSorted<FdnComponent>(this.components),
      annotations: this.mapValuesSortedById<FdnAnnotation>(this.annotations),
      body,
    }
  }

  private materializeNode(node: LoroTreeNode): FdnNode {
    const data = node.data
    const id = data.get('id') as NodeId
    const tag = data.get('tag') as string
    const attrs = this.mapToRecord(data.get('attrs') as LoroMap)
    const style = this.mapToRecord(data.get('style') as LoroMap)
    const styleStates = this.materializeStyleStates(data.get('styleStates') as LoroMap)
    const styleRef = data.get('styleRef') as string | null
    const when = data.get('when') as string | null
    const each = data.get('each') as string | null
    const text = data.get('text') as string | null
    const children = (node.children() ?? []).map((c) => this.materializeNode(c))
    return {
      id,
      tag,
      attrs,
      style,
      styleStates,
      ...(styleRef != null ? { styleRef } : {}),
      ...(when != null ? { when } : {}),
      ...(each != null ? { each } : {}),
      ...(text != null ? { text } : {}),
      children,
    }
  }

  private materializeStyleStates(map: LoroMap): Partial<Record<StateStyleKey, Record<string, string>>> {
    const out: Partial<Record<StateStyleKey, Record<string, string>>> = {}
    for (const state of STATE_KEYS) {
      const sub = map.get(state) as LoroMap | undefined
      if (sub) out[state] = this.mapToRecord(sub)
    }
    return out
  }

  private mapToRecord(map: LoroMap): Record<string, string> {
    const out: Record<string, string> = {}
    for (const [k, v] of map.entries()) out[k] = v as string
    return out
  }

  private mapValuesSorted<T extends { name: string }>(map: LoroMap): T[] {
    const items: T[] = []
    for (const [, v] of map.entries()) items.push(JSON.parse(v as string) as T)
    return items.sort((a, b) => a.name.localeCompare(b.name))
  }

  /** Same as mapValuesSorted, keyed/sorted by `.id` instead of `.name` —
   *  annotations have no `.name` field (see FdnAnnotation, types.ts). */
  private mapValuesSortedById<T extends { id: string }>(map: LoroMap): T[] {
    const items: T[] = []
    for (const [, v] of map.entries()) items.push(JSON.parse(v as string) as T)
    return items.sort((a, b) => a.id.localeCompare(b.id))
  }

  private listValuesSorted(): { state: string; viewport: string }[] {
    const items = (this.matrix.toArray() as string[]).map((s) => JSON.parse(s) as { state: string; viewport: string })
    return items.sort((a, b) => a.state.localeCompare(b.state) || a.viewport.localeCompare(b.viewport))
  }

  private rebuildIndex(): void {
    this.idToTree.clear()
    for (const node of this.tree.nodes()) {
      const id = node.data.get('id') as NodeId | undefined
      if (id === undefined) continue
      this.idToTree.set(id, node.id)
    }
  }
}
