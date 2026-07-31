import { hostname, userInfo } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defaultAuthor } from '../src/identity.js'

/**
 * SPEC 13a-ii: CLI author defaults to `user:<os-username>@<hostname>` (never
 * a shared literal — "peer ids derive from author strings; shared defaults
 * collide — proven"), with HIVE_BEE overriding to `agent:<HIVE_BEE>` when set.
 */
describe('defaultAuthor (SPEC 13a-ii)', () => {
  const originalHiveBee = process.env.HIVE_BEE

  beforeEach(() => {
    delete process.env.HIVE_BEE
  })

  afterEach(() => {
    if (originalHiveBee === undefined) delete process.env.HIVE_BEE
    else process.env.HIVE_BEE = originalHiveBee
  })

  it('defaults to user:<os-username>@<hostname> when HIVE_BEE is unset', () => {
    expect(defaultAuthor()).toBe(`user:${userInfo().username}@${hostname()}`)
  })

  it('never returns the shared literal "user:local"', () => {
    expect(defaultAuthor()).not.toBe('user:local')
  })

  it('prefers agent:<HIVE_BEE> when HIVE_BEE is set', () => {
    process.env.HIVE_BEE = 'bee-42'
    expect(defaultAuthor()).toBe('agent:bee-42')
  })
})
