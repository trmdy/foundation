import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createChain } from 'foundation-engine'
import type { ChangeMeta, FdnDocument } from 'foundation-engine'
import { captureIo } from '../src/io.js'
import { runFreeze } from '../src/commands/freeze.js'

const VALID_DOC = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"></head>
<body>
<fdn-doc hidden data-fdn-spec-version="0.0.1-draft"></fdn-doc>
<main>
<h1 data-fdn-id="n1">Hello, Foundation</h1>
</main>
</body>
</html>
`

// Same shape as packages/cli/test/exit-codes.test.ts's "broken" fixture: an
// fdn-use referencing an undeclared component is a hard validation error.
const INVALID_DOC = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"></head>
<body>
<fdn-doc hidden data-fdn-spec-version="0.0.1-draft"></fdn-doc>
<main>
<fdn-use component="DoesNotExist"></fdn-use>
</main>
</body>
</html>
`

function minimalDocForChain(): FdnDocument {
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
    body: [{ id: 'n1', tag: 'h1', attrs: {}, style: {}, styleStates: {}, text: 'Hello, Foundation', children: [] }],
  }
}

describe('foundation freeze', () => {
  let dir: string
  let file: string
  let dest: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fdn-cli-freeze-'))
    file = join(dir, 'board.fdn.html')
    dest = join(dir, 'board.frozen.fdn.html')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('usage error when the source file is missing (exit 2)', async () => {
    const io = captureIo()
    const code = await runFreeze([], io)
    expect(code).toBe(2)
    expect(io.err.some((l) => l.includes('usage'))).toBe(true)
  })

  it('usage error when -o is missing (exit 2)', async () => {
    writeFileSync(file, VALID_DOC, 'utf8')
    const io = captureIo()
    const code = await runFreeze([file], io)
    expect(code).toBe(2)
  })

  it('missing source file exits 2 rather than throwing', async () => {
    const io = captureIo()
    const code = await runFreeze([join(dir, 'nope.fdn.html'), '-o', dest], io)
    expect(code).toBe(2)
  })

  it('freezes a valid document with no chain: writes dest, chain-head is "none"', async () => {
    writeFileSync(file, VALID_DOC, 'utf8')
    const io = captureIo()
    const code = await runFreeze([file, '-o', dest, '--author', 'user:tormod', '-m', 'first freeze'], io)
    expect(code).toBe(0)
    expect(existsSync(dest)).toBe(true)
    expect(io.out.some((l) => l.includes(`wrote ${dest}`))).toBe(true)

    const frozen = readFileSync(dest, 'utf8')
    const headerLine = frozen.split('\n')[0] as string
    expect(headerLine.startsWith('<!-- fdn-frozen ')).toBe(true)
    expect(headerLine).toContain('chain-head=none')
    expect(headerLine).toContain('frozen-by=user:tormod')
    expect(headerLine).toContain(`message=${encodeURIComponent('first freeze')}`)
  })

  it('freezes a document with a chain: chain-head records the chain\'s head envelope hash', async () => {
    writeFileSync(file, VALID_DOC, 'utf8')
    const meta: ChangeMeta = { author: 'user:tormod', message: 'seed' }
    const chain = createChain(minimalDocForChain(), meta)
    writeFileSync(`${file}.chain`, chain.save())

    const io = captureIo()
    const code = await runFreeze([file, '-o', dest], io)
    expect(code).toBe(0)

    const frozen = readFileSync(dest, 'utf8')
    const headerLine = frozen.split('\n')[0] as string
    expect(headerLine).toContain(`chain-head=${chain.head().hash}`)
  })

  it('refuses to freeze an invalid document: exit 1, no dest file written', async () => {
    writeFileSync(file, INVALID_DOC, 'utf8')
    const io = captureIo()
    const code = await runFreeze([file, '-o', dest], io)
    expect(code).toBe(1)
    expect(existsSync(dest)).toBe(false)
    expect(io.err.some((l) => l.includes('refusing to freeze'))).toBe(true)
  })

  it('--verify on a healthy frozen file: exit 0, prints header fields and OK', async () => {
    writeFileSync(file, VALID_DOC, 'utf8')
    await runFreeze([file, '-o', dest, '--author', 'user:tormod'], captureIo())

    const io = captureIo()
    const code = await runFreeze(['--verify', dest], io)
    expect(code).toBe(0)
    expect(io.out.some((l) => l === 'frozen-by=user:tormod')).toBe(true)
    expect(io.out.some((l) => l.startsWith('doc-sha256='))).toBe(true)
    expect(io.out.some((l) => l.includes('OK'))).toBe(true)
  })

  it('--verify on a tampered frozen file: exit 1, prints BROKEN with a reason', async () => {
    writeFileSync(file, VALID_DOC, 'utf8')
    await runFreeze([file, '-o', dest], captureIo())
    const frozen = readFileSync(dest, 'utf8')
    const idx = frozen.indexOf('<h1')
    const tampered = `${frozen.slice(0, idx)}<h1 data-fdn-id="n1">TAMPERED${frozen.slice(idx + '<h1 data-fdn-id="n1">'.length + 'Hello, Foundation'.length)}`
    writeFileSync(dest, tampered, 'utf8')

    const io = captureIo()
    const code = await runFreeze(['--verify', dest], io)
    expect(code).toBe(1)
    expect(io.out.some((l) => l.includes('BROKEN'))).toBe(true)
  })

  it('--verify usage error when no target is given (exit 2)', async () => {
    const io = captureIo()
    const code = await runFreeze(['--verify'], io)
    expect(code).toBe(2)
  })

  it('--verify on a missing file exits 2 rather than throwing', async () => {
    const io = captureIo()
    const code = await runFreeze(['--verify', join(dir, 'nope.frozen.fdn.html')], io)
    expect(code).toBe(2)
  })
})
