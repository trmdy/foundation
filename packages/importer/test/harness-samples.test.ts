import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { FdnProp } from 'foundation-engine'
import { buildSampleMatrix, sentinelFor } from '../src/harness/samples.js'
import { harvestComponent } from '../src/harness/index.js'

describe('buildSampleMatrix (unit, synthetic render)', () => {
  const propSchema: FdnProp[] = [
    { name: 'variant', type: 'enum', default: 'a' },
    { name: 'label', type: 'string' },
    { name: 'active', type: 'boolean' },
  ]
  const enumValues = new Map([['variant', ['a', 'b', 'c']]])

  function render(props: Record<string, unknown>): string {
    return JSON.stringify(props)
  }

  it('baseline has no `varied`, uses defaults, and sentinels every string prop', () => {
    const samples = buildSampleMatrix({ propSchema, enumValues, render })
    const baseline = samples[0]
    expect(baseline?.varied).toBeUndefined()
    expect(baseline?.props).toEqual({ variant: 'a', label: sentinelFor('label'), active: false })
  })

  it('varies every enum value one-at-a-time, keeping other props at baseline', () => {
    const samples = buildSampleMatrix({ propSchema, enumValues, render })
    const variantSamples = samples.filter((s) => s.varied === 'variant')
    expect(variantSamples.map((s) => s.props.variant)).toEqual(['a', 'b', 'c'])
    for (const s of variantSamples) {
      expect(s.props.label).toBe(sentinelFor('label'))
      expect(s.props.active).toBe(false)
    }
  })

  it('varies booleans to both true and false', () => {
    const samples = buildSampleMatrix({ propSchema, enumValues, render })
    const activeSamples = samples.filter((s) => s.varied === 'active')
    expect(activeSamples.map((s) => s.props.active)).toEqual([true, false])
  })

  it('emits a pairwise probe set for every enum x boolean pair as "<enum>+<bool>"', () => {
    const samples = buildSampleMatrix({ propSchema, enumValues, render })
    const pairwise = samples.filter((s) => s.varied === 'variant+active')
    // 3 enum values x 2 boolean values
    expect(pairwise).toHaveLength(6)
    for (const s of pairwise) {
      expect(s.props).toHaveProperty('variant')
      expect(s.props).toHaveProperty('active')
    }
    const combos = pairwise.map((s) => `${s.props.variant}:${s.props.active}`).sort()
    expect(combos).toEqual(['a:false', 'a:true', 'b:false', 'b:true', 'c:false', 'c:true'])
  })

  it('every sample actually calls the render function with its own props', () => {
    const samples = buildSampleMatrix({ propSchema, enumValues, render })
    for (const s of samples) {
      expect(s.html).toBe(JSON.stringify(s.props))
    }
  })
})

describe('sample matrix via harvestComponent (integration, button.tsx)', () => {
  const buttonPath = path.resolve(import.meta.dirname, '../fixtures/button.tsx')

  it('covers every enum value for both variant and size', async () => {
    const artifact = await harvestComponent({ source: buttonPath })
    const variantValues = artifact.samples.filter((s) => s.varied === 'variant').map((s) => s.props.variant)
    const sizeValues = artifact.samples.filter((s) => s.varied === 'size').map((s) => s.props.size)
    expect(variantValues.sort()).toEqual(['default', 'destructive', 'outline'])
    expect(sizeValues.sort()).toEqual(['default', 'lg', 'sm'])
  })

  it('covers both boolean values for disabled', async () => {
    const artifact = await harvestComponent({ source: buttonPath })
    const disabledValues = artifact.samples.filter((s) => s.varied === 'disabled').map((s) => s.props.disabled)
    expect(disabledValues.sort()).toEqual([false, true])
  })

  it('produces enum x boolean pairwise probes with the "<a>+<b>" format and both props present', async () => {
    const artifact = await harvestComponent({ source: buttonPath })
    const pairwise = artifact.samples.filter((s) => s.varied?.includes('+'))
    expect(pairwise.length).toBeGreaterThan(0)
    for (const s of pairwise) {
      const [a, b] = (s.varied as string).split('+')
      expect(s.props).toHaveProperty(a as string)
      expect(s.props).toHaveProperty(b as string)
    }
    expect(new Set(pairwise.map((s) => s.varied))).toEqual(new Set(['variant+disabled', 'size+disabled']))
  })
})
