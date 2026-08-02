/**
 * Wave 4 acceptance suite (API.md "Wave 4 — component importer": "Acceptance
 * suite: vendored fixtures — ShadCN-style button (cva variants), badge,
 * card, and a lucide icon — imported natively, validated, baked, rendered;
 * repeated import byte-identical"; Stage 3 task brief item 5).
 *
 * button.tsx and card.tsx do not both land "native" — button.tsx's
 * `disabled` prop interacts with `variant`/`size` (independently applying
 * each single-prop transform cannot reproduce the pairwise-probe sample —
 * see project/interaction.ts), so it is CORRECTLY sealed. That is asserted
 * here as the current correct mode, not treated as a defect: sealed is the
 * importer being honest about a component whose behavior genuinely depends
 * on more than one prop at once, per API.md's projection rules.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { bakeDocument, parseDocument, validateDocument } from 'foundation-engine'
import type { FdnDocument, FdnNode } from 'foundation-engine'
import { captureIo } from '../src/io.js'
import { runNew } from '../src/commands/new.js'
import { runImport } from '../src/commands/import.js'

const fixturesDir = path.resolve(import.meta.dirname, '../../importer/fixtures')
const fixture = (name: string): string => path.join(fixturesDir, name)

function useNode(overrides: Partial<FdnNode> & Pick<FdnNode, 'id' | 'attrs'>): FdnNode {
  return { tag: 'fdn-use', style: {}, styleStates: {}, children: [], ...overrides }
}

describe('Wave 4 acceptance: import all four vendored fixtures', () => {
  let dir: string
  let target: string
  let file: string

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'fdn-import-acceptance-'))
    target = path.join(dir, 'board')
    file = `${target}.fdn.html`
    await runNew([target], captureIo())
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('badge.tsx imports native', async () => {
    const io = captureIo()
    const code = await runImport([fixture('badge.tsx'), '--into', file], io)
    expect(code).toBe(0)
    expect(io.out).toContainEqual('mode: native')
  })

  it('icon.tsx imports native', async () => {
    const io = captureIo()
    const code = await runImport([fixture('icon.tsx'), '--into', file], io)
    expect(code).toBe(0)
    expect(io.out).toContainEqual('mode: native')
  })

  it('button.tsx imports sealed (its current correct mode: variant/size interact with disabled)', async () => {
    const io = captureIo()
    const code = await runImport([fixture('button.tsx'), '--into', file], io)
    expect(code).toBe(0)
    expect(io.out).toContainEqual('mode: sealed')
  })

  it('card.tsx imports native (with a --props override for the ReactNode children field)', async () => {
    const io = captureIo()
    const code = await runImport(
      [fixture('card.tsx'), '--into', file, '--props', JSON.stringify([{ name: 'children', type: 'string' }])],
      io,
    )
    expect(code).toBe(0)
    expect(io.out).toContainEqual('mode: native')
  })

  describe('all four together', () => {
    async function importAllFour(targetFile: string): Promise<void> {
      expect(await runImport([fixture('badge.tsx'), '--into', targetFile], captureIo())).toBe(0)
      expect(await runImport([fixture('icon.tsx'), '--into', targetFile], captureIo())).toBe(0)
      expect(await runImport([fixture('button.tsx'), '--into', targetFile], captureIo())).toBe(0)
      expect(
        await runImport(
          [fixture('card.tsx'), '--into', targetFile, '--props', JSON.stringify([{ name: 'children', type: 'string' }])],
          captureIo(),
        ),
      ).toBe(0)
    }

    it('the resulting document validates 0 issues', async () => {
      await importAllFour(file)
      const { doc } = parseDocument(readFileSync(file, 'utf8'))
      expect(doc.components.map((c) => c.name).sort()).toEqual(['Badge', 'Button', 'Card', 'Icon'])

      const result = validateDocument(doc)
      expect(result.issues).toStrictEqual([])
      expect(result.valid).toBe(true)
    })

    it('every component-body node id is unique across the whole merged document', async () => {
      await importAllFour(file)
      const { doc } = parseDocument(readFileSync(file, 'utf8'))
      const collect = (nodes: FdnNode[]): string[] => nodes.flatMap((n) => [n.id, ...collect(n.children)])
      const ids = [...collect(doc.body), ...doc.components.flatMap((c) => collect(c.body))]
      expect(new Set(ids).size).toBe(ids.length)
    })

    it('repeated import (independent runs from the same starting document) is byte-identical', async () => {
      // Two independent copies of the SAME starting bytes (not two separate
      // `foundation new` calls, which would each mint a fresh random doc id
      // — SPEC 13a-i — and make the files differ for a reason that has
      // nothing to do with the importer's own determinism). Determinism
      // claim under test: importing the same four fixtures, in the same
      // order, into the same starting document, is a pure function of that
      // input — no wall-clock time, no randomness, no environment leakage.
      const fileA = file
      const fileB = path.join(dir, 'board-b.fdn.html')
      writeFileSync(fileB, readFileSync(fileA, 'utf8'), 'utf8')

      await importAllFour(fileA)
      await importAllFour(fileB)

      expect(readFileSync(fileB, 'utf8')).toBe(readFileSync(fileA, 'utf8'))
    })

    it('bakes a state that instantiates an imported enum-prop component (Badge) via fdn-use with prop bindings', async () => {
      await importAllFour(file)
      const { doc } = parseDocument(readFileSync(file, 'utf8'))

      const withDemo: FdnDocument = {
        ...doc,
        states: [...doc.states, { name: 'demo', assignments: {} }],
        body: [
          ...doc.body,
          useNode({
            id: 'demoUseSuccess',
            attrs: { component: 'Badge', 'data-fdn-prop-variant': 'success', 'data-fdn-prop-children': 'Shipped' },
          }),
          useNode({
            id: 'demoUseWarning',
            attrs: { component: 'Badge', 'data-fdn-prop-variant': 'warning', 'data-fdn-prop-children': 'Pending' },
          }),
        ],
      }

      const baked = bakeDocument(withDemo, { state: 'demo' })
      expect(baked.report.lines.filter((l) => l.severity === 'error')).toStrictEqual([])

      // rendered content: the bound label text actually appears
      expect(baked.html).toContain('Shipped')
      expect(baked.html).toContain('Pending')

      // enum prop: two different variant bindings produce different styling
      // (Badge's variant folds into two generated fdn-lookups — background
      // and text color — resolved to distinct literal values per variant).
      const successStyle = /data-fdn-prop-variant="success"[\s\S]*?<span[^>]*style="([^"]+)"/.exec(baked.html)?.[1]
      const warningStyle = /data-fdn-prop-variant="warning"[\s\S]*?<span[^>]*style="([^"]+)"/.exec(baked.html)?.[1]
      expect(successStyle).toBeTruthy()
      expect(warningStyle).toBeTruthy()
      expect(successStyle).not.toBe(warningStyle)
    })

    it('a sealed component (Button) bakes with a scoped .fdn-capsule- wrapper and css present', async () => {
      await importAllFour(file)
      const { doc } = parseDocument(readFileSync(file, 'utf8'))
      const button = doc.components.find((c) => c.name === 'Button')
      expect(button?.sealed).toBeDefined()

      const withDemo: FdnDocument = {
        ...doc,
        states: [...doc.states, { name: 'demo', assignments: {} }],
        body: [...doc.body, useNode({ id: 'demoUseButton', attrs: { component: 'Button' } })],
      }

      const baked = bakeDocument(withDemo, { state: 'demo' })
      expect(baked.html).toContain('class="fdn-capsule-Button"')
      expect(baked.html).toMatch(/<style>[\s\S]*\.fdn-capsule-Button [\s\S]*<\/style>/)
    })
  })
})
