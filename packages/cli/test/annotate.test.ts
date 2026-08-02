import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadChain, parseDocument } from 'foundation-engine'
import { captureIo } from '../src/io.js'
import { runNew } from '../src/commands/new.js'
import { runAnnotate, runAnnotations } from '../src/commands/annotate.js'

/**
 * CLI surface over the three annotation PatchOps (SPEC D2/D4/13a):
 * `foundation annotate`/`foundation annotations`. Every document here is
 * chain-tracked from birth (runNew's default), matching the annotate
 * command's hard requirement on an existing chain.
 */
describe('foundation annotate / foundation annotations', () => {
  let dir: string
  let target: string
  let file: string
  let chainPath: string

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'fdn-cli-annotate-'))
    target = join(dir, 'board')
    file = `${target}.fdn.html`
    chainPath = `${file}.chain`
    const code = await runNew([target], captureIo())
    expect(code).toBe(0)
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('refuses to annotate without a chain (exit 2, hint to run chain init)', async () => {
    rmSync(chainPath)
    const io = captureIo()
    const code = await runAnnotate([file, '--text', 'hello', '--node', 'n1'], io)
    expect(code).toBe(2)
    expect(io.err.some((l) => l.includes('chain init'))).toBe(true)
  })

  it('--text --node mints an id, chain-commits, and regenerates the .fdn.html text with the annotation', async () => {
    const io = captureIo()
    const code = await runAnnotate([file, '--text', 'padding looks off', '--node', 'n1'], io)
    expect(code).toBe(0)
    expect(io.out.some((l) => l.includes('committed') && l.includes('added'))).toBe(true)

    const chain = loadChain(readFileSync(chainPath))
    const annotations = chain.doc().annotations
    expect(annotations).toHaveLength(1)
    expect(annotations[0]).toMatchObject({ text: 'padding looks off', nodeId: 'n1', status: 'open' })

    // text regenerated from the merged chain, so the hidden block round-trips
    const text = readFileSync(file, 'utf8')
    const { doc } = parseDocument(text)
    expect(doc.annotations).toEqual(annotations)
    expect(text).toContain('<fdn-annotations>')
  })

  it('--x/--y anchors a viewport-coordinate annotation instead of a node', async () => {
    const code = await runAnnotate([file, '--text', 'off-canvas', '--x', '10', '--y', '20'], captureIo())
    expect(code).toBe(0)
    const chain = loadChain(readFileSync(chainPath))
    expect(chain.doc().annotations[0]).toMatchObject({ text: 'off-canvas', x: 10, y: 20 })
  })

  it('rejects passing both --node and --x/--y (usage error, exit 2)', async () => {
    const io = captureIo()
    const code = await runAnnotate([file, '--text', 'x', '--node', 'n1', '--x', '1', '--y', '2'], io)
    expect(code).toBe(2)
  })

  it('two annotations mint sequential ids', async () => {
    await runAnnotate([file, '--text', 'first', '--node', 'n1'], captureIo())
    await runAnnotate([file, '--text', 'second', '--node', 'n1'], captureIo())
    const chain = loadChain(readFileSync(chainPath))
    expect(chain.doc().annotations.map((a) => a.id).sort()).toEqual(['a1', 'a2'])
  })

  it('--resolve <id> marks an annotation resolved', async () => {
    await runAnnotate([file, '--text', 'fix this', '--node', 'n1'], captureIo())
    const id = loadChain(readFileSync(chainPath)).doc().annotations[0]?.id as string

    const io = captureIo()
    const code = await runAnnotate([file, '--resolve', id], io)
    expect(code).toBe(0)
    expect(io.out.some((l) => l.includes('resolved'))).toBe(true)

    const chain = loadChain(readFileSync(chainPath))
    expect(chain.doc().annotations.find((a) => a.id === id)?.status).toBe('resolved')
  })

  it('--wontfix <id> marks an annotation wontfix', async () => {
    await runAnnotate([file, '--text', 'not a real bug', '--node', 'n1'], captureIo())
    const id = loadChain(readFileSync(chainPath)).doc().annotations[0]?.id as string
    const code = await runAnnotate([file, '--wontfix', id], captureIo())
    expect(code).toBe(0)
    const chain = loadChain(readFileSync(chainPath))
    expect(chain.doc().annotations.find((a) => a.id === id)?.status).toBe('wontfix')
  })

  it('--resolve on an unknown id is a data error (exit 2)', async () => {
    const io = captureIo()
    const code = await runAnnotate([file, '--resolve', 'nope'], io)
    expect(code).toBe(2)
  })

  it('foundation annotations lists all annotations with status', async () => {
    await runAnnotate([file, '--text', 'first one', '--node', 'n1'], captureIo())
    await runAnnotate([file, '--text', 'second one', '--x', '5', '--y', '6'], captureIo())
    const id1 = loadChain(readFileSync(chainPath)).doc().annotations.find((a) => a.text === 'first one')?.id as string
    await runAnnotate([file, '--resolve', id1], captureIo())

    const io = captureIo()
    const code = await runAnnotations([file], io)
    expect(code).toBe(0)
    expect(io.out.some((l) => l.includes('[resolved]') && l.includes('first one'))).toBe(true)
    expect(io.out.some((l) => l.includes('[open]') && l.includes('second one'))).toBe(true)
  })

  it('foundation annotations reports "no annotations" for a fresh document', async () => {
    const io = captureIo()
    const code = await runAnnotations([file], io)
    expect(code).toBe(0)
    expect(io.out.some((l) => l.includes('no annotations'))).toBe(true)
  })

  it('foundation annotations falls back to the text\'s own block when there is no chain', async () => {
    await runAnnotate([file, '--text', 'via chain', '--node', 'n1'], captureIo())
    rmSync(chainPath)
    const io = captureIo()
    const code = await runAnnotations([file], io)
    expect(code).toBe(0)
    expect(io.out.some((l) => l.includes('via chain'))).toBe(true)
  })

  it('usage error when file is missing (exit 2)', async () => {
    const io = captureIo()
    expect(await runAnnotate([], io)).toBe(2)
    expect(io.err.some((l) => l.includes('usage'))).toBe(true)
    const io2 = captureIo()
    expect(await runAnnotations([], io2)).toBe(2)
  })

  it('an uncommitted text edit is not clobbered by an annotate write (chain still commits, text left alone with a warning)', async () => {
    const original = readFileSync(file, 'utf8')
    writeFileSync(file, original.replace('Hello, Foundation', 'Hello, Edited'), 'utf8')

    const io = captureIo()
    const code = await runAnnotate([file, '--text', 'note', '--node', 'n1'], io)
    expect(code).toBe(0)
    expect(io.out.some((l) => l.includes('uncommitted edits'))).toBe(true)

    // the hand-edit survives untouched
    expect(readFileSync(file, 'utf8')).toContain('Hello, Edited')
    // but the chain commit still happened
    const chain = loadChain(readFileSync(chainPath))
    expect(chain.doc().annotations).toHaveLength(1)
  })

  it('--author is honored on the envelope', async () => {
    const code = await runAnnotate([file, '--text', 'x', '--node', 'n1', '--author', 'agent:bee'], captureIo())
    expect(code).toBe(0)
    const chain = loadChain(readFileSync(chainPath))
    expect(chain.head().author).toBe('agent:bee')
  })

  it('missing --text with no --resolve/--wontfix is a usage error', async () => {
    const io = captureIo()
    const code = await runAnnotate([file], io)
    expect(code).toBe(2)
    expect(io.err.some((l) => l.includes('usage'))).toBe(true)
  })
})
