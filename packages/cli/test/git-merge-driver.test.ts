import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadChain } from 'foundation-engine'
import { captureIo } from '../src/io.js'
import { readDocIdAttr } from '../src/docid.js'
import { runNew } from '../src/commands/new.js'
import { runIngest } from '../src/commands/ingest.js'
import { runGitMergeDriver } from '../src/commands/git-merge-driver.js'

/**
 * Unit tests for `foundation git-merge-driver <ancestor> <ours> <theirs>`
 * (task brief: "merge driver on a real diverged git scenario is optional —
 * unit-test the function, not git itself"). Exercises the function directly
 * against real temp files shaped like what git would hand it, without
 * invoking git.
 */
describe('git-merge-driver (unit, no real git)', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fdn-cli-git-driver-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('merges two diverged .chain snapshots and writes the result to the "ours" path', async () => {
    const target = join(dir, 'board')
    await runNew([target], captureIo())
    const file = `${target}.fdn.html`
    const chainPath = `${file}.chain`

    const baseBytes = readFileSync(chainPath)
    const oursChain = loadChain(baseBytes, { actor: 'user:ours' })
    oursChain.apply({ author: 'user:ours', message: 'ours edit' }, [{ op: 'set-token', name: 'ours-token', value: '1' }])
    const theirsChain = loadChain(baseBytes, { actor: 'user:theirs' })
    theirsChain.apply({ author: 'user:theirs', message: 'theirs edit' }, [{ op: 'set-token', name: 'theirs-token', value: '1' }])

    // simulate git's 3 temp files: %O %A %B (ancestor/ours/theirs)
    const oAncestor = join(dir, 'tmp-ancestor.chain')
    const aOurs = join(dir, 'tmp-ours.chain')
    const bTheirs = join(dir, 'tmp-theirs.chain')
    writeFileSync(oAncestor, baseBytes)
    writeFileSync(aOurs, oursChain.save())
    writeFileSync(bTheirs, theirsChain.save())

    const io = captureIo()
    const code = await runGitMergeDriver([oAncestor, aOurs, bTheirs], io)
    expect(code).toBe(0)

    const merged = loadChain(readFileSync(aOurs))
    expect(merged.doc().tokens['ours-token']).toBe('1')
    expect(merged.doc().tokens['theirs-token']).toBe('1')
  })

  it('uses a sibling merged .chain for a .fdn.html merge when <ours>.chain exists', async () => {
    const target = join(dir, 'board')
    await runNew([target], captureIo())
    const file = `${target}.fdn.html`
    const chainPath = `${file}.chain`

    const baseBytes = readFileSync(chainPath)
    const merged = loadChain(baseBytes, { actor: 'user:merged' })
    // 'n1' is the skeleton's top-level <h1> (in doc.body, part of the Loro
    // tree) — unlike 'card-label', which lives inside the Card COMPONENT
    // definition and is never a LoroTree node (components are stored as
    // whole-blob map entries, not per-node tree entries — see chain.ts).
    merged.apply({ author: 'user:merged', message: 'resolved edit' }, [{ op: 'set-text', id: 'n1', text: 'Resolved!' }])

    const aOurs = join(dir, 'tmp-ours.fdn.html')
    const bTheirs = join(dir, 'tmp-theirs.fdn.html')
    const oAncestor = join(dir, 'tmp-ancestor.fdn.html')
    writeFileSync(aOurs, readFileSync(file, 'utf8'))
    writeFileSync(bTheirs, readFileSync(file, 'utf8'))
    writeFileSync(oAncestor, readFileSync(file, 'utf8'))
    // the sibling chain the driver should discover: `${aOurs}.chain`
    writeFileSync(`${aOurs}.chain`, merged.save())

    const io = captureIo()
    const code = await runGitMergeDriver([oAncestor, aOurs, bTheirs], io)
    expect(code).toBe(0)
    expect(readFileSync(aOurs, 'utf8')).toContain('Resolved!')
    expect(readDocIdAttr(readFileSync(aOurs, 'utf8'))).toBe(merged.docId())
    expect(io.err.some((l) => l.includes('sibling merged chain'))).toBe(true)
  })

  it('falls back to "ours" with a warning when no sibling chain exists (documented limitation)', async () => {
    const target = join(dir, 'board')
    await runNew([target], captureIo())
    const file = `${target}.fdn.html`

    const oursText = readFileSync(file, 'utf8').replace('Hello, Foundation', 'Ours wins')
    const theirsText = readFileSync(file, 'utf8').replace('Hello, Foundation', 'Theirs would have won')

    const aOurs = join(dir, 'tmp-ours.fdn.html')
    const bTheirs = join(dir, 'tmp-theirs.fdn.html')
    const oAncestor = join(dir, 'tmp-ancestor.fdn.html')
    writeFileSync(aOurs, oursText)
    writeFileSync(bTheirs, theirsText)
    writeFileSync(oAncestor, readFileSync(file, 'utf8'))
    expect(existsSync(`${aOurs}.chain`)).toBe(false)

    const io = captureIo()
    const code = await runGitMergeDriver([oAncestor, aOurs, bTheirs], io)
    expect(code).toBe(0)
    expect(readFileSync(aOurs, 'utf8')).toBe(oursText) // unchanged — "ours" kept as-is
    expect(io.err.some((l) => l.includes('falling back to "ours"'))).toBe(true)
  })

  it('usage error when fewer than 3 paths are given (exit 2)', async () => {
    const io = captureIo()
    const code = await runGitMergeDriver(['only-one'], io)
    expect(code).toBe(2)
    expect(io.err.some((l) => l.includes('usage'))).toBe(true)
  })

  it('the sibling-chain path picks up a real ingest --commit edit (driver + CLI stay consistent)', async () => {
    const target = join(dir, 'board')
    await runNew([target], captureIo())
    const file = `${target}.fdn.html`
    const source = readFileSync(file, 'utf8')
    writeFileSync(file, source.replace('Hello, Foundation', 'Committed edit'), 'utf8')
    const commitCode = await runIngest([file, '--commit', '-m', 'edit'], captureIo())
    expect(commitCode).toBe(0)

    const oAncestor = join(dir, 'tmp-ancestor.fdn.html')
    const aOurs = join(dir, 'tmp-ours.fdn.html')
    const bTheirs = join(dir, 'tmp-theirs.fdn.html')
    writeFileSync(oAncestor, source)
    writeFileSync(aOurs, source) // stale "ours" text — the driver should prefer the sibling chain's projection
    writeFileSync(`${aOurs}.chain`, readFileSync(`${file}.chain`))
    writeFileSync(bTheirs, source)

    const code = await runGitMergeDriver([oAncestor, aOurs, bTheirs], captureIo())
    expect(code).toBe(0)
    expect(readFileSync(aOurs, 'utf8')).toContain('Committed edit')
  })
})
