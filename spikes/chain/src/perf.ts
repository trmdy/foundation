/**
 * S1 perf secondary: 10k sequential changes (mixed verbs, including 1k
 * subtree moves) on a ~500-node tree. Measures per-op append latency
 * (p50/p95), save() byte size, load() time, and RSS delta. No benchmarking
 * framework — just Date-free, deterministic timing with `performance.now()`
 * (wall-clock timing itself is fine; it's document *content* that must never
 * depend on Date.now()/Math.random(), see util.ts).
 *
 * Simplification (documented, not hidden): to keep the op generator itself
 * simple and independent of each library's cycle/validity semantics (already
 * exercised by the gauntlet), moves and removes here only ever target LEAF
 * nodes, and inserts only ever create new leaves. The ~30 "internal" nodes
 * from the base fixture are never relocated or removed, only ever edited via
 * setProp/setStyle/setText — this still genuinely exercises 1,000 real
 * tree-move ops and 500 insert/remove ops against library state at ~500
 * nodes, which is what S1 is measuring (raw op cost at scale), not move
 * semantics under conflict (the gauntlet's job).
 */

import type { ChainAdapter, ChangeMeta, FdnNode, NodeId } from './contract.js'
import { LIBRARIES, type LibraryName } from './gauntlet.js'
import { buildBigTree } from './fixtures.js'
import { mulberry32, percentile } from './util.js'

const TARGET_NODE_COUNT = 500
const TOTAL_OPS = 10_000
const MOVE_OPS = 1_000
const INSERT_OPS = 500
const REMOVE_OPS = 500
const SET_PROP_OPS = 2_667
const SET_STYLE_OPS = 2_666
const SET_TEXT_OPS = TOTAL_OPS - MOVE_OPS - INSERT_OPS - REMOVE_OPS - SET_PROP_OPS - SET_STYLE_OPS

type OpKind = 'move' | 'insert' | 'remove' | 'setProp' | 'setStyle' | 'setText'

export interface PerfResult {
  library: LibraryName
  startNodeCount: number
  totalOps: number
  actualOpCounts: Record<OpKind, number>
  appendLatencyMsP50: number
  appendLatencyMsP95: number
  appendLatencyMsMean: number
  totalAppendMs: number
  saveBytes: number
  saveMs: number
  loadMs: number
  rssDeltaBytesDuringOps: number
  rssDeltaBytesAfterSave: number
}

/** O(1) add/remove/random-pick pool over node ids, order-independent. */
class Pool {
  private items: NodeId[] = []
  private indexOf = new Map<NodeId, number>()

  add(id: NodeId): void {
    if (this.indexOf.has(id)) return
    this.indexOf.set(id, this.items.length)
    this.items.push(id)
  }

  remove(id: NodeId): void {
    const idx = this.indexOf.get(id)
    if (idx === undefined) return
    const last = this.items[this.items.length - 1] as NodeId
    this.items[idx] = last
    this.indexOf.set(last, idx)
    this.items.pop()
    this.indexOf.delete(id)
  }

  pick(rand: () => number): NodeId | undefined {
    if (this.items.length === 0) return undefined
    const idx = Math.floor(rand() * this.items.length)
    return this.items[idx]
  }

  get size(): number {
    return this.items.length
  }
}

function buildOpSequence(rand: () => number): OpKind[] {
  const seq: OpKind[] = [
    ...Array(MOVE_OPS).fill('move' as const),
    ...Array(INSERT_OPS).fill('insert' as const),
    ...Array(REMOVE_OPS).fill('remove' as const),
    ...Array(SET_PROP_OPS).fill('setProp' as const),
    ...Array(SET_STYLE_OPS).fill('setStyle' as const),
    ...Array(SET_TEXT_OPS).fill('setText' as const),
  ]
  // Fisher-Yates, seeded — deterministic across runs.
  for (let i = seq.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    const tmp = seq[i] as OpKind
    seq[i] = seq[j] as OpKind
    seq[j] = tmp
  }
  return seq
}

function rss(): number {
  return process.memoryUsage().rss
}

function maybeGc(): void {
  // Only available when node is run with --expose-gc; best-effort.
  const g = globalThis as unknown as { gc?: () => void }
  g.gc?.()
}

export function runPerfSuite(): PerfResult[] {
  return LIBRARIES.map(({ name, make }) => runPerf(name, make))
}

