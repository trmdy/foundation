import { describe, expect, it } from 'vitest'
import { bakeDocument } from '../src/bake/index.js'
import type { FdnDocument, FdnNamedStyle, FdnNode } from '../src/types.js'

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

describe('bake: named-style inlining', () => {
  const rowStyle: FdnNamedStyle = {
    name: 'row',
    style: { display: 'flex', gap: '8px', padding: '4px' },
    styleStates: { hover: { background: 'var(--color-selected-bg)' } },
  }

  it('inlines a named style under the node, keeping data-fdn-style for traceability', () => {
    const d = doc({
      namedStyles: [rowStyle],
      body: [node({ id: 'n1', tag: 'div', styleRef: 'row' })],
    })
    const result = bakeDocument(d)
    const n = result.tree[0] as FdnNode
    expect(n.style).toEqual({ display: 'flex', gap: '8px', padding: '4px' })
    expect(n.attrs['data-fdn-style']).toBe('row')
  })

  it('the node\'s own style wins over the named style on conflicting props', () => {
    const d = doc({
      namedStyles: [rowStyle],
      body: [node({ id: 'n1', tag: 'div', styleRef: 'row', style: { gap: '12px' } })],
    })
    const result = bakeDocument(d)
    const n = result.tree[0] as FdnNode
    expect(n.style['gap']).toBe('12px')
    expect(n.style['display']).toBe('flex')
    expect(n.style['padding']).toBe('4px')
  })

  it('merges styleStates planes, node wins on conflicts, and emits style-hover etc as attrs', () => {
    const d = doc({
      namedStyles: [rowStyle],
      body: [
        node({
          id: 'n1',
          tag: 'div',
          styleRef: 'row',
          styleStates: { hover: { background: 'red' }, focus: { outline: '2px solid blue' } },
        }),
      ],
    })
    const result = bakeDocument(d)
    const n = result.tree[0] as FdnNode
    expect(n.attrs['style-hover']).toBe('background:red')
    expect(n.attrs['style-focus']).toBe('outline:2px solid blue')
    expect(n.attrs['style-active']).toBeUndefined()
    expect(n.styleStates.hover).toEqual({ background: 'red' })
  })

  it('an unknown styleRef reports unknown-style-ref and still bakes the node\'s own style', () => {
    const d = doc({ body: [node({ id: 'n1', tag: 'div', styleRef: 'ghost', style: { color: 'red' } })] })
    const result = bakeDocument(d)
    expect(result.report.lines.some((l) => l.code === 'unknown-style-ref')).toBe(true)
    expect(result.tree[0]?.style['color']).toBe('red')
  })

  it('interpolates style values', () => {
    const d = doc({
      params: [{ name: 'accent', type: 'token', default: 'var(--color-accent)' }],
      body: [node({ id: 'n1', tag: 'div', style: { color: '{{ param.accent }}' } })],
    })
    const result = bakeDocument(d)
    expect(result.tree[0]?.style['color']).toBe('var(--color-accent)')
  })
})

describe('bake: conformance audit — tokens', () => {
  it('off-token-value: a raw value matching a declared token value is flagged', () => {
    const d = doc({
      tokens: { 'color-accent': '#9C6A1C' },
      body: [node({ id: 'n1', tag: 'div', style: { color: '#9C6A1C' } })],
    })
    const result = bakeDocument(d)
    const line = result.report.lines.find((l) => l.code === 'off-token-value')
    expect(line).toBeDefined()
    expect(line?.severity).toBe('info')
  })

  it('a value that already references var(--token) is not flagged off-token', () => {
    const d = doc({
      tokens: { 'color-accent': '#9C6A1C' },
      body: [node({ id: 'n1', tag: 'div', style: { color: 'var(--color-accent)' } })],
    })
    const result = bakeDocument(d)
    expect(result.report.lines.some((l) => l.code === 'off-token-value')).toBe(false)
  })

  it('unused-token: a declared token never referenced via var() is flagged', () => {
    const d = doc({
      tokens: { 'color-accent': '#9C6A1C', 'color-used': '#FFFFFF' },
      body: [node({ id: 'n1', tag: 'div', style: { color: 'var(--color-used)' } })],
    })
    const result = bakeDocument(d)
    const unused = result.report.lines.filter((l) => l.code === 'unused-token')
    expect(unused).toHaveLength(1)
    expect(unused[0]?.message).toContain('color-accent')
  })

  it('a token referenced only via a styleStates plane counts as used', () => {
    const d = doc({
      tokens: { 'color-hover-bg': '#EEE' },
      body: [node({ id: 'n1', tag: 'div', styleStates: { hover: { background: 'var(--color-hover-bg)' } } })],
    })
    const result = bakeDocument(d)
    expect(result.report.lines.some((l) => l.code === 'unused-token')).toBe(false)
  })
})
