import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadChain } from 'foundation-engine'
import { captureIo } from '../src/io.js'
import { defaultAuthor } from '../src/identity.js'
import { runNew } from '../src/commands/new.js'
import { runIngest } from '../src/commands/ingest.js'
import { runChain } from '../src/commands/chain.js'

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Wires the chain (engine/src/chain) into the authoring loop:
 * `chain init`, `new` auto-initing, `ingest --commit`, `chain anchor`,
 * `chain diff`. See API.md's FdnChain interface + CLI section, and SPEC
 * D2 ("one change = one patch-verb batch = one envelope"). v0's commit
 * grain is intentionally coarse — every `ingest --commit` appends exactly
 * ONE `replace-document` change, never a fine-grained text-diff-to-PatchOp
 * derivation (that's a recorded follow-up, not built here) — but
 * `chain.diff()` re-derives fine-grained, node-level SemanticOps from the
 * two materialized snapshots regardless of that coarse commit grain; the
 * "anchor + diff" tests below assert on that directly.
 */
describe('chain wired into the authoring loop', () => {
  let dir: string
  let target: string
  let file: string
  let chainPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fdn-cli-chain-flow-'))
    target = join(dir, 'board')
    file = `${target}.fdn.html`
    chainPath = `${file}.chain`
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  describe('chain init', () => {
    it('parses the doc, creates a chain, and writes <file>.chain', async () => {
      const newCode = await runNew([target, '--no-chain'], captureIo())
      expect(newCode).toBe(0)
      expect(existsSync(chainPath)).toBe(false)

      const initIo = captureIo()
      const code = await runChain(['init', file], initIo)
      expect(code).toBe(0)
      expect(existsSync(chainPath)).toBe(true)
      expect(initIo.out.some((l) => l.includes('wrote') && l.includes(chainPath))).toBe(true)

      const chain = loadChain(readFileSync(chainPath))
      expect(chain.head().author).toBe(defaultAuthor())
      expect(chain.head().message).toBe('init')
      expect(chain.log()).toHaveLength(1)
    })

    it('honors --author and -m', async () => {
      await runNew([target, '--no-chain'], captureIo())
      const code = await runChain(['init', file, '--author', 'agent:bee', '-m', 'seed'], captureIo())
      expect(code).toBe(0)
      const chain = loadChain(readFileSync(chainPath))
      expect(chain.head().author).toBe('agent:bee')
      expect(chain.head().message).toBe('seed')
    })

    it('refuses a double init (exit 2)', async () => {
      await runNew([target, '--no-chain'], captureIo())
      expect(await runChain(['init', file], captureIo())).toBe(0)

      const io = captureIo()
      const code = await runChain(['init', file], io)
      expect(code).toBe(2)
      expect(io.err.some((l) => l.includes('already exists'))).toBe(true)
      // the first chain must be untouched by the refused second init.
      expect(loadChain(readFileSync(chainPath)).log()).toHaveLength(1)
    })

    it('usage error when file is missing (exit 2)', async () => {
      const io = captureIo()
      expect(await runChain(['init'], io)).toBe(2)
      expect(io.err.some((l) => l.includes('usage'))).toBe(true)
    })
  })

  describe('new auto-inits a chain', () => {
    it('creates <file>.chain by default, one envelope deep', async () => {
      const io = captureIo()
      const code = await runNew([target], io)
      expect(code).toBe(0)
      expect(existsSync(chainPath)).toBe(true)
      expect(io.out.some((l) => l.includes(chainPath))).toBe(true)
      expect(loadChain(readFileSync(chainPath)).log()).toHaveLength(1)
    })

    it('--no-chain opts out', async () => {
      const code = await runNew([target, '--no-chain'], captureIo())
      expect(code).toBe(0)
      expect(existsSync(chainPath)).toBe(false)
    })
  })

  describe('ingest --commit', () => {
    beforeEach(async () => {
      const code = await runNew([target], captureIo()) // chain-tracked from birth
      expect(code).toBe(0)
    })

    it('appends exactly one envelope and log shows it', async () => {
      expect(loadChain(readFileSync(chainPath)).log()).toHaveLength(1)

      const source = readFileSync(file, 'utf8')
      const edited = source.replace('data-fdn-prop-label="Hello, Foundation"', 'data-fdn-prop-label="Hello, Renamed"')
      expect(edited).not.toBe(source)
      writeFileSync(file, edited, 'utf8')

      const io = captureIo()
      const code = await runIngest([file, '--commit', '-m', 'rename card label'], io)
      expect(code).toBe(0)
      expect(io.out.some((l) => l.includes('committed'))).toBe(true)

      const afterChain = loadChain(readFileSync(chainPath))
      expect(afterChain.log()).toHaveLength(2)
      expect(afterChain.head().message).toBe('rename card label')
      expect(afterChain.head().author).toBe(defaultAuthor())

      const logIo = captureIo()
      expect(await runChain([file, 'log'], logIo)).toBe(0)
      expect(logIo.out).toHaveLength(2)
      expect(logIo.out[1]).toContain('rename card label')
      // hash[0..12], author, message per line.
      expect(logIo.out[1]).toMatch(new RegExp(`^[0-9a-f]{12}\\s+${escapeRegExp(defaultAuthor())}\\s+rename card label$`))
    })

    it('skips the commit when the parsed doc canonically matches the chain head (no-op)', async () => {
      const io = captureIo()
      const code = await runIngest([file, '--commit'], io)
      expect(code).toBe(0)
      expect(io.out.some((l) => l.includes('no changes to commit'))).toBe(true)
      expect(loadChain(readFileSync(chainPath)).log()).toHaveLength(1)
    })

    it('prints a hint and still ingests when --commit is given but no chain exists', async () => {
      rmSync(chainPath)
      const io = captureIo()
      const code = await runIngest([file, '--commit'], io)
      expect(code).toBe(0)
      expect(io.out.some((l) => l.includes('chain init'))).toBe(true)
      expect(io.out.some((l) => l.includes('already canonical') || l.includes('rewritten'))).toBe(true)
      expect(existsSync(chainPath)).toBe(false)
    })

    it('defaults the commit message to "ingest" plus a normalization summary when none is given', async () => {
      const source = readFileSync(file, 'utf8')
      const edited = source.replace('data-fdn-prop-label="Hello, Foundation"', 'data-fdn-prop-label="Hello, Renamed"')
      writeFileSync(file, edited, 'utf8')

      const code = await runIngest([file, '--commit'], captureIo())
      expect(code).toBe(0)
      const chain = loadChain(readFileSync(chainPath))
      expect(chain.log()).toHaveLength(2)
      expect(chain.head().message).toMatch(/^ingest/)
    })

    it('an author override on ingest --commit is used as the envelope author', async () => {
      const source = readFileSync(file, 'utf8')
      writeFileSync(file, source.replace('data-fdn-prop-label="Hello, Foundation"', 'data-fdn-prop-label="Hello, Renamed"'), 'utf8')
      const code = await runIngest([file, '--commit', '--author', 'agent:bee'], captureIo())
      expect(code).toBe(0)
      expect(loadChain(readFileSync(chainPath)).head().author).toBe('agent:bee')
    })
  })

  describe('chain anchor + chain diff', () => {
    beforeEach(async () => {
      const code = await runNew([target], captureIo())
      expect(code).toBe(0)
    })

    it('anchors two committed states; diff shows fine-grained node-level SemanticOps despite the whole-document commit grain', async () => {
      const anchorACode = await runChain(['anchor', file, 'a'], captureIo())
      expect(anchorACode).toBe(0)

      const source = readFileSync(file, 'utf8')
      writeFileSync(file, source.replace('data-fdn-prop-label="Hello, Foundation"', 'data-fdn-prop-label="Hello, Renamed"'), 'utf8')
      const commitCode = await runIngest([file, '--commit', '-m', 'rename'], captureIo())
      expect(commitCode).toBe(0)

      const anchorBCode = await runChain(['anchor', file, 'b'], captureIo())
      expect(anchorBCode).toBe(0)

      const io = captureIo()
      const code = await runChain(['diff', file, 'a', 'b'], io)
      expect(code).toBe(0)
      expect(io.out.some((l) => l.includes('op(s)'))).toBe(true)
      expect(io.out.some((l) => l.includes('set-attr') && l.includes('data-fdn-prop-label'))).toBe(true)
    })

    it('an anchored point is persisted back to <file>.chain and survives reload', async () => {
      const code = await runChain(['anchor', file, 'checkpoint'], captureIo())
      expect(code).toBe(0)
      const chain = loadChain(readFileSync(chainPath))
      expect(() => chain.checkout('checkpoint')).not.toThrow()
    })

    it('diff prints "no differences" when the anchors are identical', async () => {
      await runChain(['anchor', file, 'x'], captureIo())
      await runChain(['anchor', file, 'y'], captureIo())
      const io = captureIo()
      const code = await runChain(['diff', file, 'x', 'y'], io)
      expect(code).toBe(0)
      expect(io.out.some((l) => l.includes('no differences'))).toBe(true)
    })

    it('diff on an unknown anchor is a data error (exit 2)', async () => {
      const io = captureIo()
      const code = await runChain(['diff', file, 'nope', 'also-nope'], io)
      expect(code).toBe(2)
    })

    it('anchor without a chain prints a friendly hint (exit 0)', async () => {
      const bareTarget = join(dir, 'no-chain-board')
      await runNew([bareTarget, '--no-chain'], captureIo())
      const io = captureIo()
      const code = await runChain(['anchor', `${bareTarget}.fdn.html`, 'x'], io)
      expect(code).toBe(0)
      expect(io.out.some((l) => l.includes('no chain yet'))).toBe(true)
    })
  })

  describe('verify after the whole flow', () => {
    it('is ok after new -> edit -> ingest --commit -> anchor -> diff', async () => {
      const newCode = await runNew([target], captureIo())
      expect(newCode).toBe(0)

      await runChain(['anchor', file, 'start'], captureIo())

      const source = readFileSync(file, 'utf8')
      writeFileSync(file, source.replace('data-fdn-prop-label="Hello, Foundation"', 'data-fdn-prop-label="Hello, Renamed"'), 'utf8')
      const commitCode = await runIngest([file, '--commit', '-m', 'rename'], captureIo())
      expect(commitCode).toBe(0)

      await runChain(['anchor', file, 'end'], captureIo())

      const diffIo = captureIo()
      expect(await runChain(['diff', file, 'start', 'end'], diffIo)).toBe(0)
      expect(diffIo.out.some((l) => l.includes('set-attr'))).toBe(true)

      const verifyIo = captureIo()
      const code = await runChain([file, 'verify'], verifyIo)
      expect(code).toBe(0)
      expect(verifyIo.out.some((l) => l.includes('OK'))).toBe(true)
    })
  })
})
