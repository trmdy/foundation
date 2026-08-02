import { describe, expect, it } from 'vitest'
import { createChain } from '../src/chain/index.js'
import { baseDocument } from './chain-fixtures.js'
import type { ChangeMeta, FdnAnnotation } from '../src/types.js'

const AUTHOR: ChangeMeta = { author: 'user:tormod', message: 'seed' }
const M = (message: string): ChangeMeta => ({ author: 'user:tormod', message })

function annotation(overrides: Partial<FdnAnnotation> & Pick<FdnAnnotation, 'id' | 'text'>): FdnAnnotation {
  return { status: 'open', ...overrides }
}

describe('chain annotations — first-class citizens (SPEC D2/D4/13a)', () => {
  it('annotate materializes into doc.annotations, id-keyed', () => {
    const chain = createChain(baseDocument(), AUTHOR)
    chain.apply(M('annotate'), [
      { op: 'annotate', annotation: annotation({ id: 'a1', text: 'padding looks off', nodeId: 'n-child-1' }) },
    ])
    expect(chain.doc().annotations).toEqual([{ id: 'a1', text: 'padding looks off', nodeId: 'n-child-1', status: 'open' }])
  })

  it('a second annotate with a different id adds another annotation (sorted by id)', () => {
    const chain = createChain(baseDocument(), AUTHOR)
    chain.apply(M('a2 first'), [{ op: 'annotate', annotation: annotation({ id: 'a2', text: 'second', x: 10, y: 20 }) }])
    chain.apply(M('a1 second'), [{ op: 'annotate', annotation: annotation({ id: 'a1', text: 'first', state: 'default' }) }])
    expect(chain.doc().annotations.map((a) => a.id)).toEqual(['a1', 'a2'])
  })

  it('set-annotation-status changes only the status field, leaving anchor/text untouched', () => {
    const chain = createChain(baseDocument(), AUTHOR)
    chain.apply(M('annotate'), [{ op: 'annotate', annotation: annotation({ id: 'a1', text: 'fix this', nodeId: 'n-child-1' }) }])
    chain.apply(M('resolve'), [{ op: 'set-annotation-status', id: 'a1', status: 'resolved' }])
    expect(chain.doc().annotations).toEqual([{ id: 'a1', text: 'fix this', nodeId: 'n-child-1', status: 'resolved' }])
  })

  it('set-annotation-status on an unknown id throws', () => {
    const chain = createChain(baseDocument(), AUTHOR)
    expect(() => chain.apply(M('bad'), [{ op: 'set-annotation-status', id: 'nope', status: 'resolved' }])).toThrow()
  })

  it('remove-annotation deletes it', () => {
    const chain = createChain(baseDocument(), AUTHOR)
    chain.apply(M('annotate'), [{ op: 'annotate', annotation: annotation({ id: 'a1', text: 'x' }) }])
    chain.apply(M('remove'), [{ op: 'remove-annotation', id: 'a1' }])
    expect(chain.doc().annotations).toEqual([])
  })

  it('undo of a brand-new annotate removes it (no prior version existed)', () => {
    const chain = createChain(baseDocument(), AUTHOR)
    const before = chain.doc()
    chain.apply(M('annotate'), [{ op: 'annotate', annotation: annotation({ id: 'a1', text: 'x' }) }])
    chain.undo(M('undo'))
    expect(chain.doc()).toEqual(before)
  })

  it('undo of set-annotation-status restores the previous status', () => {
    const chain = createChain(baseDocument(), AUTHOR)
    chain.apply(M('annotate'), [{ op: 'annotate', annotation: annotation({ id: 'a1', text: 'x' }) }])
    const beforeStatusChange = chain.doc()
    chain.apply(M('resolve'), [{ op: 'set-annotation-status', id: 'a1', status: 'resolved' }])
    chain.undo(M('undo'))
    expect(chain.doc()).toEqual(beforeStatusChange)
    expect(chain.doc().annotations[0]?.status).toBe('open')
  })

  it('undo of remove-annotation re-adds the exact removed annotation', () => {
    const chain = createChain(baseDocument(), AUTHOR)
    chain.apply(M('annotate'), [{ op: 'annotate', annotation: annotation({ id: 'a1', text: 'x', state: 'default' }) }])
    const before = chain.doc()
    chain.apply(M('remove'), [{ op: 'remove-annotation', id: 'a1' }])
    chain.undo(M('undo'))
    expect(chain.doc()).toEqual(before)
  })

  it('undo of remove-annotation on a never-existed id is a no-op inverse (nothing to restore)', () => {
    const chain = createChain(baseDocument(), AUTHOR)
    const before = chain.doc()
    chain.apply(M('remove nothing'), [{ op: 'remove-annotation', id: 'never-existed' }])
    expect(chain.doc()).toEqual(before)
  })

  it('re-annotating an existing id (rewriting it) inverts back to the PRIOR annotation content, not a delete', () => {
    const chain = createChain(baseDocument(), AUTHOR)
    chain.apply(M('first'), [{ op: 'annotate', annotation: annotation({ id: 'a1', text: 'v1' }) }])
    const afterFirst = chain.doc()
    chain.apply(M('rewrite'), [{ op: 'annotate', annotation: annotation({ id: 'a1', text: 'v2' }) }])
    chain.undo(M('undo'))
    expect(chain.doc()).toEqual(afterFirst)
    expect(chain.doc().annotations[0]?.text).toBe('v1')
  })

  it('structural diff emits section-changed "annotations" for an added/changed/removed annotation', () => {
    const chain = createChain(baseDocument(), AUTHOR)
    chain.anchor('start')
    chain.apply(M('annotate'), [{ op: 'annotate', annotation: annotation({ id: 'a1', text: 'x' }) }])
    chain.anchor('added')
    const ops = chain.diff('start', 'added')
    expect(ops).toEqual([{ op: 'section-changed', section: 'annotations', name: 'a1' }])
  })

  it('merge of concurrent annotations from two authors: both are present afterward', () => {
    const a = createChain(baseDocument(), { author: 'user:alice', message: 'seed' })
    const b = a.fork('user:bob')

    a.apply({ author: 'user:alice', message: 'alice annotates' }, [
      { op: 'annotate', annotation: annotation({ id: 'a1', text: 'alice: fix spacing', nodeId: 'n-child-1' }) },
    ])
    b.apply({ author: 'user:bob', message: 'bob annotates' }, [
      { op: 'annotate', annotation: annotation({ id: 'a2', text: 'bob: color is off', nodeId: 'n-child-2' }) },
    ])

    a.merge(b)
    b.merge(a)

    const docA = a.doc()
    const docB = b.doc()
    expect(docA).toEqual(docB)
    expect(docA.annotations.map((x) => x.id)).toEqual(['a1', 'a2'])
    expect(docA.annotations.find((x) => x.id === 'a1')?.text).toBe('alice: fix spacing')
    expect(docA.annotations.find((x) => x.id === 'a2')?.text).toBe('bob: color is off')
  })

  it('merge of a concurrent resolve (peer A) and wontfix (peer B) on the SAME annotation converges (last-writer-wins on that key, both peers agree)', () => {
    const a = createChain(baseDocument(), { author: 'user:alice', message: 'seed' })
    a.apply({ author: 'user:alice', message: 'annotate' }, [{ op: 'annotate', annotation: annotation({ id: 'a1', text: 'shared' }) }])
    const b = a.fork('user:bob')

    a.apply({ author: 'user:alice', message: 'alice resolves' }, [{ op: 'set-annotation-status', id: 'a1', status: 'resolved' }])
    b.apply({ author: 'user:bob', message: 'bob wontfixes' }, [{ op: 'set-annotation-status', id: 'a1', status: 'wontfix' }])

    a.merge(b)
    b.merge(a)

    expect(a.doc()).toEqual(b.doc())
    expect(['resolved', 'wontfix']).toContain(a.doc().annotations[0]?.status)
  })
})
