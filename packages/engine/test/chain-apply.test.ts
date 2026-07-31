import { describe, expect, it } from 'vitest'
import { createChain } from '../src/chain/index.js'
import { baseDocument, el } from './chain-fixtures.js'
import type { ChangeMeta } from '../src/types.js'

const AUTHOR: ChangeMeta = { author: 'user:tormod', message: 'seed' }
const M = (message: string): ChangeMeta => ({ author: 'user:tormod', message })

describe('chain apply — seeding', () => {
  it('createChain seeds the document and doc() deep-equals it', () => {
    const doc = baseDocument()
    const chain = createChain(doc, AUTHOR)
    expect(chain.doc()).toEqual(doc)
  })

  it('one apply() call produces exactly one new envelope', () => {
    const chain = createChain(baseDocument(), AUTHOR)
    const before = chain.log().length
    chain.apply(M('multi-op batch'), [
      { op: 'set-token', name: 'space-md', value: '20px' },
      { op: 'set-attr', id: 'n-root', key: 'data-x', value: '1' },
      { op: 'set-text', id: 'n-child-1', text: 'updated' },
    ])
    expect(chain.log().length).toBe(before + 1)
  })

  it('apply() returns the EnvelopeRecord for that call and head() matches', () => {
    const chain = createChain(baseDocument(), AUTHOR)
    const record = chain.apply(M('one change'), [{ op: 'set-token', name: 'space-md', value: '1px' }])
    expect(chain.head()).toEqual(record)
    expect(record.author).toBe('user:tormod')
    expect(record.message).toBe('one change')
  })
})

