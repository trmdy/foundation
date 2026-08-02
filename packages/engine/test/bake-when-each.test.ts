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
    annotations: [],
    body: [],
    ...overrides,
  }
}

describe('bake: when', () => {
  it('drops a node when when evaluates false', () => {
    const d = doc({
      params: [{ name: 'show', type: 'boolean', default: false }],
      body: [node({ id: 'n1', tag: 'div', when: 'param.show', text: 'visible' })],
    })
    expect(bakeDocument(d).tree).toEqual([])
  })

  it('keeps a node when when evaluates true', () => {
    const d = doc({
      params: [{ name: 'show', type: 'boolean', default: true }],
      body: [node({ id: 'n1', tag: 'div', when: 'param.show', text: 'visible' })],
    })
    const tree = bakeDocument(d).tree
    expect(tree).toHaveLength(1)
    expect(tree[0]?.text).toBe('visible')
  })

  it('a malformed when drops the node and reports expr-parse-error, never throws', () => {
    const d = doc({ body: [node({ id: 'n1', tag: 'div', when: 'param.x &&&', text: 'x' })] })
    const result = bakeDocument(d)
    expect(result.tree).toEqual([])
    expect(result.report.lines.some((l) => l.code === 'expr-parse-error')).toBe(true)
  })
})

