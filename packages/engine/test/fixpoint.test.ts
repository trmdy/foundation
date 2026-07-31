import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseDocument } from '../src/parse/index.js'
import { projectDocument } from '../src/project/index.js'

const boardsDir = fileURLToPath(new URL('../../../boards/', import.meta.url))

const BOARDS = ['system-help-center', 'overlay-evidence', 'inbox-unified']

describe('parse/project fixpoint (API.md: "project(doc) MUST be a fixpoint with parse")', () => {
  for (const name of BOARDS) {
    describe(name, () => {
      const html = readFileSync(`${boardsDir}${name}.fdn.html`, 'utf8')

      it('parse -> project -> parse yields a deep-equal document', () => {
        const { doc: doc0 } = parseDocument(html)
        const text1 = projectDocument(doc0)
        const { doc: doc1 } = parseDocument(text1)
        expect(doc1).toStrictEqual(doc0)
      })

      it('project(parse(project(parse(x)))) === project(parse(x)) byte-for-byte', () => {
        const { doc: doc0 } = parseDocument(html)
        const text1 = projectDocument(doc0)
        const { doc: doc1 } = parseDocument(text1)
        const text2 = projectDocument(doc1)
        expect(text2).toBe(text1)
      })

      it('projected text is well-formed enough to re-parse without throwing', () => {
        const { doc } = parseDocument(html)
        expect(() => projectDocument(doc)).not.toThrow()
      })

      it('projected text has LF endings, a single trailing newline, and no trailing whitespace', () => {
        const { doc } = parseDocument(html)
        const text = projectDocument(doc)
        expect(text.includes('\r')).toBe(false)
        expect(text.endsWith('\n')).toBe(true)
        expect(text.endsWith('\n\n')).toBe(false)
        for (const line of text.split('\n')) {
          expect(line).toBe(line.replace(/[ \t]+$/, ''))
        }
      })
    })
  }

  it('is a fixpoint starting from the ALREADY-canonical text too (project idempotent past round 1)', () => {
    const { doc: doc0 } = parseDocument(readFileSync(`${boardsDir}system-help-center.fdn.html`, 'utf8'))
    const canonical = projectDocument(doc0)
    const { doc: doc1 } = parseDocument(canonical)
    const canonical2 = projectDocument(doc1)
    expect(canonical2).toBe(canonical)
    const { doc: doc2 } = parseDocument(canonical2)
    expect(doc2).toStrictEqual(doc1)
  })
})
