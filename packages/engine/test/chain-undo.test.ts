import { describe, expect, it } from 'vitest'
import { createChain, loadChain } from '../src/chain/index.js'
import { baseDocument, el } from './chain-fixtures.js'
import type { ChangeMeta } from '../src/types.js'

const AUTHOR: ChangeMeta = { author: 'user:tormod', message: 'seed' }
const M = (message: string): ChangeMeta => ({ author: 'user:tormod', message })

describe('chain undo — inverse of the last local change', () => {
  it('undo of insert-node removes it', () => {
    const chain = createChain(baseDocument(), AUTHOR)
    const before = chain.doc()
    chain.apply(M('insert'), [{ op: 'insert-node', parent: 'n-root', index: 0, node: el('n-new', 'i') }])
    expect(chain.doc()).not.toEqual(before)
    chain.undo(M('undo insert'))
    expect(chain.doc()).toEqual(before)
  })

  it('undo of remove-node re-inserts the exact subtree at its original position', () => {
    const chain = createChain(baseDocument(), AUTHOR)
    const before = chain.doc()
    chain.apply(M('remove'), [{ op: 'remove-node', id: 'n-child-1' }])
    chain.undo(M('undo remove'))
    expect(chain.doc()).toEqual(before)
  })

  it('undo of move-node moves it back', () => {
    const chain = createChain(baseDocument(), AUTHOR)
    const before = chain.doc()
    chain.apply(M('move'), [{ op: 'move-node', id: 'n-child-2', parent: null, index: 0 }])
    expect(chain.doc().body.map((n) => n.id)).toEqual(['n-child-2', 'n-root', 'n-second-root'])
    chain.undo(M('undo move'))
    expect(chain.doc()).toEqual(before)
  })

  it('undo of set-attr / set-style / set-style-ref / set-text / set-when restores the previous value', () => {
    const chain = createChain(baseDocument(), AUTHOR)
    const before = chain.doc()
    chain.apply(M('edit'), [
      { op: 'set-attr', id: 'n-child-2', key: 'id', value: 'changed' },
      { op: 'set-style', id: 'n-child-2', prop: 'color', value: 'green' },
      { op: 'set-style-ref', id: 'n-child-2', styleRef: 'card' },
      { op: 'set-text', id: 'n-child-1', text: 'changed' },
      { op: 'set-when', id: 'n-child-1', when: 'prop.show' },
    ])
    expect(chain.doc()).not.toEqual(before)
    chain.undo(M('undo edit'))
    expect(chain.doc()).toEqual(before)
  })

  it('undo of set-token restores the previous value (including re-deleting a newly created token)', () => {
    const chain = createChain(baseDocument(), AUTHOR)
    const before = chain.doc()
    chain.apply(M('new token'), [{ op: 'set-token', name: 'brand-new', value: 'x' }])
    chain.undo(M('undo'))
    expect(chain.doc()).toEqual(before)

    const before2 = chain.doc()
    chain.apply(M('change existing'), [{ op: 'set-token', name: 'color-brand', value: '#000000' }])
    chain.undo(M('undo2'))
    expect(chain.doc()).toEqual(before2)
  })

  it('undo of set-named-style / remove-named-style round-trips', () => {
    const chain = createChain(baseDocument(), AUTHOR)
    const before = chain.doc()
    chain.apply(M('new style'), [{ op: 'set-named-style', style: { name: 'brand-new-style', style: {}, styleStates: {} } }])
    chain.undo(M('undo'))
    expect(chain.doc()).toEqual(before)

    chain.apply(M('remove existing'), [{ op: 'remove-named-style', name: 'card' }])
    chain.undo(M('undo remove'))
    expect(chain.doc()).toEqual(before)
  })

  it('undo of set-component / remove-component round-trips', () => {
    const chain = createChain(baseDocument(), AUTHOR)
    const before = chain.doc()
    chain.apply(M('new component'), [{ op: 'set-component', component: { name: 'NewOne', props: [], slots: [], body: [] } }])
    chain.undo(M('undo'))
    expect(chain.doc()).toEqual(before)

    chain.apply(M('remove existing'), [{ op: 'remove-component', name: 'Button' }])
    chain.undo(M('undo remove'))
    expect(chain.doc()).toEqual(before)
  })

  it('undo of set-param/set-lookup/set-state on an EXISTING item restores the previous value', () => {
    const chain = createChain(baseDocument(), AUTHOR)
    const before = chain.doc()
    chain.apply(M('edit param'), [{ op: 'set-param', param: { name: 'variant', type: 'enum', values: ['x'] } }])
    chain.undo(M('undo'))
    expect(chain.doc()).toEqual(before)

    chain.apply(M('edit lookup'), [{ op: 'set-lookup', lookup: { name: 'sizes', entries: { sm: '99px' } } }])
    chain.undo(M('undo'))
    expect(chain.doc()).toEqual(before)

    chain.apply(M('edit state'), [{ op: 'set-state', state: { name: 'default', assignments: { variant: 'z' } } }])
    chain.undo(M('undo'))
    expect(chain.doc()).toEqual(before)
  })

  it('undo of a first-time set-param falls back to a whole-document revert (contract finding: no remove-param op exists)', () => {
    const chain = createChain(baseDocument(), AUTHOR)
    const before = chain.doc()
    chain.apply(M('brand new param'), [{ op: 'set-param', param: { name: 'brand-new', type: 'string' } }])
    expect(chain.doc().params.some((p) => p.name === 'brand-new')).toBe(true)
    chain.undo(M('undo'))
    expect(chain.doc()).toEqual(before)
    expect(chain.doc().params.some((p) => p.name === 'brand-new')).toBe(false)
  })

  it('undo of replace-document restores the prior whole document', () => {
    const chain = createChain(baseDocument(), AUTHOR)
    const before = chain.doc()
    const replacement = baseDocument()
    replacement.body = [el('n-fresh', 'main')]
    chain.apply(M('replace'), [{ op: 'replace-document', doc: replacement }])
    chain.undo(M('undo'))
    expect(chain.doc()).toEqual(before)
  })

  it('undo of a multi-op batch reverts all ops in the batch atomically', () => {
    const chain = createChain(baseDocument(), AUTHOR)
    const before = chain.doc()
    chain.apply(M('multi'), [
      { op: 'insert-node', parent: 'n-root', index: 0, node: el('n-multi', 'i') },
      { op: 'set-attr', id: 'n-child-2', key: 'id', value: 'x' },
      { op: 'move-node', id: 'n-child-1', parent: null, index: 0 },
    ])
    chain.undo(M('undo'))
    expect(chain.doc()).toEqual(before)
  })

  it('undo only reverts the LAST local change, not everything', () => {
    const chain = createChain(baseDocument(), AUTHOR)
    chain.apply(M('one'), [{ op: 'set-token', name: 't1', value: '1' }])
    const afterOne = chain.doc()
    chain.apply(M('two'), [{ op: 'set-token', name: 't2', value: '2' }])
    chain.undo(M('undo two'))
    expect(chain.doc()).toEqual(afterOne)
  })

  it('undo throws when there is no local change to undo (e.g. right after loadChain)', () => {
    const chain = createChain(baseDocument(), AUTHOR)
    const bytes = chain.save()
    const reloaded = loadChain(bytes)
    expect(() => reloaded.undo(M('nope'))).toThrow()
  })
})
