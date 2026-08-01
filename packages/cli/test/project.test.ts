import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { captureIo } from '../src/io.js'
import { runNew } from '../src/commands/new.js'
import { runProject } from '../src/commands/project.js'
import type { ProjectManifest } from '../src/project.js'

describe('foundation project (SPEC 13a-iii manifest)', () => {
  let dir: string
  let cwd: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fdn-cli-project-'))
    cwd = process.cwd()
  })

  afterEach(() => {
    process.chdir(cwd)
    rmSync(dir, { recursive: true, force: true })
  })

  function manifest(d: string = dir): ProjectManifest {
    return JSON.parse(readFileSync(join(d, 'foundation.json'), 'utf8')) as ProjectManifest
  }

  describe('project init', () => {
    it('writes a schema-1 manifest with a fresh id, empty documents, and name defaulting to the dir name', async () => {
      const io = captureIo()
      const code = await runProject(['init', dir], io)
      expect(code).toBe(0)
      expect(existsSync(join(dir, 'foundation.json'))).toBe(true)

      const m = manifest()
      expect(m.schema).toBe(1)
      expect(typeof m.id).toBe('string')
      expect(m.id.length).toBeGreaterThan(0)
      expect(m.name).toBe(basename(dir))
      expect(m.documents).toEqual([])
    })

    it('accepts --name to override the default', async () => {
      const code = await runProject(['init', dir, '--name', 'apiary-explorations'], captureIo())
      expect(code).toBe(0)
      expect(manifest().name).toBe('apiary-explorations')
    })

    it('refuses to overwrite an existing manifest (exit 2)', async () => {
      await runProject(['init', dir], captureIo())
      const before = manifest()

      const io = captureIo()
      const code = await runProject(['init', dir], io)
      expect(code).toBe(2)
      expect(io.err.some((l) => l.includes('already exists'))).toBe(true)
      expect(manifest()).toEqual(before)
    })

    it('mints a different id on each init (two different directories)', async () => {
      const dir2 = mkdtempSync(join(tmpdir(), 'fdn-cli-project-2-'))
      await runProject(['init', dir], captureIo())
      await runProject(['init', dir2], captureIo())
      expect(manifest(dir).id).not.toBe(manifest(dir2).id)
      rmSync(dir2, { recursive: true, force: true })
    })
  })

  describe('project add', () => {
    beforeEach(async () => {
      await runProject(['init', dir], captureIo())
      process.chdir(dir)
    })

    it('registers a chain-tracked document by its stamped doc id', async () => {
      await runNew(['widget'], captureIo())
      const io = captureIo()
      const code = await runProject(['add', 'widget.fdn.html'], io)
      expect(code).toBe(0)
      expect(io.out.some((l) => l.startsWith('added widget.fdn.html'))).toBe(true)

      const m = manifest()
      expect(m.documents).toHaveLength(1)
      expect(m.documents[0]?.path).toBe('widget.fdn.html')
      const source = readFileSync('widget.fdn.html', 'utf8')
      const stampedId = /data-fdn-doc-id="([^"]*)"/.exec(source)?.[1]
      expect(m.documents[0]?.docId).toBe(stampedId)
    })

    it('is idempotent by docId: adding the same file twice does not duplicate the entry', async () => {
      await runNew(['widget'], captureIo())
      await runProject(['add', 'widget.fdn.html'], captureIo())
      const io = captureIo()
      const code = await runProject(['add', 'widget.fdn.html'], io)
      expect(code).toBe(0)
      expect(io.out.some((l) => l.startsWith('already registered'))).toBe(true)
      expect(manifest().documents).toHaveLength(1)
    })

    it('errors with a hint when the document has no doc id (no chain, no stamped attribute)', async () => {
      writeFileSync(
        'bare.fdn.html',
        '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"></head><body>'
          + '<fdn-doc hidden data-fdn-spec-version="0.0.1-draft"></fdn-doc>'
          + '<main><h1 data-fdn-id="n1">Bare</h1></main></body></html>\n',
        'utf8',
      )
      const io = captureIo()
      const code = await runProject(['add', 'bare.fdn.html'], io)
      expect(code).toBe(1)
      expect(io.err.some((l) => l.includes('no document id found'))).toBe(true)
      expect(manifest().documents).toHaveLength(0)
    })

    it('errors when no manifest exists yet (exit 2)', async () => {
      rmSync(join(dir, 'foundation.json'))
      await runNew(['widget'], captureIo())
      const io = captureIo()
      const code = await runProject(['add', 'widget.fdn.html'], io)
      expect(code).toBe(2)
      expect(io.err.some((l) => l.includes('foundation project init'))).toBe(true)
    })
  })

  describe('project list', () => {
    beforeEach(async () => {
      await runProject(['init', dir], captureIo())
      process.chdir(dir)
    })

    it('prints "ok" and the chain head for a clean, chain-tracked document', async () => {
      await runNew(['widget'], captureIo())
      await runProject(['add', 'widget.fdn.html'], captureIo())

      const io = captureIo()
      const code = await runProject(['list', dir], io)
      expect(code).toBe(0)
      const line = io.out.find((l) => l.includes('widget.fdn.html'))
      expect(line).toBeDefined()
      expect(line).toContain('ok')
      expect(line).toMatch(/chain [0-9a-f]{12}/)
    })

    it('reports "no chain" for a manifest entry whose file has no sibling .chain', async () => {
      await runNew(['widget', '--no-chain'], captureIo())
      // no chain, so add must fall back to a stamped id — runNew always
      // stamps data-fdn-doc-id regardless of --no-chain.
      await runProject(['add', 'widget.fdn.html'], captureIo())

      const io = captureIo()
      await runProject(['list', dir], io)
      const line = io.out.find((l) => l.includes('widget.fdn.html'))
      expect(line).toContain('no chain')
    })

    it('reports issue counts for a document with validation errors, and exits 1', async () => {
      await runNew(['widget'], captureIo())
      await runProject(['add', 'widget.fdn.html'], captureIo())
      const broken = readFileSync('widget.fdn.html', 'utf8').replace('Card', 'DoesNotExist')
      writeFileSync('widget.fdn.html', broken, 'utf8')

      const io = captureIo()
      const code = await runProject(['list', dir], io)
      expect(code).toBe(1)
      const line = io.out.find((l) => l.includes('widget.fdn.html'))
      expect(line).toMatch(/\d+ issue\(s\)/)
    })

    it('errors when no manifest exists (exit 2)', async () => {
      const io = captureIo()
      const code = await runProject(['list', join(dir, 'nope')], io)
      expect(code).toBe(2)
    })
  })

  describe('project scan', () => {
    beforeEach(async () => {
      await runProject(['init', dir], captureIo())
    })

    it('discovers *.fdn.html files not yet registered and adds them', async () => {
      await runNew([join(dir, 'a')], captureIo())
      mkdirSync(join(dir, 'sub'), { recursive: true })
      await runNew([join(dir, 'sub', 'b')], captureIo())

      const io = captureIo()
      const code = await runProject(['scan', dir], io)
      expect(code).toBe(0)
      expect(io.out.some((l) => l.startsWith('added a.fdn.html'))).toBe(true)
      expect(io.out.some((l) => l.startsWith(`added ${join('sub', 'b.fdn.html')}`))).toBe(true)

      const m = manifest()
      expect(m.documents.map((d) => d.path).sort()).toEqual(['a.fdn.html', join('sub', 'b.fdn.html')].sort())
    })

    it('does not re-add a document already registered under the same relative path', async () => {
      await runNew([join(dir, 'a')], captureIo())
      await runProject(['scan', dir], captureIo())
      const io = captureIo()
      await runProject(['scan', dir], io)
      expect(io.out.some((l) => l.startsWith('added'))).toBe(false)
      expect(manifest().documents).toHaveLength(1)
    })

    it('skips (does not crash on) a .fdn.html file with no doc id, and reports it', async () => {
      writeFileSync(
        join(dir, 'bare.fdn.html'),
        '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"></head><body>'
          + '<fdn-doc hidden data-fdn-spec-version="0.0.1-draft"></fdn-doc>'
          + '<main><h1 data-fdn-id="n1">Bare</h1></main></body></html>\n',
        'utf8',
      )
      const io = captureIo()
      const code = await runProject(['scan', dir], io)
      expect(code).toBe(0)
      expect(io.out.some((l) => l.startsWith('skipped bare.fdn.html'))).toBe(true)
      expect(manifest().documents).toHaveLength(0)
    })

    it('skips node_modules', async () => {
      const nm = join(dir, 'node_modules', 'pkg')
      mkdirSync(nm, { recursive: true })
      await runNew([join(nm, 'ghost')], captureIo())
      const io = captureIo()
      await runProject(['scan', dir], io)
      expect(manifest().documents).toHaveLength(0)
    })
  })
})
