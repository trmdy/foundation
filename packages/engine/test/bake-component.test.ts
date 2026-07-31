import { describe, expect, it } from 'vitest'
import { bakeDocument } from '../src/bake/index.js'
import type { FdnComponent, FdnDocument, FdnNode } from '../src/types.js'

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

describe('bake: component instantiation', () => {
  it('binds string/boolean/number/list props and interpolates the body', () => {
    const badge: FdnComponent = {
      name: 'Badge',
      props: [
        { name: 'label', type: 'string', required: true },
        { name: 'active', type: 'boolean', default: false },
        { name: 'count', type: 'number', default: 0 },
        { name: 'tags', type: 'list', default: [] },
      ],
      slots: [],
      body: [
        node({
          id: 'root',
          tag: 'span',
          text: '{{ prop.label }}:{{ prop.active }}:{{ prop.count }}',
        }),
      ],
    }
    const d = doc({
      components: [badge],
      body: [
        node({
          id: 'use1',
          tag: 'fdn-use',
          attrs: {
            component: 'Badge',
            'data-fdn-prop-label': 'Ready',
            'data-fdn-prop-active': 'true',
            'data-fdn-prop-count': '7',
            'data-fdn-prop-tags': '["a","b"]',
          },
        }),
      ],
    })
    const result = bakeDocument(d)
    expect(result.report.lines).toEqual([])
    const use = result.tree[0] as FdnNode
    expect(use.tag).toBe('fdn-use')
    expect(use.attrs['component']).toBe('Badge')
    expect(use.attrs['data-fdn-prop-label']).toBe('Ready')
    expect(use.attrs['data-fdn-prop-active']).toBe('true')
    expect(use.attrs['data-fdn-prop-count']).toBe('7')
    expect(use.attrs['data-fdn-prop-tags']).toBe('["a","b"]')
    expect(use.children[0]?.text).toBe('Ready:true:7')
  })

  it('unbound props with a declared default fall back to it', () => {
    const c: FdnComponent = {
      name: 'C',
      props: [{ name: 'label', type: 'string', default: 'fallback' }],
      slots: [],
      body: [node({ id: 'root', tag: 'span', text: '{{ prop.label }}' })],
    }
    const d = doc({ components: [c], body: [node({ id: 'use1', tag: 'fdn-use', attrs: { component: 'C' } })] })
    const result = bakeDocument(d)
    expect(result.tree[0]?.children[0]?.text).toBe('fallback')
    expect(result.report.lines).toEqual([])
  })

  it('unbound props with no default bake empty and report prop-missing-default', () => {
    const c: FdnComponent = {
      name: 'C',
      props: [{ name: 'label', type: 'string', required: true }],
      slots: [],
      body: [node({ id: 'root', tag: 'span', text: '{{ prop.label }}' })],
    }
    const d = doc({ components: [c], body: [node({ id: 'use1', tag: 'fdn-use', attrs: { component: 'C' } })] })
    const result = bakeDocument(d)
    expect(result.tree[0]?.children[0]?.text).toBe('')
    expect(result.report.lines.some((l) => l.code === 'prop-missing-default')).toBe(true)
  })

  it('fills a named slot from fdn-fill children', () => {
    const card: FdnComponent = {
      name: 'Card',
      props: [],
      slots: ['body'],
      body: [node({ id: 'wrap', tag: 'div', children: [node({ id: 'slot', tag: 'fdn-slot', attrs: { name: 'body' } })] })],
    }
    const d = doc({
      components: [card],
      body: [
        node({
          id: 'use1',
          tag: 'fdn-use',
          attrs: { component: 'Card' },
          children: [
            node({
              id: 'fill1',
              tag: 'fdn-fill',
              attrs: { slot: 'body' },
              children: [node({ id: 'p1', tag: 'p', text: 'filled content' })],
            }),
          ],
        }),
      ],
    })
    const result = bakeDocument(d)
    const wrap = result.tree[0]?.children[0]
    expect(wrap?.tag).toBe('div')
    expect(wrap?.children[0]?.tag).toBe('p')
    expect(wrap?.children[0]?.text).toBe('filled content')
  })

  it('an empty slot falls back to its own default content', () => {
    const card: FdnComponent = {
      name: 'Card',
      props: [],
      slots: ['body'],
      body: [
        node({
          id: 'wrap',
          tag: 'div',
          children: [node({ id: 'slot', tag: 'fdn-slot', attrs: { name: 'body' }, children: [node({ id: 'def', tag: 'em', text: 'default text' })] })],
        }),
      ],
    }
    const d = doc({ components: [card], body: [node({ id: 'use1', tag: 'fdn-use', attrs: { component: 'Card' } })] })
    const result = bakeDocument(d)
    const wrap = result.tree[0]?.children[0]
    expect(wrap?.children[0]?.tag).toBe('em')
    expect(wrap?.children[0]?.text).toBe('default text')
  })

  it('slot fill content interpolates against the caller scope, not the component scope', () => {
    const card: FdnComponent = {
      name: 'Card',
      props: [{ name: 'unrelated', type: 'string', default: 'x' }],
      slots: ['body'],
      body: [node({ id: 'wrap', tag: 'div', children: [node({ id: 'slot', tag: 'fdn-slot', attrs: { name: 'body' } })] })],
    }
    const d = doc({
      params: [{ name: 'callerVal', type: 'string', default: 'from-caller' }],
      components: [card],
      body: [
        node({
          id: 'use1',
          tag: 'fdn-use',
          attrs: { component: 'Card' },
          children: [
            node({
              id: 'fill1',
              tag: 'fdn-fill',
              attrs: { slot: 'body' },
              children: [node({ id: 'p1', tag: 'p', text: '{{ param.callerVal }}' })],
            }),
          ],
        }),
      ],
    })
    const result = bakeDocument(d)
    const wrap = result.tree[0]?.children[0]
    expect(wrap?.children[0]?.text).toBe('from-caller')
  })

  it('components may use components (nesting)', () => {
    const inner: FdnComponent = {
      name: 'Inner',
      props: [{ name: 'text', type: 'string', required: true }],
      slots: [],
      body: [node({ id: 'i', tag: 'b', text: '{{ prop.text }}' })],
    }
    const outer: FdnComponent = {
      name: 'Outer',
      props: [],
      slots: [],
      body: [node({ id: 'use-inner', tag: 'fdn-use', attrs: { component: 'Inner', 'data-fdn-prop-text': 'nested!' } })],
    }
    const d = doc({ components: [inner, outer], body: [node({ id: 'use1', tag: 'fdn-use', attrs: { component: 'Outer' } })] })
    const result = bakeDocument(d)
    expect(result.report.lines).toEqual([])
    const outerUse = result.tree[0] as FdnNode
    const innerUse = outerUse.children[0] as FdnNode
    expect(innerUse.tag).toBe('fdn-use')
    expect(innerUse.attrs['component']).toBe('Inner')
    expect(innerUse.children[0]?.text).toBe('nested!')
  })

  it('a direct self-recursive component is cycle-guarded: reports component-cycle and renders nothing for the inner recurrence', () => {
    const selfRef: FdnComponent = {
      name: 'SelfRef',
      props: [],
      slots: [],
      body: [node({ id: 'wrap', tag: 'div', children: [node({ id: 'recurse', tag: 'fdn-use', attrs: { component: 'SelfRef' } })] })],
    }
    const d = doc({ components: [selfRef], body: [node({ id: 'use1', tag: 'fdn-use', attrs: { component: 'SelfRef' } })] })
    const result = bakeDocument(d)
    expect(result.report.lines.some((l) => l.code === 'component-cycle')).toBe(true)
    const outer = result.tree[0] as FdnNode
    const div = outer.children[0] as FdnNode
    // the inner fdn-use recurrence renders nothing
    expect(div.children).toEqual([])
  })

  it('an undeclared component reports component-not-found and renders nothing', () => {
    const d = doc({ body: [node({ id: 'use1', tag: 'fdn-use', attrs: { component: 'Ghost' } })] })
    const result = bakeDocument(d)
    expect(result.tree).toEqual([])
    expect(result.report.lines.some((l) => l.code === 'component-not-found')).toBe(true)
  })

  it('component instance ids are namespaced per use-site so repeated uses do not collide', () => {
    const badge: FdnComponent = {
      name: 'Badge',
      props: [],
      slots: [],
      body: [node({ id: 'root', tag: 'span', text: 'x' })],
    }
    const d = doc({
      components: [badge],
      body: [
        node({ id: 'use1', tag: 'fdn-use', attrs: { component: 'Badge' } }),
        node({ id: 'use2', tag: 'fdn-use', attrs: { component: 'Badge' } }),
      ],
    })
    const result = bakeDocument(d)
    const id1 = result.tree[0]?.children[0]?.id
    const id2 = result.tree[1]?.children[0]?.id
    expect(id1).not.toBe(id2)
  })
})
