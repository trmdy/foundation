import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadChain, projectDocument } from 'foundation-engine'
import type { FdnDocument } from 'foundation-engine'
import { captureIo } from '../src/io.js'
import { readDocIdAttr } from '../src/docid.js'
import { runNew } from '../src/commands/new.js'
import { runChain } from '../src/commands/chain.js'
import { runIngest } from '../src/commands/ingest.js'

/**
 * SPEC 13a-i doc-id roundtrip: `foundation new` and `chain init` mint
 * crypto.randomUUID(), stamp it as `data-fdn-doc-id` on `<fdn-doc>`, and the
 * chain carries the SAME id in its own metadata. Since FdnDocument has no
 * field for it (types.ts is off-limits — see packages/cli/src/docid.ts and
 * packages/engine/src/chain/chain.ts's Wave 3 contract-amendment note), the
 * id does NOT round-trip through parseDocument/projectDocument itself —
 * these tests assert the CLI-level contract that actually matters: the text
 * on disk and the chain's docId() always agree, and `ingest` (a bare
 * parse->project roundtrip) doesn't silently drop it.
 */
describe('document id roundtrip (SPEC 13a-i)', () => {
  let dir: string
  let target: string
  let file: string
  let chainPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fdn-cli-docid-'))
    target = join(dir, 'board')
    file = `${target}.fdn.html`
    chainPath = `${file}.chain`
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('`new` stamps a data-fdn-doc-id on <fdn-doc> and the auto-inited chain carries the same id', async () => {
    const code = await runNew([target], captureIo())
    expect(code).toBe(0)

    const text = readFileSync(file, 'utf8')
    const docId = readDocIdAttr(text)
    expect(docId).toMatch(/^[0-9a-f-]{36}$/)

    const chain = loadChain(readFileSync(chainPath))
    expect(chain.docId()).toBe(docId)
  })

  it('`new --no-chain` still stamps the id even without a chain', async () => {
    const code = await runNew([target, '--no-chain'], captureIo())
    expect(code).toBe(0)
    expect(existsSync(chainPath)).toBe(false)
    expect(readDocIdAttr(readFileSync(file, 'utf8'))).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('`chain init` on a document that already has an id reuses it (never re-mints)', async () => {
    await runNew([target, '--no-chain'], captureIo())
    const idBefore = readDocIdAttr(readFileSync(file, 'utf8'))

    const code = await runChain(['init', file], captureIo())
    expect(code).toBe(0)

    expect(readDocIdAttr(readFileSync(file, 'utf8'))).toBe(idBefore)
    expect(loadChain(readFileSync(chainPath)).docId()).toBe(idBefore)
  })

  it('`chain init` on a document with NO id mints one and stamps the file', async () => {
    // Hand-build a document (bypassing `new`, which always stamps an id) so
    // `chain init` is genuinely the first thing to establish one.
    writeSkeleton(target)
    expect(readDocIdAttr(readFileSync(file, 'utf8'))).toBeNull()

    const code = await runChain(['init', file], captureIo())
    expect(code).toBe(0)

    const idAfter = readDocIdAttr(readFileSync(file, 'utf8'))
    expect(idAfter).toMatch(/^[0-9a-f-]{36}$/)
    expect(loadChain(readFileSync(chainPath)).docId()).toBe(idAfter)
  })

  it('`ingest` (plain parse->project roundtrip) preserves an existing data-fdn-doc-id', async () => {
    await runNew([target], captureIo())
    const idBefore = readDocIdAttr(readFileSync(file, 'utf8'))
    expect(idBefore).not.toBeNull()

    const code = await runIngest([file], captureIo())
    expect(code).toBe(0)

    expect(readDocIdAttr(readFileSync(file, 'utf8'))).toBe(idBefore)
  })

  it('a second ingest is still a content-level no-op with the id preserved (idempotence)', async () => {
    await runNew([target], captureIo())
    await runIngest([file], captureIo())
    const afterFirst = readFileSync(file, 'utf8')
    const io = captureIo()
    const code = await runIngest([file], io)
    expect(code).toBe(0)
    expect(readFileSync(file, 'utf8')).toBe(afterFirst)
    expect(io.out.some((l) => l.includes('already canonical, unchanged'))).toBe(true)
  })
})

/** Writes a minimal, id-free, chain-untouched `.fdn.html` skeleton directly
 *  (not via `runNew`, which always stamps an id) so a "no id yet" starting
 *  point is genuinely reachable for the "chain init mints one" test. */
function writeSkeleton(targetPath: string): string {
  const filePath = `${targetPath}.fdn.html`
  const doc: FdnDocument = {
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
    annotations: [],
    body: [{ id: 'n1', tag: 'h1', attrs: {}, style: {}, styleStates: {}, text: 'hi', children: [] }],
  }
  writeFileSync(filePath, projectDocument(doc), 'utf8')
  return filePath
}
