import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createChain, exportBlobs, importBlobs, loadChain, mergeChains } from '../src/chain/index.js'
import { baseDocument, el } from './chain-fixtures.js'
import type { ChangeMeta } from '../src/types.js'

const SEED: ChangeMeta = { author: 'user:seed', message: 'seed' }

describe('exportBlobs / importBlobs (SPEC 13a-iv blob-directory exchange)', () => {
  let mailbox: string

  beforeEach(() => {
    mailbox = mkdtempSync(join(tmpdir(), 'fdn-mailbox-'))
  })

  afterEach(() => {
    rmSync(mailbox, { recursive: true, force: true })
  })

  it('exportBlobs writes one .fdnc file per change under <dir>/<docId>/', async () => {
    const chain = createChain(baseDocument(), SEED, { docId: 'doc-1' })
    chain.apply({ author: 'user:a', message: 'edit 1' }, [{ op: 'set-token', name: 't1', value: '1' }])
    chain.apply({ author: 'user:a', message: 'edit 2' }, [{ op: 'set-token', name: 't2', value: '2' }])

    const { written } = await exportBlobs(chain, mailbox)
    expect(written).toBe(3) // seed + edit 1 + edit 2
    const files = readdirSync(join(mailbox, 'doc-1'))
    expect(files).toHaveLength(3)
    expect(files.every((f) => f.endsWith('.fdnc'))).toBe(true)
  })

  it('a second push is idempotent — writes 0 new blobs', async () => {
    const chain = createChain(baseDocument(), SEED, { docId: 'doc-2' })
    await exportBlobs(chain, mailbox)
    const second = await exportBlobs(chain, mailbox)
    expect(second.written).toBe(0)
  })

  it('exportBlobs throws a clear error when the chain has no docId', async () => {
    const chain = createChain(baseDocument(), SEED)
    await expect(exportBlobs(chain, mailbox)).rejects.toThrow(/docId/)
  })

  it('a second pull is idempotent — imports 0', async () => {
    const a = createChain(baseDocument(), SEED, { docId: 'doc-3' })
    a.apply({ author: 'user:a', message: 'from a' }, [{ op: 'set-token', name: 'ta', value: '1' }])
    await exportBlobs(a, mailbox)

    const b = loadChain(a.save(), { actor: 'user:b' })
    const first = await importBlobs(b, mailbox)
    expect(first.imported).toBe(0) // b already has everything a pushed (it's a's own snapshot)

    // give b something new to pull: a makes another change and pushes it
    a.apply({ author: 'user:a', message: 'more from a' }, [{ op: 'set-token', name: 'ta2', value: '2' }])
    await exportBlobs(a, mailbox)
    const second = await importBlobs(b, mailbox)
    expect(second.imported).toBe(1)
    const third = await importBlobs(b, mailbox)
    expect(third.imported).toBe(0)
  })

  /**
   * THE async-designer scenario (task brief): two designers fork the same
   * document, edit disjoint parts of it offline/async, and later exchange
   * work purely by pushing/pulling through one shared mailbox directory —
   * no live connection between them at any point. Both must converge to the
   * same materialized document, and since their edits don't touch the same
   * property, no overlap should be reported.
   */
  it('two chains diverge, exchange via one mailbox dir, and converge (disjoint edits -> no overlap)', async () => {
    const designerA = createChain(baseDocument(), SEED, { docId: 'doc-async' })
    const designerB = loadChain(designerA.save(), { actor: 'user:designer-b' })

    designerA.apply({ author: 'user:designer-a', message: 'a renames child 1' }, [
      { op: 'set-text', id: 'n-child-1', text: 'hello from A' },
    ])
    designerB.apply({ author: 'user:designer-b', message: 'b adds a footer style' }, [
      { op: 'set-style', id: 'n-second-root', prop: 'color', value: 'green' },
    ])

    // both push to the same mailbox — append-only + content-addressed makes
    // directory UNION the merge (SPEC 13a-iv), so order between these two
    // pushes doesn't matter.
    await exportBlobs(designerA, mailbox)
    await exportBlobs(designerB, mailbox)

    const pullA = await importBlobs(designerA, mailbox)
    const pullB = await importBlobs(designerB, mailbox)

    expect(pullA.imported).toBeGreaterThan(0)
    expect(pullB.imported).toBeGreaterThan(0)
    expect(pullA.overlaps.lines).toHaveLength(0)
    expect(pullB.overlaps.lines).toHaveLength(0)

    const docA = designerA.doc()
    const docB = designerB.doc()
    expect(docA).toEqual(docB)
    expect(docA.body[0]?.children.find((n) => n.id === 'n-child-1')?.text).toBe('hello from A')
    expect(docA.body[1]?.style.color).toBe('green')

    // re-pulling either side now imports nothing further.
    expect((await importBlobs(designerA, mailbox)).imported).toBe(0)
    expect((await importBlobs(designerB, mailbox)).imported).toBe(0)
  })

  it('reports concurrent-overlap when both sides write the SAME property', async () => {
    const designerA = createChain(baseDocument(), SEED, { docId: 'doc-conflict' })
    const designerB = loadChain(designerA.save(), { actor: 'user:designer-b' })

    designerA.apply({ author: 'user:designer-a', message: 'a sets text' }, [
      { op: 'set-text', id: 'n-child-1', text: 'from A' },
    ])
    designerB.apply({ author: 'user:designer-b', message: 'b sets the same text' }, [
      { op: 'set-text', id: 'n-child-1', text: 'from B' },
    ])

    await exportBlobs(designerA, mailbox)
    await exportBlobs(designerB, mailbox)

    const pullA = await importBlobs(designerA, mailbox)
    expect(pullA.imported).toBeGreaterThan(0)
    expect(pullA.overlaps.lines.some((l) => l.code === 'concurrent-overlap' && l.nodeId === 'n-child-1')).toBe(true)
  })
})

