import { describe, expect, it } from 'vitest'
import { bakeDocument } from '../src/bake/index.js'
import { emitHtml } from '../src/bake/emit.js'
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

describe('bake: emit', () => {
  it('leads with the derived-artifact comment', () => {
    const html = emitHtml(doc(), [])
    expect(html.startsWith('<!-- baked by foundation-engine — derived artifact, do not edit -->')).toBe(true)
  })

  it('emits a sorted :root token block', () => {
    const html = emitHtml(doc({ tokens: { 'z-token': '1px', 'a-token': '#fff' } }), [])
    expect(html).toContain(':root {\n  --a-token: #fff;\n  --z-token: 1px;\n}')
  })

  it('omits the style block entirely when there are no tokens', () => {
    const html = emitHtml(doc(), [])
    expect(html).not.toContain('<style>')
  })

  it('emits the title', () => {
    const html = emitHtml(doc({ title: 'My Doc' }), [])
    expect(html).toContain('<title>My Doc</title>')
  })

  it('indents nested elements by 2 spaces per depth', () => {
    const tree: FdnNode[] = [
      node({
        id: 'a',
        tag: 'div',
        children: [node({ id: 'b', tag: 'span', text: 'hi' })],
      }),
    ]
    const html = emitHtml(doc(), tree)
    expect(html).toContain('<div>\n  <span>hi</span>\n</div>')
  })

  it('sorts attributes alphabetically and appends a merged style attribute', () => {
    const tree: FdnNode[] = [node({ id: 'a', tag: 'div', attrs: { class: 'x', 'aria-label': 'y' }, style: { color: 'red', background: 'blue' } })]
    const html = emitHtml(doc(), tree)
    expect(html).toContain('<div aria-label="y" class="x" style="background:blue;color:red">')
  })

  it('renders void elements without a closing tag', () => {
    const tree: FdnNode[] = [node({ id: 'a', tag: 'br' })]
    const html = emitHtml(doc(), tree)
    expect(html).toContain('<br>')
    expect(html).not.toContain('</br>')
  })

  it('escapes text and attribute values', () => {
    const tree: FdnNode[] = [node({ id: 'a', tag: 'div', attrs: { title: 'a "quote" & <tag>' }, text: '<script>alert(1)</script> & stuff' })]
    const html = emitHtml(doc(), tree)
    expect(html).toContain('title="a &quot;quote&quot; &amp; &lt;tag&gt;"')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; stuff')
    expect(html).not.toContain('<script>')
  })

  it('an empty element with neither text nor children renders as an open/close pair on one line', () => {
    const tree: FdnNode[] = [node({ id: 'a', tag: 'div' })]
    const html = emitHtml(doc(), tree)
    expect(html).toContain('<div></div>')
  })
})

describe('bake: determinism', () => {
  it('baking the same doc + state twice yields byte-identical html', () => {
    const d = doc({
      tokens: { 'color-a': '#111', 'color-b': '#222' },
      params: [{ name: 'label', type: 'string', default: 'Hi' }],
      data: [{ name: 'rows', items: [{ n: 1 }, { n: 2 }, { n: 3 }] }],
      states: [{ name: 's1', assignments: { label: 'State label' } }],
      components: [
        {
          name: 'Row',
          props: [{ name: 'n', type: 'number', required: true }],
          slots: [],
          body: [node({ id: 'r', tag: 'span', text: '{{ prop.n }}' })],
        },
      ],
      body: [
        node({ id: 'title', tag: 'h1', text: '{{ param.label }}' }),
        node({ id: 'use', tag: 'fdn-use', each: 'item in rows', attrs: { component: 'Row', 'data-fdn-prop-n': '{{ item.n }}' } }),
      ],
    })

    const r1 = bakeDocument(d, { state: 's1' })
    const r2 = bakeDocument(d, { state: 's1' })
    expect(r1.html).toBe(r2.html)
    expect(r1.html.length).toBeGreaterThan(0)

    const r3 = bakeDocument(d)
    const r4 = bakeDocument(d)
    expect(r3.html).toBe(r4.html)
    expect(r3.html).not.toBe(r1.html)
  })
})
