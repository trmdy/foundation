import { describe, expect, it } from 'vitest'
import { buildClassIndex } from '../src/harness/class-index.js'
import { harvestComponent } from '../src/harness/index.js'
import path from 'node:path'

describe('buildClassIndex (unit, synthetic html)', () => {
  it('resolves declarations for a known Tailwind class (px-4)', async () => {
    const index = await buildClassIndex(['<div class="px-4"></div>'])
    expect(index['px-4']).toBeDefined()
    // Tailwind v4 emits the logical `padding-inline` property for px-*, not
    // separate padding-left/padding-right longhands (contract-finding: the
    // task brief's "px-4 → padding-left/right" example doesn't match v4's
    // actual output; documented here rather than asserted against).
    expect(index['px-4']?.base).toEqual({ 'padding-inline': 'calc(var(--spacing) * 4)' })
  })

  it('buckets hover: declarations under states.hover, keyed by the stripped base name', async () => {
    const index = await buildClassIndex(['<button class="bg-red-500 hover:bg-red-600"></button>'])
    expect(index['bg-red-500']?.base).toEqual({ 'background-color': 'var(--color-red-500)' })
    expect(index['bg-red-600']?.base).toEqual({})
    expect(index['bg-red-600']?.states?.hover).toEqual({ 'background-color': 'var(--color-red-600)' })
  })

  it('buckets focus/active/disabled the same way', async () => {
    const index = await buildClassIndex([
      '<input class="focus:outline-none active:scale-95 disabled:opacity-50" />',
    ])
    expect(index['outline-none']?.states?.focus).toBeDefined()
    expect(index['scale-95']?.states?.active).toBeDefined()
    expect(index['opacity-50']?.states?.disabled).toEqual({ opacity: '50%' })
  })

  it('records unresolvable variant prefixes (md:) in unsupported[]', async () => {
    const index = await buildClassIndex(['<div class="md:flex"></div>'])
    expect(index.flex?.base).toEqual({})
    expect(index.flex?.states).toBeUndefined()
    expect(index.flex?.unsupported).toEqual(['md'])
  })

  it('records dark: and group-hover: as unsupported too', async () => {
    const index = await buildClassIndex(['<div class="dark:bg-black group-hover:opacity-100"></div>'])
    expect(index['bg-black']?.unsupported).toEqual(['dark'])
    expect(index['opacity-100']?.unsupported).toEqual(['group-hover'])
  })

  it('gives non-Tailwind classes an empty base, keyed the same way project/style.ts would look them up', async () => {
    const index = await buildClassIndex(['<div class="totally-custom-class"></div>'])
    expect(index['totally-custom-class']).toEqual({ base: {} })
  })

  it('returns {} for html with no class attributes', async () => {
    const index = await buildClassIndex(['<div></div>'])
    expect(index).toEqual({})
  })

  it('produces deterministically sorted keys', async () => {
    const index = await buildClassIndex(['<div class="text-sm px-4 bg-red-500 rounded-md"></div>'])
    expect(Object.keys(index)).toEqual(['bg-red-500', 'px-4', 'rounded-md', 'text-sm'])
  })
})

describe('classIndex via harvestComponent (integration, button.tsx)', () => {
  it('contains base declarations for every plain utility class used and states for the hover/focus ones', async () => {
    const artifact = await harvestComponent({ source: path.resolve(import.meta.dirname, '../fixtures/button.tsx') })
    expect(artifact.classIndex['inline-flex']?.base).toEqual({ display: 'inline-flex' })
    expect(artifact.classIndex['bg-blue-700']?.states?.hover).toBeDefined()
    expect(artifact.classIndex['outline-none']?.states?.focus).toBeDefined()
    expect(artifact.classIndex['opacity-50']?.states?.disabled).toBeDefined()
  })

  it("icon.tsx (pure svg, no classes) has an empty classIndex — the degenerate case", async () => {
    const artifact = await harvestComponent({ source: path.resolve(import.meta.dirname, '../fixtures/icon.tsx') })
    expect(artifact.classIndex).toEqual({})
  })
})
