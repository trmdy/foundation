import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { captureIo } from '../src/io.js'
import { runChain } from '../src/commands/chain.js'
import { runNew } from '../src/commands/new.js'

/**
 * `chain <file> log|verify` operates on `<file>.chain` beside the document.
 * `foundation new` now auto-inits a chain by default (see chain-workflow.
 * test.ts), so this suite passes `--no-chain` explicitly to get back the
 * "plain text, no chain file at all" fixture its "absent chain, friendly
 * message" degradation path is actually about — not a stand-in for a
 * missing module. render.ts/diff.ts's *module-not-present* degradation is
 * covered in render-diff.test.ts, conditioned on whether src/render and
 * src/diff actually exist in this checkout (see that file's header
 * comment).
 */
describe('chain command: friendly degradation when <file>.chain is absent', () => {
  let dir: string
  let file: string

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'fdn-cli-chain-degrade-'))
    const target = join(dir, 'board')
    await runNew([target, '--no-chain'], captureIo())
    file = `${target}.fdn.html`
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('log prints a friendly message when <file>.chain is absent', async () => {
    const io = captureIo()
    expect(await runChain([file, 'log'], io)).toBe(0)
    expect(io.out.some((l) => l.includes('no chain yet'))).toBe(true)
  })

  it('verify prints a friendly message when <file>.chain is absent', async () => {
    const io = captureIo()
    expect(await runChain([file, 'verify'], io)).toBe(0)
    expect(io.out.some((l) => l.includes('no chain yet'))).toBe(true)
  })

  it('a missing subcommand is a usage error', async () => {
    const io = captureIo()
    expect(await runChain([file], io)).toBe(2)
  })

  it('an unknown subcommand is a usage error', async () => {
    const io = captureIo()
    expect(await runChain([file, 'frobnicate'], io)).toBe(2)
  })

  it('missing file argument is a usage error', async () => {
    const io = captureIo()
    expect(await runChain([], io)).toBe(2)
  })
})
