import { describe, expect, it } from 'vitest'
import { createChain, loadChain } from '../src/chain/index.js'
import { baseDocument, el } from './chain-fixtures.js'
import type { ChangeMeta } from '../src/types.js'

const AUTHOR: ChangeMeta = { author: 'user:tormod', message: 'seed' }
const M = (message: string): ChangeMeta => ({ author: 'user:tormod', message })

describe('chain save/load — full roundtrip', () => {
  it('preserves the materialized document', () => {
    const chain = createChain(baseDocument(), AUTHOR)
    chain.apply(M('edit'), [
      { op: 'insert-node', parent: 'n-root', index: 0, node: el('n-new', 'i') },
      { op: 'set-token', name: 'extra', value: '1' },
    ])
    const bytes = chain.save()
    const reloaded = loadChain(bytes)
    expect(reloaded.doc()).toEqual(chain.doc())
  })

  it('preserves the envelope log (author/message/specVersion/hash chain)', () => {
    const chain = createChain(baseDocument(), AUTHOR)
    chain.apply(M('one'), [{ op: 'set-token', name: 't1', value: '1' }])
    chain.apply(M('two'), [{ op: 'set-token', name: 't2', value: '2' }])
    const bytes = chain.save()
    const reloaded = loadChain(bytes)
    expect(reloaded.log()).toEqual(chain.log())
    expect(reloaded.head()).toEqual(chain.head())
    expect(reloaded.verify()).toEqual({ ok: true })
  })

  it('preserves anchor names and lets checkout() resolve them after reload', () => {
    const chain = createChain(baseDocument(), AUTHOR)
    chain.anchor('genesis')
    chain.apply(M('edit'), [{ op: 'set-token', name: 't', value: '1' }])
    chain.anchor('after-edit')
    const bytes = chain.save()
    const reloaded = loadChain(bytes)
    expect(reloaded.checkout('genesis').tokens.t).toBeUndefined()
    expect(reloaded.checkout('after-edit').tokens.t).toBe('1')
  })

  it('a reloaded chain can keep being edited and diverges independently', () => {
    const chain = createChain(baseDocument(), AUTHOR)
    chain.apply(M('one'), [{ op: 'set-token', name: 't1', value: '1' }])
    const bytes = chain.save()
    const reloaded = loadChain(bytes)
    reloaded.apply(M('two on reloaded'), [{ op: 'set-token', name: 't2', value: '2' }])
    expect(reloaded.doc().tokens.t2).toBe('2')
    expect(chain.doc().tokens.t2).toBeUndefined()
    expect(reloaded.verify()).toEqual({ ok: true })
  })

  it('round-trips a document exercising every FdnDocument section', () => {
    const doc = baseDocument()
    const chain = createChain(doc, AUTHOR)
    const bytes = chain.save()
    const reloaded = loadChain(bytes)
    const materialized = reloaded.doc()
    expect(materialized.tokens).toEqual(doc.tokens)
    expect(materialized.params).toEqual(doc.params)
    expect(materialized.data).toEqual(doc.data)
    expect(materialized.lookups).toEqual(doc.lookups)
    expect(materialized.states).toEqual(doc.states)
    expect(materialized.viewports).toEqual(doc.viewports)
    expect(materialized.matrix).toEqual(doc.matrix)
    expect(materialized.namedStyles).toEqual(doc.namedStyles)
    expect(materialized.components).toEqual(doc.components)
    expect(materialized.body).toEqual(doc.body)
    expect(materialized.specVersion).toBe(doc.specVersion)
    expect(materialized.title).toBe(doc.title)
  })
})

describe('chain save/load — loadChain actor (contract amendment 2026-07-31)', () => {
  it('two loads of the same snapshot with NO actor derive the same peer id, and silently fail to converge on merge', () => {
    // This is the collision the module's original findings flagged: without
    // an explicit actor, loadChain derives the peer id from a hash of the
    // snapshot bytes, so two independent loads of the SAME bytes get the
    // SAME peer id. Each then makes a local edit — both edits land at the
    // identical (peer, counter) op id. When merged, each side sees the
    // other's op as one it "already has" (same id) and drops it: the merge
    // does not throw, it just silently fails to converge.
    const original = createChain(baseDocument(), AUTHOR)
    const bytes = original.save()

    const loadA = loadChain(bytes)
    const loadB = loadChain(bytes)
    loadA.apply(M('edit from A'), [{ op: 'set-attr', id: 'n-child-2', key: 'from', value: 'A' }])
    loadB.apply({ author: 'user:other', message: 'edit from B' }, [{ op: 'set-attr', id: 'n-child-2', key: 'from', value: 'B' }])

    loadA.merge(loadB)
    loadB.merge(loadA)

    // proof of the collision: they do NOT converge, each only sees its own edit.
    expect(loadA.doc().body[0]?.children[1]?.attrs.from).toBe('A')
    expect(loadB.doc().body[0]?.children[1]?.attrs.from).toBe('B')
    expect(loadA.doc()).not.toEqual(loadB.doc())
  })

  it('two loads of the same snapshot with DISTINCT explicit actors converge cleanly on merge', () => {
    const original = createChain(baseDocument(), AUTHOR)
    const bytes = original.save()

    const loadC = loadChain(bytes, { actor: 'user:c' })
    const loadD = loadChain(bytes, { actor: 'user:d' })
    loadC.apply({ author: 'user:c', message: 'edit from C' }, [{ op: 'set-attr', id: 'n-child-2', key: 'from', value: 'C' }])
    loadD.apply({ author: 'user:d', message: 'edit from D' }, [{ op: 'set-attr', id: 'n-child-2', key: 'from', value: 'D' }])

    loadC.merge(loadD)
    loadD.merge(loadC)

    // converges: both peers land on the identical (canonically-equal) document.
    expect(loadC.doc()).toEqual(loadD.doc())
    expect(loadC.verify()).toEqual({ ok: true })
    expect(loadD.verify()).toEqual({ ok: true })
    // and both authors' envelopes are present in both logs.
    expect(loadC.log().some((r) => r.author === 'user:c')).toBe(true)
    expect(loadC.log().some((r) => r.author === 'user:d')).toBe(true)
    expect(loadC.log()).toEqual(loadD.log())
  })

  it('an explicit actor on loadChain also lets the loaded chain merge cleanly with the chain it was saved from', () => {
    const original = createChain(baseDocument(), AUTHOR)
    const bytes = original.save()
    const loaded = loadChain(bytes, { actor: 'user:loaded' })

    original.apply(M('original continues'), [{ op: 'set-token', name: 'from-original', value: '1' }])
    loaded.apply({ author: 'user:loaded', message: 'loaded continues' }, [{ op: 'set-token', name: 'from-loaded', value: '1' }])

    original.merge(loaded)
    loaded.merge(original)
    expect(original.doc()).toEqual(loaded.doc())
    expect(original.doc().tokens['from-original']).toBe('1')
    expect(original.doc().tokens['from-loaded']).toBe('1')
  })
})
