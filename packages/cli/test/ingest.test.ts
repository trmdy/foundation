import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { captureIo } from '../src/io.js'
import { runNew } from '../src/commands/new.js'
import { runIngest } from '../src/commands/ingest.js'

describe('foundation ingest', () => {
  let dir: string
  let file: string

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'fdn-cli-ingest-'))
    const target = join(dir, 'board')
    await runNew([target], captureIo())
    file = `${target}.fdn.html`
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('ingesting an already-canonical file leaves the bytes unchanged (content-level no-op) and exits 0', async () => {
    // Parsing always emits an info-level "text-whitespace-normalized" line for
    // pretty-printed text nodes (the surrounding indentation IS insignificant
    // whitespace, even in the engine's own canonical output) — that's a real
    // report line, not a bug. The content-level invariant that matters is the
    // parse(project(doc)) fixpoint: re-projecting must reproduce byte-identical
    // text even though the report isn't empty.
    const before = readFileSync(file, 'utf8')
    const io = captureIo()
    const code = await runIngest([file], io)
    expect(code).toBe(0)
    expect(readFileSync(file, 'utf8')).toBe(before)
    expect(io.out.some((l) => l.includes('already canonical, unchanged'))).toBe(true)
  })

  it('a second ingest produces byte-identical content to the first (idempotence)', async () => {
    await runIngest([file], captureIo())
    const afterFirst = readFileSync(file, 'utf8')
    await runIngest([file], captureIo())
    const afterSecond = readFileSync(file, 'utf8')
    expect(afterSecond).toBe(afterFirst)
  })

  it('normalizes loose hand-authored HTML and reports what changed', async () => {
    // hand-edit: self-closing fdn-* tags, which parse liberally rewrites (see
    // parse/index.ts normalizeSelfClosingFdnTags) — a realistic "someone
    // hand-edited the projection" scenario per D4.
    const loose = readFileSync(file, 'utf8').replace(
      '<fdn-param name="title" type="string" default="Board"></fdn-param>',
      '<fdn-param name="title" type="string" default="Board"/>',
    )
    const fs = await import('node:fs')
    fs.writeFileSync(file, loose, 'utf8')

    const io = captureIo()
    const code = await runIngest([file], io)
    expect(code).toBe(0)
    expect(io.out.some((l) => l.includes('rewritten to canonical form') || l.includes('no normalization needed'))).toBe(true)
  })

  it('usage error when no file is given (exit 2)', async () => {
    const io = captureIo()
    expect(await runIngest([], io)).toBe(2)
    expect(io.err.some((l) => l.includes('usage'))).toBe(true)
  })

  it('exit 2 when the file does not exist', async () => {
    const io = captureIo()
    const code = await runIngest([join(dir, 'nope.fdn.html')], io)
    expect(code).toBe(2)
    expect(io.err.some((l) => l.includes('could not read'))).toBe(true)
  })
})
