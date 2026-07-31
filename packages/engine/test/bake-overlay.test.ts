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

describe('bake: fdn-overlay', () => {
  it('an overlay with no trigger and no when is baked open by default', () => {
    const d = doc({
      body: [
        node({
          id: 'dlg',
          tag: 'fdn-overlay',
          attrs: { 'data-fdn-role': 'dialog' },
          children: [node({ id: 'panel', tag: 'div', text: 'hello' })],
        }),
      ],
    })
    const result = bakeDocument(d)
    expect(result.tree).toHaveLength(1)
    expect(result.tree[0]?.tag).toBe('fdn-overlay')
    expect(result.report.lines).toEqual([])
  })

  it('a trigger-bound overlay with no when is excluded and reports trigger-overlay-skipped', () => {
    const d = doc({
      body: [
        node({
          id: 'tip',
          tag: 'fdn-overlay',
          attrs: { 'data-fdn-role': 'tooltip', 'data-fdn-trigger': 'hover:title-1' },
          children: [node({ id: 'pill', tag: 'div', text: 'tooltip text' })],
        }),
      ],
    })
    const result = bakeDocument(d)
    expect(result.tree).toEqual([])
    const line = result.report.lines.find((l) => l.code === 'trigger-overlay-skipped')
    expect(line).toBeDefined()
    expect(line?.nodeId).toBe('tip')
  })

  it('a trigger-bound overlay with a when that evaluates true is included', () => {
    const d = doc({
      params: [{ name: 'tooltipVisible', type: 'boolean', default: true }],
      body: [
        node({
          id: 'tip',
          tag: 'fdn-overlay',
          attrs: { 'data-fdn-role': 'tooltip', 'data-fdn-trigger': 'hover:title-1' },
          when: 'param.tooltipVisible',
          children: [node({ id: 'pill', tag: 'div', text: 'tooltip text' })],
        }),
      ],
    })
    const result = bakeDocument(d)
    expect(result.tree).toHaveLength(1)
    expect(result.report.lines.some((l) => l.code === 'trigger-overlay-skipped')).toBe(false)
  })

  it('a trigger-bound overlay with a when that evaluates false is dropped (ordinary when semantics, no trigger-overlay-skipped line)', () => {
    const d = doc({
      params: [{ name: 'tooltipVisible', type: 'boolean', default: false }],
      body: [
        node({
          id: 'tip',
          tag: 'fdn-overlay',
          attrs: { 'data-fdn-role': 'tooltip', 'data-fdn-trigger': 'hover:title-1' },
          when: 'param.tooltipVisible',
          children: [node({ id: 'pill', tag: 'div', text: 'tooltip text' })],
        }),
      ],
    })
    const result = bakeDocument(d)
    expect(result.tree).toEqual([])
    expect(result.report.lines.some((l) => l.code === 'trigger-overlay-skipped')).toBe(false)
  })
})
