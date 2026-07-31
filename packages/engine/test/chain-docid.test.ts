import { describe, expect, it } from 'vitest'
import { createChain, loadChain } from '../src/chain/index.js'
import { baseDocument } from './chain-fixtures.js'
import type { ChangeMeta } from '../src/types.js'

const AUTHOR: ChangeMeta = { author: 'user:tormod', message: 'seed' }

/**
 * SPEC 13a-i: the document id is minted once at creation and carried in the
 * chain's metadata — NOT through FdnDocument/parse/project (types.ts has no
 * field for it; see chain.ts's Wave 3 contract-amendment note and
 * packages/cli/src/docid.ts for the CLI-side text-level stamping).
 */
describe('chain docId (SPEC 13a-i)', () => {
  it('is null when no docId was supplied at creation', () => {
    const chain = createChain(baseDocument(), AUTHOR)
    expect(chain.docId()).toBeNull()
  })

  it('is set at creation and folds into the single init commit (no extra envelope)', () => {
    const chain = createChain(baseDocument(), AUTHOR, { docId: 'doc-123' })
    expect(chain.docId()).toBe('doc-123')
    expect(chain.log()).toHaveLength(1)
    expect(chain.head().message).toBe('seed')
  })

  it('survives save()/load() round-trip', () => {
    const chain = createChain(baseDocument(), AUTHOR, { docId: 'doc-abc' })
    chain.apply({ author: 'user:tormod', message: 'edit' }, [{ op: 'set-token', name: 't', value: '1' }])
    const reloaded = loadChain(chain.save())
    expect(reloaded.docId()).toBe('doc-abc')
  })

  it('is carried by fork() (both peers agree on the same doc id)', () => {
    const chain = createChain(baseDocument(), AUTHOR, { docId: 'doc-xyz' })
    const forked = chain.fork('user:other')
    expect(forked.docId()).toBe('doc-xyz')
  })
})