describe('mergeChains (SPEC 13a-iv two-chain merge)', () => {
  it('converges and regenerates a projectable merged chain', () => {
    const a = createChain(baseDocument(), SEED, { docId: 'doc-merge' })
    const b = loadChain(a.save(), { actor: 'user:b' })

    a.apply({ author: 'user:a', message: 'insert on a' }, [
      { op: 'insert-node', parent: 'n-root', index: 0, node: el('n-from-a', 'i') },
    ])
    b.apply({ author: 'user:b', message: 'insert on b' }, [
      { op: 'insert-node', parent: 'n-root', index: 0, node: el('n-from-b', 'em') },
    ])

    const { merged, overlaps } = mergeChains(a.save(), b.save())
    expect(overlaps.lines).toHaveLength(0)

    const mergedChain = loadChain(merged)
    expect(mergedChain.docId()).toBe('doc-merge')
    const ids = mergedChain.doc().body[0]?.children.map((n) => n.id) ?? []
    expect(ids).toContain('n-from-a')
    expect(ids).toContain('n-from-b')
  })

  it('reports overlap when both sides set the same property to different values, absent when disjoint', () => {
    const a = createChain(baseDocument(), SEED, { docId: 'doc-merge-2' })
    const b = loadChain(a.save(), { actor: 'user:b' })

    a.apply({ author: 'user:a', message: 'a sets token' }, [{ op: 'set-token', name: 'shared', value: 'from-a' }])
    b.apply({ author: 'user:b', message: 'b sets same token differently' }, [
      { op: 'set-token', name: 'shared', value: 'from-b' },
    ])

    const conflicting = mergeChains(a.save(), b.save())
    expect(conflicting.overlaps.lines.length).toBeGreaterThan(0)
    expect(conflicting.overlaps.lines.some((l) => l.code === 'concurrent-overlap')).toBe(true)

    const c = createChain(baseDocument(), SEED, { docId: 'doc-merge-3' })
    const d = loadChain(c.save(), { actor: 'user:d' })
    c.apply({ author: 'user:c', message: 'c sets its own token' }, [{ op: 'set-token', name: 'only-c', value: '1' }])
    d.apply({ author: 'user:d', message: 'd sets a different token' }, [{ op: 'set-token', name: 'only-d', value: '1' }])

    const disjoint = mergeChains(c.save(), d.save())
    expect(disjoint.overlaps.lines).toHaveLength(0)
  })
})
