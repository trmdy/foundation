/**
 * Harness correctness tests (per README): these assert that both adapters
 * conform to the ChainAdapter contract on non-conflicting, single-author
 * sequences. They must pass for BOTH libraries — a failure here means the
 * adapter is broken, not that the library "lost" the gauntlet. Gauntlet
 * scenario results (conflicts, merges) are recorded as data by gauntlet.ts,
 * not asserted here.
 */

import { describe, expect, it } from 'vitest'
import type { ChainAdapter, FdnNode } from './contract.js'
import { canonical, assertValidTree, collectIds } from './contract.js'
import { LoroAdapter } from './loro.js'
import { AutomergeAdapter } from './automerge.js'
import { buildBaseTree } from './fixtures.js'
import { refInsertNode, refMoveNode, refRemoveNode, refSetProp, refSetStyle, refSetText } from './reference.js'

const adapters: { name: string; make: () => ChainAdapter }[] = [
  { name: 'loro', make: () => new LoroAdapter() },
  { name: 'automerge', make: () => new AutomergeAdapter() },
]

const author = { author: 'user:test', message: 'op' }

describe.each(adapters)('$name adapter — harness correctness', ({ make }) => {
  it('materializes the base tree unchanged right after init', () => {
    const base = buildBaseTree()
    const adapter = make()
    adapter.init(base)
    expect(canonical(adapter.materialize())).toBe(canonical(base))
  })

  it('matches a plain-JS reference model over a mixed single-author sequence', () => {
    const base = buildBaseTree()
    const adapter = make()
    adapter.init(base)
    let ref: FdnNode = base

    adapter.insertNode(author, 'n-body', 0, { id: 'new-1', tag: 'div', props: { class: 'x' }, styles: {}, children: [] })
    ref = refInsertNode(ref, 'n-body', 0, { id: 'new-1', tag: 'div', props: { class: 'x' }, styles: {}, children: [] })

    adapter.setProp(author, 'new-1', 'class', 'y')
    ref = refSetProp(ref, 'new-1', 'class', 'y')

    adapter.setStyle(author, 'new-1', 'color', 'red')
    ref = refSetStyle(ref, 'new-1', 'color', 'red')

    adapter.moveNode(author, 'new-1', 'n-header', 1)
    ref = refMoveNode(ref, 'new-1', 'n-header', 1)

    adapter.setText(author, 'n-title-text', 'Updated title')
    ref = refSetText(ref, 'n-title-text', 'Updated title')

    adapter.removeNode(author, 'n-aside')
    ref = refRemoveNode(ref, 'n-aside')

    const materialized = adapter.materialize()
    assertValidTree(materialized)
    expect(canonical(materialized)).toBe(canonical(ref))
  })

  it('anchors + checkout round-trip without disturbing live state', () => {
    const base = buildBaseTree()
    const adapter = make()
    adapter.init(base)
    const beforeAnchor = adapter.anchor('before')

    adapter.setProp(author, 'n-root', 'lang', 'no')
    adapter.insertNode(author, 'n-body', 0, { id: 'new-2', tag: 'div', props: {}, styles: {}, children: [] })

    const afterAnchor = adapter.anchor('after')
    const liveBefore = canonical(adapter.materialize())

    const checkedOutBefore = adapter.checkout(beforeAnchor)
    expect(canonical(checkedOutBefore)).toBe(canonical(base))

    // checkout must not disturb live state
    expect(canonical(adapter.materialize())).toBe(liveBefore)

    const checkedOutAfter = adapter.checkout(afterAnchor)
    expect(canonical(checkedOutAfter)).toBe(liveBefore)
  })

  it('collectIds after remove reflects the removed subtree', () => {
    const base = buildBaseTree()
    const adapter = make()
    adapter.init(base)
    const beforeIds = collectIds(base)
    expect(beforeIds.has('n-aside')).toBe(true)
    expect(beforeIds.has('n-aside-c0')).toBe(true)

    adapter.removeNode(author, 'n-aside')
    const afterIds = collectIds(adapter.materialize())
    expect(afterIds.has('n-aside')).toBe(false)
    expect(afterIds.has('n-aside-c0')).toBe(false)
    expect(afterIds.has('n-header')).toBe(true)
  })

  it('history() round-trips author + message metadata for local changes', () => {
    const adapter = make()
    adapter.init(buildBaseTree())
    adapter.setProp({ author: 'agent:bee-1', message: 'set lang' }, 'n-root', 'lang', 'fr')
    adapter.setStyle({ author: 'user:alice', message: 'style body' }, 'n-body', 'margin', '8px')

    const history = adapter.history()
    expect(history.length).toBeGreaterThanOrEqual(3) // init + 2 verbs
    const authors = history.map((h) => h.meta.author)
    expect(authors).toContain('agent:bee-1')
    expect(authors).toContain('user:alice')
    const messages = history.map((h) => h.meta.message)
    expect(messages).toContain('set lang')
    expect(messages).toContain('style body')
    // nativeId should be present and unique per change
    const nativeIds = new Set(history.map((h) => h.nativeId))
    expect(nativeIds.size).toBe(history.length)
  })

  it('undo reverses the last local change, including undo of a move', () => {
    const adapter = make()
    adapter.init(buildBaseTree())

    adapter.moveNode(author, 'n-aside', 'n-header', 0)
    const movedCanonical = canonical(adapter.materialize())
    expect(movedCanonical).not.toBe(canonical(buildBaseTree()))

    adapter.undo({ author: 'user:test', message: 'undo move' })
    expect(canonical(adapter.materialize())).toBe(canonical(buildBaseTree()))
  })

  it('save/load round-trips to an identical materialization', () => {
    const adapter = make()
    adapter.init(buildBaseTree())
    adapter.setProp(author, 'n-root', 'lang', 'de')
    adapter.insertNode(author, 'n-body', 1, { id: 'new-3', tag: 'div', props: {}, styles: {}, children: [] })

    const before = canonical(adapter.materialize())
    const bytes = adapter.save()

    const reloaded = make()
    reloaded.load(bytes)
    expect(canonical(reloaded.materialize())).toBe(before)
  })

  it('diff between two anchors lifts to the semantic op vocabulary', () => {
    const adapter = make()
    adapter.init(buildBaseTree())
    const a = adapter.anchor('a')
    adapter.setProp(author, 'n-root', 'lang', 'sv')
    adapter.insertNode(author, 'n-body', 0, { id: 'new-4', tag: 'div', props: {}, styles: {}, children: [] })
    const b = adapter.anchor('b')

    const ops = adapter.diff(a, b)
    expect(ops.some((o) => o.op === 'set-prop' && o.id === 'n-root' && o.key === 'lang' && o.value === 'sv')).toBe(
      true,
    )
    expect(ops.some((o) => o.op === 'insert-node' && o.id === 'new-4' && o.parent === 'n-body')).toBe(true)
  })
})
