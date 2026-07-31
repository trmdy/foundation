import { describe, expect, it } from 'vitest'
import { createChain, loadChain } from '../src/chain/index.js'
import { baseDocument } from './chain-fixtures.js'
import type { ChangeMeta } from '../src/types.js'

const AUTHOR: ChangeMeta = { author: 'user:tormod', message: 'seed' }
const M = (message: string): ChangeMeta => ({ author: 'user:tormod', message })

describe('chain envelope — hash chain', () => {
  it('verify() reports ok on a healthy chain, and hashes chain via prevHash', () => {
    const chain = createChain(baseDocument(), AUTHOR)
    chain.apply(M('a'), [{ op: 'set-token', name: 't1', value: '1' }])
    chain.apply(M('b'), [{ op: 'set-token', name: 't1', value: '2' }])
    chain.apply(M('c'), [{ op: 'set-token', name: 't1', value: '3' }])
    expect(chain.verify()).toEqual({ ok: true })
    const log = chain.log()
    expect(log).toHaveLength(4)
    expect(log[0]?.prevHash).toBeNull()
    for (let i = 1; i < log.length; i++) {
      expect(log[i]?.prevHash).toBe(log[i - 1]?.hash)
    }
    // hashes are unique
    expect(new Set(log.map((r) => r.hash)).size).toBe(log.length)
  })

  it('log() and head() survive a save/load roundtrip byte for byte', () => {
    const chain = createChain(baseDocument(), AUTHOR)
    chain.apply(M('a'), [{ op: 'set-token', name: 't1', value: '1' }])
    const bytes = chain.save()
    const reloaded = loadChain(bytes)
    expect(reloaded.log()).toEqual(chain.log())
    expect(reloaded.head()).toEqual(chain.head())
    expect(reloaded.verify()).toEqual({ ok: true })
  })

  it('verify() catches a broken chain: a forged prevHash does not resolve', () => {
    // Two things independently established while writing this test (see
    // final report): (1) Loro's snapshot format carries its own checksum and
    // REJECTS single-byte-corrupted bytes outright at fromSnapshot() — so
    // "flip a byte in save() output" cannot reach verify() at all, it throws
    // earlier, at load time. (2) Loro's import() enforces causal delivery —
    // feeding it a change whose dependencies are missing leaves it
    // permanently "pending" and invisible to getAllChanges(), so a genuine
    // history *gap* can't be constructed through the public merge API either
    // (Loro already prevents it). What verify()'s prevHash-linkage check
    // actually guards against is a dishonest/malformed envelope entering an
    // otherwise causally-valid chain — simulated here by committing directly
    // through the chain's own Loro doc (bypassing apply()) with a prevHash
    // that names a hash nothing in this chain ever produced.
    const chain = createChain(baseDocument(), AUTHOR) as unknown as { loro: import('loro-crdt').LoroDoc }
    const real = createChain(baseDocument(), AUTHOR)
    real.apply(M('real change'), [{ op: 'set-token', name: 't', value: '1' }])
    expect(real.verify()).toEqual({ ok: true })

    chain.loro.getMap('tokens').set('sneaky', 'value')
    chain.loro.commit({
      message: JSON.stringify({ author: 'attacker', message: 'forged', specVersion: '0.1.0', prevHash: 'not-a-real-hash' }),
      timestamp: 999,
    })
    const asChain = chain as unknown as ReturnType<typeof createChain>
    const result = asChain.verify()
    expect(result.ok).toBe(false)
    expect(typeof result.brokenAt).toBe('string')
  })
})
