import { describe, expect, it } from 'vitest'
import { createChain } from '../src/chain/index.js'
import { baseDocument, el } from './chain-fixtures.js'
import type { ChangeMeta, SemanticOp } from '../src/types.js'

const AUTHOR: ChangeMeta = { author: 'user:tormod', message: 'seed' }
const M = (message: string): ChangeMeta => ({ author: 'user:tormod', message })

type SectionName = Extract<SemanticOp, { op: 'section-changed' }>['section']

describe('chain anchors + checkout', () => {
  it('checkout(ref) returns the document at that anchor without disturbing current state', () => {
    const chain = createChain(baseDocument(), AUTHOR)
    chain.anchor('v1')
    chain.apply(M('add token'), [{ op: 'set-token', name: 'new-token', value: 'x' }])
    const current = chain.doc()
    expect(current.tokens['new-token']).toBe('x')

    const atV1 = chain.checkout('v1')
    expect(atV1.tokens['new-token']).toBeUndefined()

    // current state must be untouched by the checkout
    expect(chain.doc()).toEqual(current)
    // and the chain must still be writable after a checkout
    chain.apply(M('add another'), [{ op: 'set-token', name: 'yet-another', value: 'y' }])
    expect(chain.doc().tokens['yet-another']).toBe('y')
  })

  it('unknown anchor throws', () => {
    const chain = createChain(baseDocument(), AUTHOR)
    expect(() => chain.checkout('nope')).toThrow()
  })

  it('anchor() can be called multiple times and each name resolves independently', () => {
    const chain = createChain(baseDocument(), AUTHOR)
    chain.anchor('start')
    chain.apply(M('1'), [{ op: 'set-token', name: 't', value: '1' }])
    chain.anchor('mid')
    chain.apply(M('2'), [{ op: 'set-token', name: 't', value: '2' }])
    chain.anchor('end')

    expect(chain.checkout('start').tokens.t).toBeUndefined()
    expect(chain.checkout('mid').tokens.t).toBe('1')
    expect(chain.checkout('end').tokens.t).toBe('2')
  })
})

describe('chain diff — structural, tree ops', () => {
  it('detects insert-node', () => {
    const chain = createChain(baseDocument(), AUTHOR)
    chain.anchor('a')
    chain.apply(M('insert'), [{ op: 'insert-node', parent: 'n-root', index: 0, node: el('n-inserted', 'i') }])
    chain.anchor('b')
    const ops = chain.diff('a', 'b')
    expect(ops).toContainEqual({ op: 'insert-node', id: 'n-inserted', parent: 'n-root', index: 0, tag: 'i' })
  })

  it('detects remove-node', () => {
    const chain = createChain(baseDocument(), AUTHOR)
    chain.anchor('a')
    chain.apply(M('remove'), [{ op: 'remove-node', id: 'n-child-2' }])
    chain.anchor('b')
    const ops = chain.diff('a', 'b')
    expect(ops).toContainEqual({ op: 'remove-node', id: 'n-child-2' })
  })

  it('detects move-node', () => {
    const chain = createChain(baseDocument(), AUTHOR)
    chain.anchor('a')
    chain.apply(M('move'), [{ op: 'move-node', id: 'n-child-2', parent: null, index: 0 }])
    chain.anchor('b')
    const ops = chain.diff('a', 'b')
    expect(ops).toContainEqual({ op: 'move-node', id: 'n-child-2', parent: null, index: 0 })
  })

  it('detects set-attr and set-style (base and per-state)', () => {
    const chain = createChain(baseDocument(), AUTHOR)
    chain.anchor('a')
    chain.apply(M('edit'), [
      { op: 'set-attr', id: 'n-child-2', key: 'data-new', value: 'v' },
      { op: 'set-style', id: 'n-child-2', prop: 'margin', value: '4px' },
      { op: 'set-style', id: 'n-child-2', prop: 'color', value: 'green', state: 'hover' },
    ])
    chain.anchor('b')
    const ops = chain.diff('a', 'b')
    expect(ops).toContainEqual({ op: 'set-attr', id: 'n-child-2', key: 'data-new', value: 'v' })
    expect(ops).toContainEqual({ op: 'set-style', id: 'n-child-2', prop: 'margin', value: '4px' })
    expect(ops).toContainEqual({ op: 'set-style', id: 'n-child-2', prop: 'color', value: 'green', state: 'hover' })
  })

  it('detects set-text', () => {
    const chain = createChain(baseDocument(), AUTHOR)
    chain.anchor('a')
    chain.apply(M('text'), [{ op: 'set-text', id: 'n-child-1', text: 'changed' }])
    chain.anchor('b')
    const ops = chain.diff('a', 'b')
    expect(ops).toContainEqual({ op: 'set-text', id: 'n-child-1', text: 'changed' })
  })

  it('no-op batch (identical anchors) produces empty diff', () => {
    const chain = createChain(baseDocument(), AUTHOR)
    chain.anchor('a')
    chain.anchor('b')
    expect(chain.diff('a', 'b')).toEqual([])
  })
})

describe('chain diff — section-changed for non-tree sections', () => {
  it('reports tokens/params/lookups/states/viewports/namedStyles/components/data/matrix changes', () => {
    const chain = createChain(baseDocument(), AUTHOR)
    chain.anchor('a')
    chain.apply(M('sections'), [
      { op: 'set-token', name: 'color-brand', value: '#ffffff' },
      { op: 'set-param', param: { name: 'variant', type: 'enum', values: ['a', 'b', 'c'] } },
      { op: 'set-lookup', lookup: { name: 'sizes', entries: { sm: '9px', lg: '24px' } } },
      { op: 'set-state', state: { name: 'default', assignments: { variant: 'b' } } },
      { op: 'set-named-style', style: { name: 'card', style: { padding: '20px' }, styleStates: {} } },
      { op: 'set-component', component: { name: 'Button', props: [], slots: [], body: [] } },
    ])
    chain.apply(M('data'), [{ op: 'replace-document', doc: { ...chain.doc(), data: [{ name: 'items', items: [{ id: 99 }] }] } }])
    chain.anchor('b')
    const ops = chain.diff('a', 'b')
    const bySection = (section: SectionName) => ops.filter((o) => o.op === 'section-changed' && o.section === section)

    expect(bySection('tokens').some((o) => o.op === 'section-changed' && o.name === 'color-brand')).toBe(true)
    expect(bySection('params').some((o) => o.op === 'section-changed' && o.name === 'variant')).toBe(true)
    expect(bySection('lookups').some((o) => o.op === 'section-changed' && o.name === 'sizes')).toBe(true)
    expect(bySection('states').some((o) => o.op === 'section-changed' && o.name === 'default')).toBe(true)
    expect(bySection('namedStyles').some((o) => o.op === 'section-changed' && o.name === 'card')).toBe(true)
    expect(bySection('components').some((o) => o.op === 'section-changed' && o.name === 'Button')).toBe(true)
    expect(bySection('data').some((o) => o.op === 'section-changed' && o.name === 'items')).toBe(true)
  })

  it('reports matrix changes with a synthesized state::viewport name', () => {
    const chain = createChain(baseDocument(), AUTHOR)
    chain.anchor('a')
    const replacement = chain.doc()
    replacement.matrix = [{ state: 'default', viewport: 'desktop' }, { state: 'default', viewport: 'mobile' }]
    chain.apply(M('matrix'), [{ op: 'replace-document', doc: replacement }])
    chain.anchor('b')
    const ops = chain.diff('a', 'b')
    expect(ops).toContainEqual({ op: 'section-changed', section: 'matrix', name: 'default::mobile' })
  })
})
