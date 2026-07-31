import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadChain } from 'foundation-engine'
import { captureIo } from '../src/io.js'
import { runNew } from '../src/commands/new.js'
import { runChain } from '../src/commands/chain.js'
import { runIngest } from '../src/commands/ingest.js'

/**
 * CLI surface over exportBlobs/importBlobs/mergeChains (SPEC 13a-iv):
 * `chain push|pull|sync <file> <dir>` and `chain merge <file> <theirs.chain>`.
 */
describe('chain push / pull / sync / merge (CLI)', () => {
  let dir: string
  let mailbox: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fdn-cli-exchange-'))
    mailbox = mkdtempSync(join(tmpdir(), 'fdn-cli-mailbox-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    rmSync(mailbox, { recursive: true, force: true })
  })

  it('push writes blobs under <dir>/<docId>/, and a second push is idempotent (0 written)', async () => {
    const target = join(dir, 'board')
    const file = `${target}.fdn.html`
    await runNew([target], captureIo())
    const docId = loadChain(readFileSync(`${file}.chain`)).docId()
    expect(docId).not.toBeNull()

    const io = captureIo()
    const code = await runChain(['push', file, mailbox], io)
    expect(code).toBe(0)
    expect(io.out.some((l) => l.includes('pushed'))).toBe(true)
    expect(readdirSync(join(mailbox, docId as string))).toHaveLength(1) // just the `new`-seeded init commit

    const second = await runChain(['push', file, mailbox], captureIo())
    expect(second).toBe(0)
    expect(readdirSync(join(mailbox, docId as string))).toHaveLength(1)
  })

  it('pull imports blobs from another chain pushed to the same mailbox, and idempotently imports 0 on rerun', async () => {
    const targetA = join(dir, 'a')
    const fileA = `${targetA}.fdn.html`
    await runNew([targetA], captureIo())
    await runChain(['push', fileA, mailbox], captureIo())

    // designer B: a fresh chain from A's snapshot, sharing docId, that then
    // diverges and pushes its own edit into the SAME mailbox.
    const targetB = join(dir, 'b')
    const fileB = `${targetB}.fdn.html`
    writeFileSync(fileB, readFileSync(fileA, 'utf8'), 'utf8')
    writeFileSync(`${fileB}.chain`, readFileSync(`${fileA}.chain`))

    const pullIo = captureIo()
    const pullCode = await runChain(['pull', fileB, mailbox], pullIo)
    expect(pullCode).toBe(0)
    expect(pullIo.out.some((l) => l.includes('pulled'))).toBe(true)
    expect(pullIo.out.some((l) => l.includes('no concurrent-overlap conflicts'))).toBe(true)

    const rerun = captureIo()
    expect(await runChain(['pull', fileB, mailbox], rerun)).toBe(0)
    expect(rerun.out.some((l) => l.includes('pulled 0'))).toBe(true)
  })

  it('sync = pull then push, in one command', async () => {
    const target = join(dir, 'board')
    const file = `${target}.fdn.html`
    await runNew([target], captureIo())

    const io = captureIo()
    const code = await runChain(['sync', file, mailbox], io)
    expect(code).toBe(0)
    expect(io.out.some((l) => l.includes('pulled') && l.includes('pushed'))).toBe(true)
  })

  it('push/pull on a file with no chain yet prints a hint (exit 0)', async () => {
    const target = join(dir, 'bare')
    const file = `${target}.fdn.html`
    await runNew([target, '--no-chain'], captureIo())
    expect(existsSync(`${file}.chain`)).toBe(false)

    const io = captureIo()
    const code = await runChain(['push', file, mailbox], io)
    expect(code).toBe(0)
    expect(io.out.some((l) => l.includes('no chain yet'))).toBe(true)
  })

  it('merge combines two diverged chains, rewrites <file> and <file>.chain, and prints an overlap report', async () => {
    const targetA = join(dir, 'a')
    const fileA = `${targetA}.fdn.html`
    await runNew([targetA], captureIo())

    const targetB = join(dir, 'b')
    const fileB = `${targetB}.fdn.html`
    writeFileSync(fileB, readFileSync(fileA, 'utf8'), 'utf8')
    writeFileSync(`${fileB}.chain`, readFileSync(`${fileA}.chain`))

    // diverge B by editing its text and ingesting a commit onto its own chain.
    const sourceB = readFileSync(fileB, 'utf8')
    writeFileSync(fileB, sourceB.replace('data-fdn-prop-label="Hello, Foundation"', 'data-fdn-prop-label="Hello, B"'), 'utf8')
    const ingestCode = await runIngest([fileB, '--commit', '-m', 'edit on b'], captureIo())
    expect(ingestCode).toBe(0)

    const io = captureIo()
    const code = await runChain(['merge', fileA, `${fileB}.chain`], io)
    expect(code).toBe(0)
    expect(io.out.some((l) => l.includes('merged with'))).toBe(true)

    const mergedText = readFileSync(fileA, 'utf8')
    expect(mergedText).toContain('Hello, B')
    const mergedChain = loadChain(readFileSync(`${fileA}.chain`))
    expect(mergedChain.docId()).toBe(loadChain(readFileSync(`${fileB}.chain`)).docId())
  })

  /**
   * Gate finding (coordinator, post-review of the async-designer scenario
   * end-to-end): chains were converging correctly, but `chain pull`/`sync`
   * only updated `<file>.chain` — the `.fdn.html` TEXT was never
   * regenerated, so each peer kept looking at their own stale edit forever
   * even after a successful pull. This is the fix, exercised through real
   * disjoint edits on both sides + `ingest --commit` with distinct authors,
   * synced through a shared mailbox to full byte-identical convergence.
   */
  it('sync converges two peers to byte-identical .fdn.html TEXT containing both edits (full async-designer scenario via CLI)', async () => {
    const targetA = join(dir, 'board')
    const fileA = `${targetA}.fdn.html`
    await runNew([targetA], captureIo())

    const targetB = join(dir, 'board-b')
    const fileB = `${targetB}.fdn.html`
    writeFileSync(fileB, readFileSync(fileA, 'utf8'), 'utf8')
    writeFileSync(`${fileB}.chain`, readFileSync(`${fileA}.chain`))

    // A edits the document title (disjoint from B's edit below) and commits.
    const sourceA = readFileSync(fileA, 'utf8')
    expect(sourceA).toContain('data-fdn-title="Board"')
    writeFileSync(fileA, sourceA.replace('data-fdn-title="Board"', 'data-fdn-title="Board — edited by A"'), 'utf8')
    expect(await runIngest([fileA, '--commit', '--author', 'user:a', '-m', 'a edits title'], captureIo())).toBe(0)

    // B edits the Card component's instance label and commits.
    const sourceB = readFileSync(fileB, 'utf8')
    expect(sourceB).toContain('data-fdn-prop-label="Hello, Foundation"')
    writeFileSync(fileB, sourceB.replace('data-fdn-prop-label="Hello, Foundation"', 'data-fdn-prop-label="Hello, B"'), 'utf8')
    expect(await runIngest([fileB, '--commit', '--author', 'user:b', '-m', 'b edits label'], captureIo())).toBe(0)

    // neither side has seen the other's edit yet.
    expect(readFileSync(fileA, 'utf8')).not.toContain('Hello, B')
    expect(readFileSync(fileB, 'utf8')).not.toContain('Board — edited by A')

    // sync A (pushes A's commit; nothing to pull yet), sync B (pulls A's
    // commit + pushes B's), sync A (pulls B's commit) — exactly the
    // sequence from the gate finding.
    const syncA1 = captureIo()
    expect(await runChain(['sync', fileA, mailbox], syncA1)).toBe(0)
    const syncB = captureIo()
    expect(await runChain(['sync', fileB, mailbox], syncB)).toBe(0)
    expect(syncB.out.some((l) => l.includes(`updated ${fileB} from merged chain`))).toBe(true)
    const syncA2 = captureIo()
    expect(await runChain(['sync', fileA, mailbox], syncA2)).toBe(0)
    expect(syncA2.out.some((l) => l.includes(`updated ${fileA} from merged chain`))).toBe(true)

    const textA = readFileSync(fileA, 'utf8')
    const textB = readFileSync(fileB, 'utf8')
    expect(textA).toBe(textB) // byte-identical
    expect(textA).toContain('Board — edited by A')
    expect(textA).toContain('Hello, B')

    // the .chain snapshots need not be byte-identical (Loro snapshot encoding
    // isn't guaranteed canonical across independently-merged instances — see
    // chain-fork-merge.test.ts's equivalent doc()/log() comparisons), but
    // their materialized content and history must agree exactly.
    const chainA = loadChain(readFileSync(`${fileA}.chain`))
    const chainB = loadChain(readFileSync(`${fileB}.chain`))
    expect(chainA.log().map((e) => e.author)).toEqual(expect.arrayContaining(['user:a', 'user:b']))
    expect(chainA.doc()).toEqual(chainB.doc())
    expect(chainA.log()).toEqual(chainB.log())
  })

  it('pull/sync guards uncommitted local text edits: chain still imports, but the text is left alone with a warning', async () => {
    const targetA = join(dir, 'board')
    const fileA = `${targetA}.fdn.html`
    await runNew([targetA], captureIo())

    const targetB = join(dir, 'board-b')
    const fileB = `${targetB}.fdn.html`
    writeFileSync(fileB, readFileSync(fileA, 'utf8'), 'utf8')
    writeFileSync(`${fileB}.chain`, readFileSync(`${fileA}.chain`))

    // A commits a real edit and pushes it, so B has something to pull.
    const sourceA = readFileSync(fileA, 'utf8')
    writeFileSync(fileA, sourceA.replace('data-fdn-title="Board"', 'data-fdn-title="Board A"'), 'utf8')
    expect(await runIngest([fileA, '--commit', '-m', 'a edits'], captureIo())).toBe(0)
    expect(await runChain(['push', fileA, mailbox], captureIo())).toBe(0)

    // B has an UNCOMMITTED text edit sitting on disk (never ingested) when it pulls.
    const sourceB = readFileSync(fileB, 'utf8')
    const dirtyTextB = sourceB.replace('data-fdn-prop-label="Hello, Foundation"', 'data-fdn-prop-label="Uncommitted B edit"')
    writeFileSync(fileB, dirtyTextB, 'utf8')

    const io = captureIo()
    const code = await runChain(['pull', fileB, mailbox], io)
    expect(code).toBe(0) // guard is a warning, not a failure
    expect(io.out.some((l) => l.includes('pulled'))).toBe(true) // the chain DID import
    expect(io.out.some((l) => l.includes('uncommitted edits') && l.includes('ingest'))).toBe(true)
    expect(io.out.some((l) => l.includes('updated'))).toBe(false) // text was NOT regenerated

    // the chain import happened for real (docId/log reflect A's change)...
    const chainB = loadChain(readFileSync(`${fileB}.chain`))
    expect(chainB.log().some((e) => e.message === 'a edits')).toBe(true)
    // ...but the on-disk text is untouched — B's uncommitted edit survives.
    expect(readFileSync(fileB, 'utf8')).toBe(dirtyTextB)
  })
})