describe('bake: each', () => {
  it('REGRESSION (GRAMMAR-FINDINGS.md (g) finding 2): each="alias in data.<name>" — the dotted form validate requires and every board uses — resolves the declared data set, not zero items', () => {
    const d = doc({
      data: [{ name: 'rows', items: [{ label: 'a' }, { label: 'b' }, { label: 'c' }] }],
      body: [node({ id: 'row', tag: 'li', each: 'item in data.rows', text: '{{ item.label }}' })],
    })
    const result = bakeDocument(d)
    expect(result.tree.map((n) => n.text)).toEqual(['a', 'b', 'c'])
    expect(result.tree.every((n) => n.tag === 'li')).toBe(true)
    // ids must be unique per iteration
    expect(new Set(result.tree.map((n) => n.id)).size).toBe(3)
    // the sanctioned dotted form is not deprecated: no report noise
    expect(result.report.lines.some((l) => l.code === 'each-bare-data-source')).toBe(false)
  })

  it('expands over a declared data set with the default "item" binding', () => {
    const d = doc({
      data: [{ name: 'rows', items: [{ label: 'a' }, { label: 'b' }, { label: 'c' }] }],
      body: [node({ id: 'row', tag: 'li', each: 'item in data.rows', text: '{{ item.label }}' })],
    })
    const tree = bakeDocument(d).tree
    expect(tree.map((n) => n.text)).toEqual(['a', 'b', 'c'])
    expect(tree.every((n) => n.tag === 'li')).toBe(true)
    // ids must be unique per iteration
    expect(new Set(tree.map((n) => n.id)).size).toBe(3)
  })

  it('supports a named binding instead of "item"', () => {
    const d = doc({
      data: [{ name: 'rows', items: [{ label: 'x' }, { label: 'y' }] }],
      body: [node({ id: 'row', tag: 'li', each: 'row in data.rows', text: '{{ row.label }}' })],
    })
    const tree = bakeDocument(d).tree
    expect(tree.map((n) => n.text)).toEqual(['x', 'y'])
  })

  it('back-compat: a bare data-set name (no "data." prefix) still resolves, but reports the each-bare-data-source deprecation', () => {
    const d = doc({
      data: [{ name: 'rows', items: [{ label: 'x' }, { label: 'y' }] }],
      body: [node({ id: 'row', tag: 'li', each: 'item in rows', text: '{{ item.label }}' })],
    })
    const result = bakeDocument(d)
    expect(result.tree.map((n) => n.text)).toEqual(['x', 'y'])
    const line = result.report.lines.find((l) => l.code === 'each-bare-data-source')
    expect(line).toBeDefined()
    expect(line?.severity).toBe('warning')
    expect(line?.message).toContain('data.rows')
  })

  it('each="alias in data.<name>" over an undeclared data set reports unknown-ref and renders nothing', () => {
    const d = doc({ body: [node({ id: 'row', tag: 'li', each: 'item in data.missing', text: 'x' })] })
    const result = bakeDocument(d)
    expect(result.tree).toEqual([])
    expect(result.report.lines.some((l) => l.code === 'unknown-ref')).toBe(true)
  })

  it('each over a list-typed param ref', () => {
    const d = doc({
      params: [{ name: 'tags', type: 'list', default: [{ name: 'one' }, { name: 'two' }] }],
      body: [node({ id: 'row', tag: 'span', each: 'item in param.tags', text: '{{ item.name }}' })],
    })
    const tree = bakeDocument(d).tree
    expect(tree.map((n) => n.text)).toEqual(['one', 'two'])
  })

  it('each combined with when filters per-iteration in the item scope', () => {
    const d = doc({
      data: [{ name: 'rows', items: [{ label: 'a', on: true }, { label: 'b', on: false }, { label: 'c', on: true }] }],
      body: [node({ id: 'row', tag: 'li', each: 'item in rows', when: 'item.on', text: '{{ item.label }}' })],
    })
    const tree = bakeDocument(d).tree
    expect(tree.map((n) => n.text)).toEqual(['a', 'c'])
  })

  it('nested each: outer and inner named bindings are both addressable (no shadow collision)', () => {
    const d = doc({
      data: [
        {
          name: 'groups',
          items: [
            { title: 'G1', members: [{ n: 'a' }, { n: 'b' }] },
            { title: 'G2', members: [{ n: 'c' }] },
          ],
        },
      ],
      body: [
        node({
          id: 'group',
          tag: 'section',
          each: 'group in groups',
          children: [node({ id: 'member', tag: 'span', each: 'member in group.members', text: '{{ group.title }}:{{ member.n }}' })],
        }),
      ],
    })
    const tree = bakeDocument(d).tree
    expect(tree).toHaveLength(2)
    const g1Texts = tree[0]?.children.map((c) => c.text)
    const g2Texts = tree[1]?.children.map((c) => c.text)
    expect(g1Texts).toEqual(['G1:a', 'G1:b'])
    expect(g2Texts).toEqual(['G2:c'])
  })

  it('nested each with the default "item" binding: inner item shadows outer', () => {
    const d = doc({
      data: [
        {
          name: 'groups',
          items: [{ title: 'G1', members: [{ title: 'inner-a' }, { title: 'inner-b' }] }],
        },
      ],
      body: [
        node({
          id: 'group',
          tag: 'section',
          each: 'item in groups',
          children: [node({ id: 'member', tag: 'span', each: 'item in item.members', text: '{{ item.title }}' })],
        }),
      ],
    })
    const tree = bakeDocument(d).tree
    const innerTexts = tree[0]?.children.map((c) => c.text)
    expect(innerTexts).toEqual(['inner-a', 'inner-b'])
  })

  it('each over an undeclared data set reports unknown-ref and renders nothing', () => {
    const d = doc({ body: [node({ id: 'row', tag: 'li', each: 'item in missing', text: 'x' })] })
    const result = bakeDocument(d)
    expect(result.tree).toEqual([])
    expect(result.report.lines.some((l) => l.code === 'unknown-ref')).toBe(true)
  })

  it('each over a ref that is not a list reports each-source-not-list', () => {
    const d = doc({
      params: [{ name: 'notAList', type: 'string', default: 'nope' }],
      body: [node({ id: 'row', tag: 'li', each: 'item in param.notAList', text: 'x' })],
    })
    const result = bakeDocument(d)
    expect(result.tree).toEqual([])
    expect(result.report.lines.some((l) => l.code === 'each-source-not-list')).toBe(true)
  })

  it('a malformed each attribute reports expr-parse-error', () => {
    const d = doc({ body: [node({ id: 'row', tag: 'li', each: 'not valid syntax here !!', text: 'x' })] })
    const result = bakeDocument(d)
    expect(result.tree).toEqual([])
    expect(result.report.lines.some((l) => l.code === 'expr-parse-error')).toBe(true)
  })
})
