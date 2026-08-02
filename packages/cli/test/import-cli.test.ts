/**
 * `foundation import <source.tsx> --into <file.fdn.html>` — unit/integration
 * coverage of the CLI command (API.md Wave 4 CLI section, item 1 of the
 * Stage 3 task brief). Exercises the merge semantics (add/replace by name,
 * lookup collision, node-id renumbering) and chain-commit wiring directly
 * against real vendored fixtures (packages/importer/fixtures) rather than
 * mocking the importer — the whole point of this wave is that the pieces
 * actually fit together end to end.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadChain, parseDocument, projectDocument, validateDocument } from 'foundation-engine'
import type { FdnNode } from 'foundation-engine'
import { captureIo } from '../src/io.js'
import { defaultAuthor } from '../src/identity.js'
import { runNew } from '../src/commands/new.js'
import { runImport } from '../src/commands/import.js'

const fixturesDir = path.resolve(import.meta.dirname, '../../importer/fixtures')
const fixture = (name: string): string => path.join(fixturesDir, name)

function allNodeIds(nodes: FdnNode[]): string[] {
  return nodes.flatMap((n) => [n.id, ...allNodeIds(n.children)])
}

describe('foundation import', () => {
  let dir: string
  let target: string
  let file: string
  let chainPath: string

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'fdn-cli-import-'))
    target = path.join(dir, 'board')
    file = `${target}.fdn.html`
    chainPath = `${file}.chain`
    await runNew([target], captureIo())
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('usage error when --into is missing (exit 2)', async () => {
    const io = captureIo()
    const code = await runImport([fixture('badge.tsx')], io)
    expect(code).toBe(2)
    expect(io.err.some((l) => l.includes('usage'))).toBe(true)
  })

  it('usage error when the source is missing (exit 2)', async () => {
    const io = captureIo()
    const code = await runImport(['--into', file], io)
    expect(code).toBe(2)
  })

  it('exit 2 when the target document does not exist', async () => {
    const io = captureIo()
    const code = await runImport([fixture('badge.tsx'), '--into', path.join(dir, 'nope.fdn.html')], io)
    expect(code).toBe(2)
    expect(io.err.some((l) => l.includes('could not read'))).toBe(true)
  })

  it('exit 2 on malformed --props JSON', async () => {
    const io = captureIo()
    const code = await runImport([fixture('badge.tsx'), '--into', file, '--props', '{not json'], io)
    expect(code).toBe(2)
    expect(io.err.some((l) => l.includes('--props'))).toBe(true)
  })

  it('imports badge.tsx natively: mode line, provenance line, component added, document validates clean', async () => {
    const io = captureIo()
    const code = await runImport([fixture('badge.tsx'), '--into', file], io)
    expect(code).toBe(0)
    expect(io.out.some((l) => l === 'mode: native')).toBe(true)
    expect(io.out.some((l) => l.startsWith('provenance: source=') && l.includes('sha256='))).toBe(true)
    expect(io.out.some((l) => l.includes('added component "Badge" (native)'))).toBe(true)

    const { doc } = parseDocument(readFileSync(file, 'utf8'))
    const badge = doc.components.find((c) => c.name === 'Badge')
    expect(badge).toBeDefined()
    expect(badge?.sealed).toBeUndefined()
    expect(doc.lookups.map((l) => l.name).sort()).toEqual(['BadgeLookup1', 'BadgeLookup2'])

    const result = validateDocument(doc)
    expect(result.issues).toStrictEqual([])
    expect(result.valid).toBe(true)
  })

  it('imports icon.tsx natively (pure-svg degenerate case)', async () => {
    const io = captureIo()
    const code = await runImport([fixture('icon.tsx'), '--into', file], io)
    expect(code).toBe(0)
    expect(io.out.some((l) => l === 'mode: native')).toBe(true)
    const { doc } = parseDocument(readFileSync(file, 'utf8'))
    expect(doc.components.find((c) => c.name === 'Icon')?.sealed).toBeUndefined()
  })

  it('card.tsx without a props override fails harvest with a structured schema-unresolvable error (exit 1)', async () => {
    const before = readFileSync(file, 'utf8')
    const io = captureIo()
    const code = await runImport([fixture('card.tsx'), '--into', file], io)
    expect(code).toBe(1)
    expect(io.err.some((l) => l.includes('schema-unresolvable'))).toBe(true)
    expect(io.err.some((l) => l.includes('children'))).toBe(true)
    // failed harvest must not touch the target document at all
    expect(readFileSync(file, 'utf8')).toBe(before)
  })

  it('card.tsx WITH a --props override for children imports natively', async () => {
    const io = captureIo()
    const code = await runImport(
      [fixture('card.tsx'), '--into', file, '--props', JSON.stringify([{ name: 'children', type: 'string' }])],
      io,
    )
    expect(code).toBe(0)
    expect(io.out.some((l) => l === 'mode: native')).toBe(true)
  })

  it('--name overrides the detected component name', async () => {
    const io = captureIo()
    const code = await runImport([fixture('badge.tsx'), '--into', file, '--name', 'MyBadge'], io)
    expect(code).toBe(0)
    expect(io.out.some((l) => l.includes('component "MyBadge"'))).toBe(true)
    const { doc } = parseDocument(readFileSync(file, 'utf8'))
    expect(doc.components.find((c) => c.name === 'MyBadge')).toBeDefined()
    expect(doc.components.find((c) => c.name === 'Badge')).toBeUndefined()
  })

  it('--sealed forces capsule mode even for a component that would otherwise project natively', async () => {
    const io = captureIo()
    const code = await runImport([fixture('badge.tsx'), '--into', file, '--sealed'], io)
    expect(code).toBe(0)
    expect(io.out.some((l) => l === 'mode: sealed')).toBe(true)
    const { doc } = parseDocument(readFileSync(file, 'utf8'))
    const badge = doc.components.find((c) => c.name === 'Badge')
    expect(badge?.sealed).toBeDefined()
    expect(badge?.body).toStrictEqual([])
  })

  it('button.tsx projects sealed on its own (prop interaction between variant/size and disabled)', async () => {
    const io = captureIo()
    const code = await runImport([fixture('button.tsx'), '--into', file], io)
    expect(code).toBe(0)
    expect(io.out.some((l) => l === 'mode: sealed')).toBe(true)
    expect(io.out.some((l) => l.includes('import-prop-interaction') || l.includes('import-sealed'))).toBe(true)
  })

  it('re-importing the same component by name REPLACES it, not duplicates it', async () => {
    await runImport([fixture('badge.tsx'), '--into', file], captureIo())
    const io = captureIo()
    const code = await runImport([fixture('badge.tsx'), '--into', file], io)
    expect(code).toBe(0)
    expect(io.out.some((l) => l.includes('replaced component "Badge"'))).toBe(true)
    const { doc } = parseDocument(readFileSync(file, 'utf8'))
    expect(doc.components.filter((c) => c.name === 'Badge')).toHaveLength(1)
  })

  it('importing two different components leaves every node id unique across the whole document', async () => {
    await runImport([fixture('badge.tsx'), '--into', file], captureIo())
    await runImport([fixture('icon.tsx'), '--into', file], captureIo())
    const { doc } = parseDocument(readFileSync(file, 'utf8'))
    const ids = [...allNodeIds(doc.body), ...doc.components.flatMap((c) => allNodeIds(c.body))]
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('repeated import of the SAME component is byte-identical on disk (determinism, no id drift)', async () => {
    await runImport([fixture('badge.tsx'), '--into', file], captureIo())
    const after1 = readFileSync(file, 'utf8')
    await runImport([fixture('badge.tsx'), '--into', file], captureIo())
    const after2 = readFileSync(file, 'utf8')
    expect(after2).toBe(after1)
  })

  it('a genuine lookup name collision (same generated name, different entries) errors with a hint (exit 1)', async () => {
    // Hand-seed a conflicting lookup under the exact name the importer would
    // generate for Badge's first lookup, so the merge step has to detect it.
    const { doc } = parseDocument(readFileSync(file, 'utf8'))
    doc.lookups.push({ name: 'BadgeLookup1', entries: { bogus: 'entry' } })
    writeFileSync(file, projectDocument(doc), 'utf8')

    const io = captureIo()
    const code = await runImport([fixture('badge.tsx'), '--into', file], io)
    expect(code).toBe(1)
    expect(io.err.some((l) => l.includes('lookup name collision') && l.includes('BadgeLookup1'))).toBe(true)
    // refused entirely — the document must be untouched
    const { doc: after } = parseDocument(readFileSync(file, 'utf8'))
    expect(after.components.find((c) => c.name === 'Badge')).toBeUndefined()
  })

  it('chain-commits with the documented message shape and default author when a chain exists', async () => {
    expect(existsSync(chainPath)).toBe(true)
    const io = captureIo()
    const code = await runImport([fixture('badge.tsx'), '--into', file], io)
    expect(code).toBe(0)
    expect(io.out.some((l) => l.includes(chainPath) && l.includes('committed'))).toBe(true)

    const chain = loadChain(readFileSync(chainPath))
    const entries = chain.log()
    const last = entries[entries.length - 1]
    expect(last?.message).toBe(`import Badge from ${fixture('badge.tsx')} (native)`)
    expect(last?.author).toBe(defaultAuthor())
    // the chain's own doc snapshot has no data-fdn-doc-id (that attribute
    // lives outside FdnDocument entirely — see docid.ts's module doc), so
    // compare content modulo that one CLI-stamped attribute rather than the
    // raw file bytes.
    expect(chain.doc().components.find((c) => c.name === 'Badge')).toBeDefined()
    const { doc: fileDoc } = parseDocument(readFileSync(file, 'utf8'))
    expect(projectDocument(chain.doc())).toBe(projectDocument(fileDoc))
  })

  it('--author overrides the default chain-commit author', async () => {
    const io = captureIo()
    const code = await runImport([fixture('badge.tsx'), '--into', file, '--author', 'user:someone@elsewhere'], io)
    expect(code).toBe(0)
    const chain = loadChain(readFileSync(chainPath))
    const entries = chain.log()
    expect(entries[entries.length - 1]?.author).toBe('user:someone@elsewhere')
  })

  it('does not attempt a chain commit when no chain exists next to the target', async () => {
    const noChainTarget = path.join(dir, 'nochain')
    await runNew([noChainTarget, '--no-chain'], captureIo())
    const noChainFile = `${noChainTarget}.fdn.html`
    expect(existsSync(`${noChainFile}.chain`)).toBe(false)

    const io = captureIo()
    const code = await runImport([fixture('badge.tsx'), '--into', noChainFile], io)
    expect(code).toBe(0)
    expect(io.out.some((l) => l.includes('committed'))).toBe(false)
    expect(existsSync(`${noChainFile}.chain`)).toBe(false)
  })

  it('a no-op re-import (identical content) reports "no changes to commit" rather than an empty envelope', async () => {
    await runImport([fixture('badge.tsx'), '--into', file], captureIo())
    const chainBefore = loadChain(readFileSync(chainPath)).log().length

    const io = captureIo()
    await runImport([fixture('badge.tsx'), '--into', file], io)
    expect(io.out.some((l) => l.includes('no changes to commit'))).toBe(true)
    const chainAfter = loadChain(readFileSync(chainPath)).log().length
    expect(chainAfter).toBe(chainBefore)
  })

  describe('theme vars become document tokens (follow-up wave)', () => {
    it('badge.tsx import declares its Tailwind theme vars as doc.tokens, keyed without the leading --', async () => {
      const io = captureIo()
      const code = await runImport([fixture('badge.tsx'), '--into', file], io)
      expect(code).toBe(0)
      expect(io.out.some((l) => l.startsWith('info import-theme-token'))).toBe(true)

      const { doc } = parseDocument(readFileSync(file, 'utf8'))
      expect(doc.tokens['color-green-100']).toBe('oklch(96.2% 0.044 156.743)')
      expect(doc.tokens['color-green-800']).toBeDefined()
      expect(doc.tokens['color-amber-100']).toBeDefined()
      expect(doc.tokens['color-blue-100']).toBeDefined()
      expect(doc.tokens['font-weight-semibold']).toBe('600')
      // the scaffold's own token must survive untouched
      expect(doc.tokens['color-accent']).toBe('#B8860B')
    })

    it('reports import-unresolved-theme-var for vars with no theme definition (e.g. --tw-leading), leaving them unset', async () => {
      const io = captureIo()
      await runImport([fixture('badge.tsx'), '--into', file], io)
      expect(io.out.some((l) => l.includes('import-unresolved-theme-var') && l.includes('--tw-leading'))).toBe(true)
      const { doc } = parseDocument(readFileSync(file, 'utf8'))
      expect(doc.tokens['tw-leading']).toBeUndefined()
    })

    it('an existing token with the SAME value merges silently (no conflict report, no change)', async () => {
      const { doc } = parseDocument(readFileSync(file, 'utf8'))
      doc.tokens['color-green-100'] = 'oklch(96.2% 0.044 156.743)'
      writeFileSync(file, projectDocument(doc), 'utf8')

      const io = captureIo()
      const code = await runImport([fixture('badge.tsx'), '--into', file], io)
      expect(code).toBe(0)
      expect(io.out.some((l) => l.includes('import-token-conflict'))).toBe(false)
      const { doc: after } = parseDocument(readFileSync(file, 'utf8'))
      expect(after.tokens['color-green-100']).toBe('oklch(96.2% 0.044 156.743)')
    })

    it('an existing token with a DIFFERENT value wins over the import, with a warning report (document wins)', async () => {
      const { doc } = parseDocument(readFileSync(file, 'utf8'))
      doc.tokens['color-green-100'] = '#00ff00'
      writeFileSync(file, projectDocument(doc), 'utf8')

      const io = captureIo()
      const code = await runImport([fixture('badge.tsx'), '--into', file], io)
      expect(code).toBe(0)
      expect(io.out.some((l) => l.includes('warning import-token-conflict') && l.includes('color-green-100'))).toBe(true)
      const { doc: after } = parseDocument(readFileSync(file, 'utf8'))
      expect(after.tokens['color-green-100']).toBe('#00ff00')
      // the import still succeeds — a token conflict is a warning, not a failure
      expect(after.components.find((c) => c.name === 'Badge')).toBeDefined()
    })

    it('does not break "repeated import is byte-identical" determinism', async () => {
      await runImport([fixture('badge.tsx'), '--into', file], captureIo())
      const after1 = readFileSync(file, 'utf8')
      await runImport([fixture('badge.tsx'), '--into', file], captureIo())
      const after2 = readFileSync(file, 'utf8')
      expect(after2).toBe(after1)
    })
  })
})
