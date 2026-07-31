import { describe, expect, it } from 'vitest'
import { bakeDocument } from '../src/bake/index.js'
import type { FdnDocument, FdnNode } from '../src/types.js'

function node(overrides: Partial<FdnNode> & Pick<FdnNode, 'id' | 'tag'>): FdnNode {
  return { attrs: {}, style: {}, styleStates: {}, children: [], ...overrides }
}

function doc(overrides: Partial<FdnDocument> = {}): FdnDocument {
  return {
    specVersion: '0.0.1-draft',
    tokens: {},
    params: [],
    data: [],
    lookups: [],
    states: [],
    viewports: [],
    matrix: [],
    namedStyles: [],
    components: [],
    body: [],
    ...overrides,
  }
}

describe('bake: state resolution', () => {
  it('no state selected uses each param default', () => {
    const d = doc({
      params: [{ name: 'title', type: 'string', default: 'Default Title' }],
      body: [node({ id: 'n1', tag: 'div', text: '{{ param.title }}' })],
    })
    const result = bakeDocument(d)
    expect(result.state).toBeNull()
    expect(result.tree[0]?.text).toBe('Default Title')
    expect(result.report.lines).toEqual([])
  })

  it('a named state layers assignments over defaults', () => {
    const d = doc({
      params: [
        { name: 'title', type: 'string', default: 'Default Title' },
        { name: 'mode', type: 'string', default: 'idle' },
      ],
      states: [{ name: 'busy', assignments: { mode: 'loading' } }],
      body: [node({ id: 'n1', tag: 'div', text: '{{ param.title }} / {{ param.mode }}' })],
    })
    const result = bakeDocument(d, { state: 'busy' })
    expect(result.state).toBe('busy')
    expect(result.tree[0]?.text).toBe('Default Title / loading')
  })

  it('param with no default and no state assignment bakes empty with a report line', () => {
    const d = doc({
      params: [{ name: 'title', type: 'string' }],
      body: [node({ id: 'n1', tag: 'div', text: '{{ param.title }}' })],
    })
    const result = bakeDocument(d)
    expect(result.tree[0]?.text).toBe('')
    expect(result.report.lines.some((l) => l.code === 'param-missing-default')).toBe(true)
  })

  it('a state assignment overrides even when a default exists, using the state value verbatim', () => {
    const d = doc({
      params: [{ name: 'count', type: 'number', default: 1 }],
      states: [{ name: 's', assignments: { count: 42 } }],
      body: [node({ id: 'n1', tag: 'div', text: '{{ param.count }}' })],
    })
    const result = bakeDocument(d, { state: 's' })
    expect(result.tree[0]?.text).toBe('42')
  })

  it('an unknown state name reports unknown-state and falls back to defaults', () => {
    const d = doc({
      params: [{ name: 'title', type: 'string', default: 'Default' }],
      body: [node({ id: 'n1', tag: 'div', text: '{{ param.title }}' })],
    })
    const result = bakeDocument(d, { state: 'nope' })
    expect(result.report.lines.some((l) => l.code === 'unknown-state')).toBe(true)
    expect(result.tree[0]?.text).toBe('Default')
  })
})
