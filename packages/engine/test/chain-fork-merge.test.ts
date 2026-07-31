import { describe, expect, it } from 'vitest'
import { createChain } from '../src/chain/index.js'
import { baseDocument, el } from './chain-fixtures.js'
import type { ChangeMeta } from '../src/types.js'

const AUTHOR: ChangeMeta = { author: 'user:tormod', message: 'seed' }
const M = (author: string, message: string): ChangeMeta => ({ author, message })

describe('chain fork/merge', () => {
  it('fork() produces an independent chain that starts with the same materialized document', () => {
    const a = createChain(baseDocument(), AUTHOR)
    const b = a.fork('user:b')
    expect(b.doc()).toEqual(a.doc())

    a.apply(M('user:a', 'a-only'), [{ op: 'set-token', name: 'a-token', value: '1' }])
    b.apply(M('user:b', 'b-only'), [{ op: 'set-token', name: 'b-token', value: '1' }])
    // independent: neither sees the other's change yet
    expect(a.doc().tokens['b-token']).toBeUndefined()
    expect(b.doc().tokens['a-token']).toBeUndefined()
  })

  it('merging both ways converges to canonically-equal documents', () => {
    const a = createChain(baseDocument(), AUTHOR)
    const b = a.fork('user:b')

    a.apply(M('user:a', 'insert on a'), [{ op: 'insert-node', parent: 'n-root', index: 0, node: el('n-from-a', 'i') }])
    b.apply(M('user:b', 'insert on b'), [{ op: 'insert-node', parent: 'n-root', index: 0, node: el('n-from-b', 'em') }])
    a.apply(M('user:a', 'token on a'), [{ op: 'set-token', name: 'from-a', value: '1' }])
    b.apply(M('user:b', 'token on b'), [{ op: 'set-token', name: 'from-b', value: '1' }])

    a.merge(b)
    b.merge(a)

    const docA = a.doc()
    const docB = b.doc()
    expect(docA).toEqual(docB)
    expect(docA.tokens['from-a']).toBe('1')
    expect(docA.tokens['from-b']).toBe('1')
    const ids = docA.body[0]?.children.map((n) => n.id) ?? []
    expect(ids).toContain('n-from-a')
    expect(ids).toContain('n-from-b')
  })

  it('after merging both ways, log() contains both authors envelope records, and both peers report the same log', () => {
    const a = createChain(baseDocument(), M('user:a', 'seed'))
    const b = a.fork('user:b')

    a.apply(M('user:a', 'change from a'), [{ op: 'set-token', name: 'ta', value: '1' }])
    b.apply(M('user:b', 'change from b'), [{ op: 'set-token', name: 'tb', value: '1' }])

    a.merge(b)
    b.merge(a)

    const logA = a.log()
    const logB = b.log()
    expect(logA).toEqual(logB)
    expect(logA.some((r) => r.author === 'user:a' && r.message === 'change from a')).toBe(true)
    expect(logA.some((r) => r.author === 'user:b' && r.message === 'change from b')).toBe(true)
    expect(a.verify()).toEqual({ ok: true })
    expect(b.verify()).toEqual({ ok: true })
  })

  it('merge() into an unmerged chain converges after a single one-directional import (from-scratch B)', () => {
    const a = createChain(baseDocument(), AUTHOR)
    a.apply(M('user:a', 'change 1'), [{ op: 'set-token', name: 't1', value: '1' }])
    const b = a.fork('user:b')
    a.apply(M('user:a', 'change 2'), [{ op: 'set-token', name: 't2', value: '2' }])
    b.merge(a)
    expect(b.doc()).toEqual(a.doc())
  })

  it('undo after merge reverts only the local peer change, the merged-in remote change survives', () => {
    const a = createChain(baseDocument(), AUTHOR)
    const b = a.fork('user:b')

    a.apply(M('user:a', "a's local edit"), [{ op: 'set-token', name: 'lang', value: 'en' }])
    b.apply(M('user:b', "b's edit"), [{ op: 'set-token', name: 'region', value: 'no' }])

    a.merge(b)
    // a's last LOCAL change is still "a's local edit" — merge() must not
    // have touched lastLocalChange.
    a.undo(M('user:a', 'undo'))

    const doc = a.doc()
    expect(doc.tokens.lang).toBeUndefined()
    expect(doc.tokens.region).toBe('no')
  })
})
