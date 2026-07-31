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