describe('chain apply — every PatchOp variant', () => {
  it('insert-node adds a full subtree at the given parent/index', () => {
    const chain = createChain(baseDocument(), AUTHOR)
    const newNode = el('n-new', 'a', { attrs: { href: '#' }, children: [el('n-new-child', 'b', { text: 'bold' })] })
    chain.apply(M('insert'), [{ op: 'insert-node', parent: 'n-root', index: 0, node: newNode }])
    const doc = chain.doc()
    expect(doc.body[0]?.children[0]).toEqual(newNode)
  })

  it('insert-node with parent null inserts a new top-level body root', () => {
    const chain = createChain(baseDocument(), AUTHOR)
    const newRoot = el('n-third-root', 'aside')
    chain.apply(M('insert root'), [{ op: 'insert-node', parent: null, index: 1, node: newRoot }])
    const doc = chain.doc()
    expect(doc.body.map((n) => n.id)).toEqual(['n-root', 'n-third-root', 'n-second-root'])
  })

  it('remove-node deletes a subtree', () => {
    const chain = createChain(baseDocument(), AUTHOR)
    chain.apply(M('remove'), [{ op: 'remove-node', id: 'n-child-2' }])
    const doc = chain.doc()
    expect(doc.body[0]?.children.map((n) => n.id)).toEqual(['n-child-1'])
  })

  it('remove-node can remove a top-level body root', () => {
    const chain = createChain(baseDocument(), AUTHOR)
    chain.apply(M('remove root'), [{ op: 'remove-node', id: 'n-second-root' }])
    const doc = chain.doc()
    expect(doc.body.map((n) => n.id)).toEqual(['n-root'])
  })

  it('move-node reparents and repositions a node', () => {
    const chain = createChain(baseDocument(), AUTHOR)
    chain.apply(M('move'), [{ op: 'move-node', id: 'n-child-2', parent: null, index: 0 }])
    const doc = chain.doc()
    expect(doc.body.map((n) => n.id)).toEqual(['n-child-2', 'n-root', 'n-second-root'])
    expect(doc.body[1]?.children.map((n) => n.id)).toEqual(['n-child-1'])
  })

  it('set-attr sets and (with null) removes an attribute', () => {
    const chain = createChain(baseDocument(), AUTHOR)
    chain.apply(M('set attr'), [{ op: 'set-attr', id: 'n-child-2', key: 'data-testid', value: 'p2' }])
    expect(chain.doc().body[0]?.children[1]?.attrs['data-testid']).toBe('p2')
    chain.apply(M('unset attr'), [{ op: 'set-attr', id: 'n-child-2', key: 'id', value: null }])
    expect(chain.doc().body[0]?.children[1]?.attrs.id).toBeUndefined()
  })

  it('set-style sets base style and per-state style planes independently', () => {
    const chain = createChain(baseDocument(), AUTHOR)
    chain.apply(M('base style'), [{ op: 'set-style', id: 'n-child-2', prop: 'margin', value: '4px' }])
    chain.apply(M('hover style'), [{ op: 'set-style', id: 'n-child-2', prop: 'color', value: 'green', state: 'hover' }])
    const node = chain.doc().body[0]?.children[1]
    expect(node?.style.margin).toBe('4px')
    expect(node?.style.color).toBe('blue')
    expect(node?.styleStates.hover?.color).toBe('green')
  })

  it('set-style with null removes a declaration', () => {
    const chain = createChain(baseDocument(), AUTHOR)
    chain.apply(M('unset'), [{ op: 'set-style', id: 'n-child-2', prop: 'color', value: null }])
    expect(chain.doc().body[0]?.children[1]?.style.color).toBeUndefined()
  })

  it('set-style-ref sets and clears a named-style reference', () => {
    const chain = createChain(baseDocument(), AUTHOR)
    chain.apply(M('ref'), [{ op: 'set-style-ref', id: 'n-child-2', styleRef: 'card' }])
    expect(chain.doc().body[0]?.children[1]?.styleRef).toBe('card')
    chain.apply(M('unref'), [{ op: 'set-style-ref', id: 'n-child-2', styleRef: null }])
    expect(chain.doc().body[0]?.children[1]?.styleRef).toBeUndefined()
  })

  it('set-text updates leaf text', () => {
    const chain = createChain(baseDocument(), AUTHOR)
    chain.apply(M('text'), [{ op: 'set-text', id: 'n-child-1', text: 'goodbye' }])
    expect(chain.doc().body[0]?.children[0]?.text).toBe('goodbye')
  })

  it('set-when sets and clears the conditional expression', () => {
    const chain = createChain(baseDocument(), AUTHOR)
    chain.apply(M('when'), [{ op: 'set-when', id: 'n-child-1', when: 'prop.show' }])
    expect(chain.doc().body[0]?.children[0]?.when).toBe('prop.show')
    chain.apply(M('unwhen'), [{ op: 'set-when', id: 'n-child-1', when: null }])
    expect(chain.doc().body[0]?.children[0]?.when).toBeUndefined()
  })

  it('set-token sets and (with null) removes a token', () => {
    const chain = createChain(baseDocument(), AUTHOR)
    chain.apply(M('token'), [{ op: 'set-token', name: 'space-lg', value: '32px' }])
    expect(chain.doc().tokens['space-lg']).toBe('32px')
    chain.apply(M('untoken'), [{ op: 'set-token', name: 'space-md', value: null }])
    expect(chain.doc().tokens['space-md']).toBeUndefined()
  })

  it('set-named-style upserts and remove-named-style deletes', () => {
    const chain = createChain(baseDocument(), AUTHOR)
    chain.apply(M('style'), [{ op: 'set-named-style', style: { name: 'pill', style: { borderRadius: '999px' }, styleStates: {} } }])
    expect(chain.doc().namedStyles.find((s) => s.name === 'pill')).toEqual({ name: 'pill', style: { borderRadius: '999px' }, styleStates: {} })
    chain.apply(M('remove style'), [{ op: 'remove-named-style', name: 'card' }])
    expect(chain.doc().namedStyles.find((s) => s.name === 'card')).toBeUndefined()
  })

  it('set-component upserts and remove-component deletes', () => {
    const chain = createChain(baseDocument(), AUTHOR)
    chain.apply(M('component'), [{ op: 'set-component', component: { name: 'Card', props: [], slots: ['default'], body: [] } }])
    expect(chain.doc().components.find((c) => c.name === 'Card')).toEqual({ name: 'Card', props: [], slots: ['default'], body: [] })
    chain.apply(M('remove component'), [{ op: 'remove-component', name: 'Button' }])
    expect(chain.doc().components.find((c) => c.name === 'Button')).toBeUndefined()
  })

  it('set-param upserts a param', () => {
    const chain = createChain(baseDocument(), AUTHOR)
    chain.apply(M('param'), [{ op: 'set-param', param: { name: 'size', type: 'enum', values: ['sm', 'lg'] } }])
    expect(chain.doc().params.find((p) => p.name === 'size')).toEqual({ name: 'size', type: 'enum', values: ['sm', 'lg'] })
  })

  it('set-lookup upserts a lookup', () => {
    const chain = createChain(baseDocument(), AUTHOR)
    chain.apply(M('lookup'), [{ op: 'set-lookup', lookup: { name: 'weights', entries: { thin: '100' } } }])
    expect(chain.doc().lookups.find((l) => l.name === 'weights')).toEqual({ name: 'weights', entries: { thin: '100' } })
  })

  it('set-state upserts a state', () => {
    const chain = createChain(baseDocument(), AUTHOR)
    chain.apply(M('state'), [{ op: 'set-state', state: { name: 'hover-state', assignments: { variant: 'b' } } }])
    expect(chain.doc().states.find((s) => s.name === 'hover-state')).toEqual({ name: 'hover-state', assignments: { variant: 'b' } })
  })

  it('replace-document swaps the entire document atomically', () => {
    const chain = createChain(baseDocument(), AUTHOR)
    const replacement = baseDocument()
    replacement.body = [el('n-fresh', 'main', { text: 'fresh' })]
    replacement.tokens = { only: 'one' }
    chain.apply(M('replace'), [{ op: 'replace-document', doc: replacement }])
    expect(chain.doc()).toEqual(replacement)
  })
})
