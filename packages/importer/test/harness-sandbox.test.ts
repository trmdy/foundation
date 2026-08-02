import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { harvestComponent } from '../src/harness/index.js'
import { HarnessError } from '../src/errors.js'

const fixturesDir = path.resolve(import.meta.dirname, '../fixtures')

describe('SSR sandbox determinism', () => {
  it('two harvests of the same component produce byte-identical artifacts', async () => {
    const a = await harvestComponent({ source: path.join(fixturesDir, 'button.tsx') })
    const b = await harvestComponent({ source: path.join(fixturesDir, 'button.tsx') })
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('two harvests of a component with children/boolean variation are also byte-identical', async () => {
    const overrides = { props: [{ name: 'children' as const, type: 'string' as const }] }
    const a = await harvestComponent({ source: path.join(fixturesDir, 'card.tsx'), ...overrides })
    const b = await harvestComponent({ source: path.join(fixturesDir, 'card.tsx'), ...overrides })
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })
})

describe('sentinel substitution', () => {
  it('the baseline sample substitutes the sentinel for every string prop', async () => {
    const artifact = await harvestComponent({ source: path.join(fixturesDir, 'button.tsx') })
    const baseline = artifact.samples[0]
    expect(baseline?.varied).toBeUndefined()
    expect(baseline?.html).toContain('⟦fdn:prop:children⟧')
  })

  it('substitutes the sentinel inside an attribute value too (icon.tsx aria-label)', async () => {
    const artifact = await harvestComponent({ source: path.join(fixturesDir, 'icon.tsx') })
    const baseline = artifact.samples[0]
    expect(baseline?.html).toContain('aria-label="⟦fdn:prop:label⟧"')
  })
})

describe('banned APIs throw legibly', () => {
  it('a component calling fetch() during render rejects with a HarnessError naming the API', async () => {
    await expect(harvestComponent({ source: path.join(fixturesDir, 'banned-api.tsx') })).rejects.toThrow(
      HarnessError,
    )
    try {
      await harvestComponent({ source: path.join(fixturesDir, 'banned-api.tsx') })
      expect.unreachable('expected harvestComponent to reject')
    } catch (err) {
      expect(err).toBeInstanceOf(HarnessError)
      expect((err as HarnessError).code).toBe('banned-api')
      expect((err as Error).message).toMatch(/fetch/)
    }
  })
})

describe('component throwing during render', () => {
  it('surfaces as a structured render-error, not a crash', async () => {
    await expect(harvestComponent({ source: path.join(fixturesDir, 'render-throw.tsx') })).rejects.toThrow(
      HarnessError,
    )
    try {
      await harvestComponent({ source: path.join(fixturesDir, 'render-throw.tsx') })
      expect.unreachable('expected harvestComponent to reject')
    } catch (err) {
      expect(err).toBeInstanceOf(HarnessError)
      expect((err as HarnessError).code).toBe('render-error')
      expect((err as Error).message).toContain('boom from inside the component')
    }
  })
})