function runPerf(library: LibraryName, make: () => ChainAdapter): PerfResult {
  const baseTree = buildBigTree(TARGET_NODE_COUNT, 'p')
  const adapter = make()
  adapter.init(baseTree)

  // Build the mutable-tree tracker (see file header for why this is
  // deliberately simpler than full move/remove semantics).
  const internalPool = new Pool()
  const leafPool = new Pool()
  const allPool = new Pool()
  const parentOf = new Map<NodeId, NodeId>()
  const childCountOf = new Map<NodeId, number>()

  const walk = (n: FdnNode, parent: NodeId | undefined): void => {
    allPool.add(n.id)
    if (parent !== undefined) parentOf.set(n.id, parent)
    if (n.children.length > 0) {
      internalPool.add(n.id)
      childCountOf.set(n.id, n.children.length)
    } else {
      leafPool.add(n.id)
    }
    n.children.forEach((c) => walk(c, n.id))
  }
  walk(baseTree, undefined)

  const rand = mulberry32(42)
  const sequence = buildOpSequence(rand)
  const latencies: number[] = []
  const actualOpCounts: Record<OpKind, number> = {
    move: 0,
    insert: 0,
    remove: 0,
    setProp: 0,
    setStyle: 0,
    setText: 0,
  }
  let insertCounter = 0
  const meta: ChangeMeta = { author: 'agent:perf', message: 'perf op' }

  const rssBefore = (maybeGc(), rss())

  for (const requested of sequence) {
    let kind: OpKind = requested
    if (kind === 'remove' && leafPool.size === 0) kind = 'setProp'
    if (kind === 'move' && (leafPool.size === 0 || internalPool.size === 0)) kind = 'setProp'

    const t0 = performance.now()
    switch (kind) {
      case 'insert': {
        const parent = (internalPool.pick(rand) ?? baseTree.id) as NodeId
        const id = `ins-${insertCounter++}`
        const index = childCountOf.get(parent) ?? 0
        adapter.insertNode(meta, parent, index, { id, tag: 'div', props: { gen: 'perf' }, styles: {}, children: [] })
        childCountOf.set(parent, index + 1)
        parentOf.set(id, parent)
        leafPool.add(id)
        allPool.add(id)
        break
      }
      case 'remove': {
        const id = leafPool.pick(rand) as NodeId
        const parent = parentOf.get(id) as NodeId
        adapter.removeNode(meta, id)
        childCountOf.set(parent, (childCountOf.get(parent) ?? 1) - 1)
        leafPool.remove(id)
        allPool.remove(id)
        parentOf.delete(id)
        break
      }
      case 'move': {
        const id = leafPool.pick(rand) as NodeId
        const newParent = internalPool.pick(rand) as NodeId
        const oldParent = parentOf.get(id) as NodeId
        const newParentCount = childCountOf.get(newParent) ?? 0
        // If we're moving within the same parent, the node's own removal
        // from that list happens first, so the max valid append index is
        // count - 1, not count.
        const index = newParent === oldParent ? Math.max(0, newParentCount - 1) : newParentCount
        adapter.moveNode(meta, id, newParent, index)
        if (newParent !== oldParent) {
          childCountOf.set(oldParent, (childCountOf.get(oldParent) ?? 1) - 1)
          childCountOf.set(newParent, newParentCount + 1)
        }
        parentOf.set(id, newParent)
        break
      }
      case 'setProp': {
        const id = allPool.pick(rand) as NodeId
        adapter.setProp(meta, id, 'perfKey', `v${insertCounter}`)
        break
      }
      case 'setStyle': {
        const id = allPool.pick(rand) as NodeId
        adapter.setStyle(meta, id, 'perfStyle', `s${insertCounter}`)
        break
      }
      case 'setText': {
        const id = allPool.pick(rand) as NodeId
        adapter.setText(meta, id, `text-${insertCounter}`)
        break
      }
    }
    const t1 = performance.now()
    latencies.push(t1 - t0)
    actualOpCounts[kind] += 1
  }

  const rssAfterOps = (maybeGc(), rss())

  const sorted = [...latencies].sort((a, b) => a - b)
  const totalAppendMs = latencies.reduce((s, v) => s + v, 0)

  const saveStart = performance.now()
  const bytes = adapter.save()
  const saveMs = performance.now() - saveStart

  const rssAfterSave = (maybeGc(), rss())

  const loaded = make()
  const loadStart = performance.now()
  loaded.load(bytes)
  const loadMs = performance.now() - loadStart

  return {
    library,
    startNodeCount: TARGET_NODE_COUNT,
    totalOps: TOTAL_OPS,
    actualOpCounts,
    appendLatencyMsP50: percentile(sorted, 50),
    appendLatencyMsP95: percentile(sorted, 95),
    appendLatencyMsMean: totalAppendMs / latencies.length,
    totalAppendMs,
    saveBytes: bytes.byteLength,
    saveMs,
    loadMs,
    rssDeltaBytesDuringOps: rssAfterOps - rssBefore,
    rssDeltaBytesAfterSave: rssAfterSave - rssBefore,
  }
}
