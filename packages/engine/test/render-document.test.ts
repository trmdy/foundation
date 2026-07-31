import { existsSync } from 'node:fs'
import { chromium } from 'playwright'
import { afterAll, describe, expect, it } from 'vitest'
import { closeBrowser } from '../src/render/browser.js'
import { renderDocument } from '../src/render/index.js'
import type { FdnDocument, FdnNode } from '../src/types.js'

function chromiumAvailable(): boolean {
  try {
    return existsSync(chromium.executablePath())
  } catch {
    return false
  }
}

const HAS_CHROMIUM = chromiumAvailable()

function node(overrides: Partial<FdnNode> & Pick<FdnNode, 'id' | 'tag'>): FdnNode {
  return { attrs: {}, style: {}, styleStates: {}, children: [], ...overrides }
}

function twoStatesOneViewportDoc(): FdnDocument {
  return {
    specVersion: '0.0.1-draft',
    tokens: { 'color-ink': '#111111' },
    params: [{ name: 'label', type: 'string', default: 'Hello' }],
    data: [],
    lookups: [],
    states: [
      { name: 's1', assignments: { label: 'One' } },
      { name: 's2', assignments: { label: 'Two' } },
    ],
    viewports: [{ name: 'vp1', width: 120, height: 80 }],
    matrix: [
      { state: 's1', viewport: 'vp1' },
      { state: 's2', viewport: 'vp1' },
    ],
    namedStyles: [],
    components: [],
    body: [
      node({
        id: 'title',
        tag: 'h1',
        text: '{{ param.label }}',
        style: { 'font-size': '16px', color: 'var(--color-ink)' },
      }),
    ],
  }
}

describe.skipIf(!HAS_CHROMIUM)('render: renderDocument', () => {
  afterAll(async () => {
    await closeBrowser()
  })

  it('renders one cell per matrix entry, keys layout by stable node id, and passes the bake report through', async () => {
    const doc = twoStatesOneViewportDoc()

    const results = await renderDocument(doc)

    expect(results).toHaveLength(2)
    expect(results.map((r) => r.state).sort()).toEqual(['s1', 's2'])

    for (const r of results) {
      expect(r.viewport).toEqual({ name: 'vp1', width: 120, height: 80 })
      expect(r.png.length).toBeGreaterThan(0)
      expect(r.layout.some((l) => l.id === 'title')).toBe(true)
      expect(Array.isArray(r.report.lines)).toBe(true)
    }
  }, 20000)

  it('opts.state / opts.viewport filter to a matrix subset', async () => {
    const doc = twoStatesOneViewportDoc()

    const results = await renderDocument(doc, { state: 's1', viewport: 'vp1' })

    expect(results).toHaveLength(1)
    expect(results[0]?.state).toBe('s1')
  }, 20000)

  it('falls back to default state at each declared viewport when the document has no matrix', async () => {
    const doc: FdnDocument = { ...twoStatesOneViewportDoc(), matrix: [] }

    const results = await renderDocument(doc)

    expect(results).toHaveLength(1)
    expect(results[0]?.state).toBeNull()
    expect(results[0]?.viewport).toEqual({ name: 'vp1', width: 120, height: 80 })
  }, 20000)
})
