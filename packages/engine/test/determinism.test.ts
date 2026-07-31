import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseDocument } from '../src/parse/index.js'
import { projectDocument } from '../src/project/index.js'

const boardsDir = fileURLToPath(new URL('../../../boards/', import.meta.url))

function wrap(bodyHtml: string): string {
  return `<!DOCTYPE html><html><head><style>:root{--x:1px}</style></head><body><main>${bodyHtml}</main></body></html>`
}

describe('determinism: parsing the same input twice yields identical documents', () => {
  it('holds for a synthetic fixture with unminted ids', () => {
    const html = wrap('<div class="a"><span>one</span><span when="param.x">two</span></div>')
    const { doc: a } = parseDocument(html)
    const { doc: b } = parseDocument(html)
    expect(b).toStrictEqual(a)
  })

  it('holds for each board fixture, including minted data-fdn-id values', () => {
    for (const name of ['system-help-center', 'overlay-evidence', 'inbox-unified']) {
      const html = readFileSync(`${boardsDir}${name}.fdn.html`, 'utf8')
      const { doc: a } = parseDocument(html)
      const { doc: b } = parseDocument(html)
      expect(b).toStrictEqual(a)

      // id minting is a pure function of input text, order-stable
      const idsA = collectIds(a.body)
      const idsB = collectIds(b.body)
      expect(idsB).toEqual(idsA)
      // ids are unique within a parse
      expect(new Set(idsA).size).toBe(idsA.length)
    }
  })

  it('produces the same projected text on repeated calls (project is a pure function)', () => {
    const html = readFileSync(`${boardsDir}overlay-evidence.fdn.html`, 'utf8')
    const { doc } = parseDocument(html)
    expect(projectDocument(doc)).toBe(projectDocument(doc))
  })
})

interface WithChildren {
  id: string
  children: WithChildren[]
}

function collectIds(nodes: WithChildren[]): string[] {
  const out: string[] = []
  for (const n of nodes) {
    out.push(n.id)
    out.push(...collectIds(n.children))
  }
  return out
}
