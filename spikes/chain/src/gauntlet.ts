/**
 * The concurrency gauntlet (README G1–G5): three offline authors fork from a
 * common ~30-node base tree, apply conflicting ops, merge all-pairs to
 * convergence, then check the disqualifiers (duplication, cycles, silently
 * lost edits, divergence) using the invariant checkers from contract.ts.
 *
 * A scenario "failing" is DATA, not a thrown test failure: every scenario
 * runs inside a try/catch and any exception (including a thrown
 * TreeInvariantError) becomes a violation verdict with the exception message
 * as details, rather than crashing the run.
 */

import type { ChainAdapter, ChangeMeta, FdnNode, NodeId } from './contract.js'
import { assertValidTree, canonical, collectIds } from './contract.js'
import { LoroAdapter } from './loro.js'
import { AutomergeAdapter } from './automerge.js'
import { buildBaseTree } from './fixtures.js'

export type LibraryName = 'loro' | 'automerge'

export interface Verdict {
  scenario: string
  library: LibraryName
  result: 'pass' | 'violation'
  details: string
}

interface Peers {
  a: ChainAdapter
  b: ChainAdapter
  c: ChainAdapter
}

type Factory = () => ChainAdapter

export const LIBRARIES: { name: LibraryName; make: Factory }[] = [
  { name: 'loro', make: () => new LoroAdapter() },
  { name: 'automerge', make: () => new AutomergeAdapter() },
]

function meta(author: string, message: string): ChangeMeta {
  return { author, message }
}

export function findNode(root: FdnNode, id: NodeId): FdnNode | undefined {
  if (root.id === id) return root
  for (const c of root.children) {
    const found = findNode(c, id)
    if (found) return found
  }
  return undefined
}

function parentOf(root: FdnNode, id: NodeId): FdnNode | undefined {
  for (const c of root.children) {
    if (c.id === id) return root
    const found = parentOf(c, id)
    if (found) return found
  }
  return undefined
}

/** Two full all-pairs rounds guarantee convergence regardless of merge order. */
function convergeAllPairs(peers: ChainAdapter[]): void {
  for (let round = 0; round < 2; round++) {
    for (const a of peers) {
      for (const b of peers) {
        if (a !== b) a.merge(b)
      }
    }
  }
}

interface ScenarioCheckResult {
  ok: boolean
  details: string
}

interface Scenario {
  name: string
  setup: (peers: Peers) => void
  check: (peers: Peers) => ScenarioCheckResult
}

function newLeaf(id: NodeId, tag: string): FdnNode {
  return { id, tag, props: {}, styles: {}, children: [] }
}

