/**
 * `foundation_import` MCP tool — exercised in-process via `callTool` (same
 * "CliIO seam so command functions are directly testable" philosophy
 * io.ts documents, applied to the MCP side: no need to pay for a real stdio
 * child process here, mcp-server.test.ts already proves the wire protocol
 * itself works end to end for the fixed tool set as a whole).
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadChain, parseDocument, projectDocument, validateDocument } from 'foundation-engine'
import { captureIo } from '../src/io.js'
import { runNew } from '../src/commands/new.js'
import { callTool, TOOLS } from '../src/mcp/tools.js'

const fixturesDir = path.resolve(import.meta.dirname, '../../importer/fixtures')
const fixture = (name: string): string => path.join(fixturesDir, name)

describe('foundation_import (MCP tool)', () => {
  let dir: string
  let target: string
  let file: string
  let chainPath: string

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'fdn-mcp-import-'))
    target = path.join(dir, 'board')
    file = `${target}.fdn.html`
    chainPath = `${file}.chain`
    await runNew([target], captureIo())
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('is registered in the fixed tool list with source/into required', () => {
    const tool = TOOLS.find((t) => t.name === 'foundation_import')
    expect(tool).toBeDefined()
    expect(tool?.inputSchema.required).toEqual(['source', 'into'])
    expect(tool?.description).toBeTruthy()
    expect(tool?.description).toContain('native')
    expect(tool?.description).toContain('sealed')
  })

  it('imports badge.tsx and returns structured native-mode content', async () => {
    const result = await callTool('foundation_import', { source: fixture('badge.tsx'), into: file })
    expect(result.isError).not.toBe(true)
    const structured = result.structuredContent as Record<string, unknown>
    expect(structured.component).toBe('Badge')
    expect(structured.mode).toBe('native')
    expect(structured.action).toBe('added')
    expect(structured.provenance).toMatchObject({ source: fixture('badge.tsx') })

    const { doc } = parseDocument(readFileSync(file, 'utf8'))
    expect(doc.components.find((c) => c.name === 'Badge')).toBeDefined()
    expect(validateDocument(doc).valid).toBe(true)
  })

  it('honors name / props / sealed args', async () => {
    const result = await callTool('foundation_import', {
      source: fixture('card.tsx'),
      into: file,
      name: 'MyCard',
      props: [{ name: 'children', type: 'string' }],
      sealed: true,
    })
    expect(result.isError).not.toBe(true)
    const structured = result.structuredContent as Record<string, unknown>
    expect(structured.component).toBe('MyCard')
    expect(structured.mode).toBe('sealed')

    const { doc } = parseDocument(readFileSync(file, 'utf8'))
    const comp = doc.components.find((c) => c.name === 'MyCard')
    expect(comp?.sealed).toBeDefined()
  })

  it('returns an isError result with a structured code on a harvest failure (unresolvable schema)', async () => {
    const result = await callTool('foundation_import', { source: fixture('card.tsx'), into: file })
    expect(result.isError).toBe(true)
    expect(result.structuredContent?.code).toBe('schema-unresolvable')
    expect(result.content[0]?.text).toContain('children')
  })

  it('rejects a non-array props argument without throwing', async () => {
    const result = await callTool('foundation_import', { source: fixture('badge.tsx'), into: file, props: 'nope' })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('props')
  })

  it('chain-commits when a chain exists, with the same message shape as the CLI', async () => {
    const result = await callTool('foundation_import', { source: fixture('badge.tsx'), into: file })
    expect(result.isError).not.toBe(true)
    const commit = (result.structuredContent as Record<string, unknown>).commit as Record<string, unknown>
    expect(commit.status).toBe('committed')
    expect(commit.message).toBe(`import Badge from ${fixture('badge.tsx')} (native)`)

    expect(existsSync(chainPath)).toBe(true)
    const chain = loadChain(readFileSync(chainPath))
    expect(chain.doc().components.find((c) => c.name === 'Badge')).toBeDefined()
  })

  it('a lookup name collision fails cleanly with a hint, matching the CLI', async () => {
    const { doc } = parseDocument(readFileSync(file, 'utf8'))
    doc.lookups.push({ name: 'BadgeLookup1', entries: { bogus: 'entry' } })
    writeFileSync(file, projectDocument(doc), 'utf8')

    const result = await callTool('foundation_import', { source: fixture('badge.tsx'), into: file })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('lookup name collision')
    expect(result.content[0]?.text).toContain('BadgeLookup1')
  })

  describe('theme vars become document tokens (follow-up wave)', () => {
    it('badge.tsx import declares its Tailwind theme vars as doc.tokens', async () => {
      const result = await callTool('foundation_import', { source: fixture('badge.tsx'), into: file })
      expect(result.isError).not.toBe(true)
      const structured = result.structuredContent as { report: { lines: { code: string }[] } }
      expect(structured.report.lines.some((l) => l.code === 'import-theme-token')).toBe(true)

      const { doc } = parseDocument(readFileSync(file, 'utf8'))
      expect(doc.tokens['color-green-100']).toBe('oklch(96.2% 0.044 156.743)')
      expect(doc.tokens['color-accent']).toBe('#B8860B')
    })

    it('a conflicting existing token is kept (document wins) with a warning report, same as the CLI', async () => {
      const { doc } = parseDocument(readFileSync(file, 'utf8'))
      doc.tokens['color-green-100'] = '#00ff00'
      writeFileSync(file, projectDocument(doc), 'utf8')

      const result = await callTool('foundation_import', { source: fixture('badge.tsx'), into: file })
      expect(result.isError).not.toBe(true)
      const structured = result.structuredContent as { report: { lines: { code: string; severity: string; detail?: unknown }[] } }
      const conflict = structured.report.lines.find((l) => l.code === 'import-token-conflict')
      expect(conflict).toBeDefined()
      expect(conflict?.severity).toBe('warning')
      expect(conflict?.detail).toMatchObject({ name: 'color-green-100', documentValue: '#00ff00' })

      const { doc: after } = parseDocument(readFileSync(file, 'utf8'))
      expect(after.tokens['color-green-100']).toBe('#00ff00')
    })
  })
})
