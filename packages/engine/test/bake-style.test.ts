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

describe('bake: conformance audit — category-aware off-token-value (round 3)', () => {
  it('positive: a space-* token is suggested for a padding value it matches', () => {
    const d = doc({
      tokens: { 'space-2': '8px' },
      body: [node({ id: 'n1', tag: 'div', style: { padding: '8px' } })],
    })
    const result = bakeDocument(d)
    const line = result.report.lines.find((l) => l.code === 'off-token-value')
    expect(line).toBeDefined()
    expect(line?.message).toContain('space-2')
  })

  it('positive: a radius-* token is suggested for a border-radius value it matches', () => {
    const d = doc({
      tokens: { 'radius-lg': '8px' },
      body: [node({ id: 'n1', tag: 'div', style: { 'border-radius': '8px' } })],
    })
    const result = bakeDocument(d)
    const line = result.report.lines.find((l) => l.code === 'off-token-value')
    expect(line).toBeDefined()
    expect(line?.message).toContain('radius-lg')
  })

  it('negative: no cross-category suggestion — a radius-* token matching the raw VALUE is never suggested for padding', () => {
    // the exact regression this round exists to fix: "radius-lg for padding"
    const d = doc({
      tokens: { 'radius-lg': '8px' },
      body: [node({ id: 'n1', tag: 'div', style: { padding: '8px' } })],
    })
    const result = bakeDocument(d)
    expect(result.report.lines.some((l) => l.code === 'off-token-value')).toBe(false)
  })

  it('negative: a space-* token matching the raw value is never suggested for border-radius', () => {
    const d = doc({
      tokens: { 'space-2': '8px' },
      body: [node({ id: 'n1', tag: 'div', style: { 'border-radius': '8px' } })],
    })
    const result = bakeDocument(d)
    expect(result.report.lines.some((l) => l.code === 'off-token-value')).toBe(false)
  })

  it('positive: font-size-* and font-weight-* categories match their own properties only', () => {
    const d = doc({
      tokens: { 'font-size-xs': '600', 'font-weight-semibold': '600' },
      body: [
        node({ id: 'n1', tag: 'div', style: { 'font-weight': '600' } }),
        node({ id: 'n2', tag: 'div', style: { 'font-size': '600' } }),
      ],
    })
    const result = bakeDocument(d)
    const weightLine = result.report.lines.find((l) => l.message.includes('"font-weight"'))
    const sizeLine = result.report.lines.find((l) => l.message.includes('"font-size"'))
    expect(weightLine?.message).toContain('font-weight-semibold')
    expect(weightLine?.message).not.toContain('font-size-xs')
    expect(sizeLine?.message).toContain('font-size-xs')
    expect(sizeLine?.message).not.toContain('font-weight-semibold')
  })

  it('positive: color category matches by VALUE shape (hex), for color-family properties', () => {
    const d = doc({
      tokens: { 'brand-ink': '#2E2B27' }, // deliberately NOT "color-" prefixed
      body: [node({ id: 'n1', tag: 'div', style: { color: '#2E2B27', 'background-color': '#2E2B27' } })],
    })
    const result = bakeDocument(d)
    const lines = result.report.lines.filter((l) => l.code === 'off-token-value')
    expect(lines).toHaveLength(2)
    expect(lines.every((l) => l.message.includes('brand-ink'))).toBe(true)
  })

  it('negative: an unprefixed, non-color-shaped token never matches (same-category impossibility -> skip)', () => {
    const d = doc({
      tokens: { 'weird-name': '8px' }, // no recognized prefix, not a color value
      body: [node({ id: 'n1', tag: 'div', style: { padding: '8px' } })],
    })
    const result = bakeDocument(d)
    expect(result.report.lines.some((l) => l.code === 'off-token-value')).toBe(false)
  })

  it('negative: a property with no recognized category never triggers a suggestion, even on exact value match', () => {
    const d = doc({
      tokens: { 'space-2': '8px' },
      body: [node({ id: 'n1', tag: 'div', style: { 'letter-spacing': '8px' } })],
    })
    const result = bakeDocument(d)
    expect(result.report.lines.some((l) => l.code === 'off-token-value')).toBe(false)
  })
})

describe('bake: report dedup (round 3)', () => {
  it('collapses identical (code, message) report lines from repeated component instances into one, with a count', () => {
    const badge = {
      name: 'Badge',
      props: [],
      slots: [],
      body: [node({ id: 'root', tag: 'div', style: { padding: '8px' } })],
    }
    const d = doc({
      tokens: { 'space-2': '8px' },
      components: [badge],
      body: [
        node({ id: 'use1', tag: 'fdn-use', attrs: { component: 'Badge' } }),
        node({ id: 'use2', tag: 'fdn-use', attrs: { component: 'Badge' } }),
        node({ id: 'use3', tag: 'fdn-use', attrs: { component: 'Badge' } }),
      ],
    })
    const result = bakeDocument(d)
    const lines = result.report.lines.filter((l) => l.code === 'off-token-value')
    expect(lines).toHaveLength(1)
    expect(lines[0]?.message).toContain('(x3)')
    expect(lines[0]?.detail).toMatchObject({ count: 3 })
    // nodeId no longer identifies a single node once collapsed
    expect(lines[0]?.nodeId).toBeUndefined()
  })

  it('does not collapse genuinely distinct (different code/message) lines', () => {
    const d = doc({
      tokens: { 'space-2': '8px', 'radius-lg': '4px' },
      body: [
        node({ id: 'n1', tag: 'div', style: { padding: '8px' } }),
        node({ id: 'n2', tag: 'div', style: { 'border-radius': '4px' } }),
      ],
    })
    const result = bakeDocument(d)
    const lines = result.report.lines.filter((l) => l.code === 'off-token-value')
    expect(lines).toHaveLength(2)
    expect(lines.every((l) => !l.message.includes('(x'))).toBe(true)
  })

  it('a single (non-repeated) report line is left untouched, nodeId included', () => {
    const d = doc({
      tokens: { 'space-2': '8px' },
      body: [node({ id: 'only-node', tag: 'div', style: { padding: '8px' } })],
    })
    const result = bakeDocument(d)
    const line = result.report.lines.find((l) => l.code === 'off-token-value')
    expect(line?.nodeId).toBe('only-node')
    expect(line?.message).not.toContain('(x')
  })
})