const scenarios: Scenario[] = [
  {
    name: 'G1 move-vs-move',
    setup: ({ a, b }) => {
      // Both A and B move the same node (a child of n-header) under a
      // different new parent, concurrently.
      a.moveNode(meta('agent:a', 'move to main'), 'n-header-c0', 'n-main', 0)
      b.moveNode(meta('agent:b', 'move to footer'), 'n-header-c0', 'n-footer', 0)
    },
    check: ({ a }) => {
      const root = a.materialize()
      const ids = collectIds(root)
      if (!ids.has('n-header-c0') || !ids.has('n-header-c0-text')) {
        return { ok: false, details: 'moved node or its child vanished after merge' }
      }
      const parent = parentOf(root, 'n-header-c0')
      const parentId = parent?.id
      if (parentId !== 'n-main' && parentId !== 'n-footer') {
        return { ok: false, details: `moved node ended up under unexpected parent ${parentId ?? '(none)'}` }
      }
      return { ok: true, details: `converged with n-header-c0 under ${parentId} (exactly one winner, no duplication)` }
    },
  },
  {
    name: 'G2 edit-inside-moved-subtree',
    setup: ({ a, b }) => {
      a.moveNode(meta('agent:a', 'move aside under header'), 'n-aside', 'n-header', 0)
      b.setProp(meta('agent:b', 'edit inside moved subtree'), 'n-aside-c1', 'class', 'edited')
    },
    check: ({ a }) => {
      const root = a.materialize()
      const parent = parentOf(root, 'n-aside')
      if (parent?.id !== 'n-header') {
        return { ok: false, details: `move was lost: n-aside parent is ${parent?.id ?? '(missing)'}, expected n-header` }
      }
      const edited = findNode(root, 'n-aside-c1')
      if (!edited) return { ok: false, details: 'n-aside-c1 vanished after merge (edit target lost)' }
      if (edited.props.class !== 'edited') {
        return { ok: false, details: `edit inside moved subtree was lost: class=${edited.props.class ?? '(unset)'}` }
      }
      return { ok: true, details: 'move and concurrent edit inside the moved subtree both survived the merge' }
    },
  },
  {
    name: 'G3 delete-vs-edit',
    setup: ({ a, b }) => {
      a.removeNode(meta('agent:a', 'delete footer subtree'), 'n-footer')
      b.setProp(meta('agent:b', 'edit node inside deleted subtree'), 'n-footer-c2', 'class', 'ghost-edit')
    },
    check: ({ a }) => {
      const root = a.materialize()
      const ids = collectIds(root)
      const deleted = !ids.has('n-footer')
      if (deleted) {
        return { ok: true, details: 'delete-wins: subtree removed, concurrent edit inside it deterministically superseded (not a silent loss — same outcome on every converged peer)' }
      }
      const edited = findNode(root, 'n-footer-c2')
      if (edited && edited.props.class === 'ghost-edit') {
        return { ok: true, details: 'edit-wins: subtree survived with the concurrent edit applied' }
      }
      return { ok: false, details: 'inconsistent outcome: subtree survived but the concurrent edit was neither applied nor cleanly superseded' }
    },
  },
  {
    name: 'G4 reorder-vs-insert',
    setup: ({ a, b }) => {
      a.moveNode(meta('agent:a', 'reorder: c2 to front'), 'n-main-c2', 'n-main', 0)
      b.insertNode(meta('agent:b', 'insert new sibling'), 'n-main', 1, newLeaf('g4-new', 'div'))
    },
    check: ({ a }) => {
      const root = a.materialize()
      const main = findNode(root, 'n-main')
      if (!main) return { ok: false, details: 'n-main vanished after merge' }
      const childIds = main.children.map((c) => c.id)
      const expected = ['n-main-c0', 'n-main-c1', 'n-main-c2', 'g4-new']
      const missing = expected.filter((id) => !childIds.includes(id))
      if (missing.length > 0) {
        return { ok: false, details: `missing children under n-main after merge: ${missing.join(', ')} (have: ${childIds.join(', ')})` }
      }
      if (new Set(childIds).size !== childIds.length) {
        return { ok: false, details: `duplicated children under n-main: ${childIds.join(', ')}` }
      }
      return { ok: true, details: `n-main children after merge: [${childIds.join(', ')}] — reorder and insert both present, no loss/duplication` }
    },
  },
  {
    name: 'G5 move-cycle',
    setup: ({ a, b }) => {
      // Siblings under n-main; neither is an ancestor of the other at fork
      // time, so each move is individually valid — the cycle only appears
      // once both concurrent moves are merged together.
      a.moveNode(meta('agent:a', 'move c0 under c1'), 'n-main-c0', 'n-main-c1', 0)
      b.moveNode(meta('agent:b', 'move c1 under c0'), 'n-main-c1', 'n-main-c0', 0)
    },
    check: ({ a }) => {
      const root = a.materialize()
      const ids = collectIds(root)
      const hasX = ids.has('n-main-c0')
      const hasY = ids.has('n-main-c1')
      if (!hasX || !hasY) {
        return {
          ok: false,
          details: `cycle fallout: ${!hasX ? 'n-main-c0' : 'n-main-c1'} is unreachable from root after merge (orphaned by an undetected cycle)`,
        }
      }
      const xParent = parentOf(root, 'n-main-c0')?.id
      const yParent = parentOf(root, 'n-main-c1')?.id
      return {
        ok: true,
        details: `both nodes remain reachable from root after merge (x parent=${xParent}, y parent=${yParent}) — no cycle-induced loss`,
      }
    },
  },
]

export function runGauntlet(): Verdict[] {
  const verdicts: Verdict[] = []
  for (const { name: library, make } of LIBRARIES) {
    for (const scenario of scenarios) {
      verdicts.push(runScenario(scenario, library, make))
    }
  }
  return verdicts
}

function runScenario(scenario: Scenario, library: LibraryName, make: Factory): Verdict {
  try {
    const base = make()
    base.init(buildBaseTree())
    const a = base.fork('author-a')
    const b = base.fork('author-b')
    const c = base.fork('author-c')

    scenario.setup({ a, b, c })
    // A third, unrelated concurrent author, per the "three offline authors" protocol.
    c.setProp(meta('user:c', 'benign unrelated edit'), 'n-title', 'data-touched', '1')

    convergeAllPairs([a, b, c])

    for (const peer of [a, b, c]) {
      assertValidTree(peer.materialize())
    }

    const [ca, cb, cc] = [a, b, c].map((p) => canonical(p.materialize()))
    if (ca !== cb || cb !== cc) {
      return { scenario: scenario.name, library, result: 'violation', details: 'divergent state across converged peers' }
    }

    const outcome = scenario.check({ a, b, c })
    return {
      scenario: scenario.name,
      library,
      result: outcome.ok ? 'pass' : 'violation',
      details: outcome.details,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { scenario: scenario.name, library, result: 'violation', details: `threw: ${message}` }
  }
}
