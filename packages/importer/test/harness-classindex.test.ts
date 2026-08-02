import { describe, expect, it } from 'vitest'
import { buildClassIndex, resolveThemeVars } from '../src/harness/class-index.js'
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

  it('regression (dogfood cycle 3, friction §2): keys a var()-referencing arbitrary value by the LITERAL token, not printCandidate\'s normalized form', async () => {
    // bg-[var(--custom)] used to key under printCandidate's normalized
    // "bg-(color:--custom)" — a string that never appears in any html — so
    // project/style.ts's lookup by the literal token always missed. Same
    // bug, same fix, for the v4 shorthand form.
    const index = await buildClassIndex(['<div class="bg-[var(--custom)]"></div>'])
    expect(index['bg-[var(--custom)]']).toBeDefined()
    expect(index['bg-[var(--custom)]']?.base['background-color']).toBe('var(--custom)')
    expect(index['bg-(color:--custom)']).toBeUndefined()
  })

  it('regression: keys the v4 shorthand var() form (bg-(--custom)) by its own literal token too', async () => {
    const index = await buildClassIndex(['<div class="bg-(--custom)"></div>'])
    expect(index['bg-(--custom)']).toBeDefined()
    expect(index['bg-(--custom)']?.base['background-color']).toBe('var(--custom)')
  })

  it('regression: a hover-variant var() arbitrary value keys states under the literal base token', async () => {
    const index = await buildClassIndex(['<div class="hover:bg-[var(--custom-hover)]"></div>'])
    expect(index['bg-[var(--custom-hover)]']?.states?.hover?.['background-color']).toBe('var(--custom-hover)')
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

describe('resolveThemeVars (follow-up wave: Tailwind theme vars become Foundation tokens on import)', () => {
  it('resolves a directly-referenced theme var, keyed without the leading --', async () => {
    const index = await buildClassIndex(['<div class="bg-green-100"></div>'])
    const { themeVars, unresolvedThemeVars } = await resolveThemeVars(index)
    expect(themeVars['color-green-100']).toBe('oklch(96.2% 0.044 156.743)')
    expect(unresolvedThemeVars).toEqual([])
  })

  it('resolves transitively: a var whose OWN definition references another var', async () => {
    // text-xs emits `line-height: var(--tw-leading, var(--text-xs--line-height))` —
    // --tw-leading has no theme definition (Tailwind cascade-plumbing var,
    // set by a leading-* utility that wasn't used here), --text-xs--line-height
    // does. Both must be discoverable from the ONE declaration.
    const index = await buildClassIndex(['<div class="text-xs"></div>'])
    const { themeVars, unresolvedThemeVars } = await resolveThemeVars(index)
    expect(themeVars['text-xs']).toBe('0.75rem')
    expect(themeVars['text-xs--line-height']).toBeDefined()
    expect(unresolvedThemeVars).toContain('--tw-leading')
  })

  it('collects vars referenced from both base and state (hover/focus/…) declarations', async () => {
    const index = await buildClassIndex(['<button class="bg-red-500 hover:bg-red-600"></button>'])
    const { themeVars } = await resolveThemeVars(index)
    expect(themeVars['color-red-500']).toBeDefined()
    expect(themeVars['color-red-600']).toBeDefined()
  })

  it('a declaration with no var() reference at all (e.g. rounded-full\'s calc()) contributes nothing', async () => {
    const index = await buildClassIndex(['<div class="rounded-full"></div>'])
    const { themeVars, unresolvedThemeVars } = await resolveThemeVars(index)
    expect(themeVars).toEqual({})
    expect(unresolvedThemeVars).toEqual([])
  })

  it('returns {} / [] for an empty classIndex', async () => {
    const { themeVars, unresolvedThemeVars } = await resolveThemeVars({})
    expect(themeVars).toEqual({})
    expect(unresolvedThemeVars).toEqual([])
  })

  it('is deterministic and sorted', async () => {
    const index = await buildClassIndex(['<div class="bg-green-100 text-green-800 rounded-full text-xs"></div>'])
    const r1 = await resolveThemeVars(index)
    const r2 = await resolveThemeVars(index)
    expect(r1).toStrictEqual(r2)
    expect(Object.keys(r1.themeVars)).toEqual([...Object.keys(r1.themeVars)].sort())
    expect(r1.unresolvedThemeVars).toEqual([...r1.unresolvedThemeVars].sort())
  })

  it('harvestComponent populates RenderArtifact.themeVars for badge.tsx (real fixture, real cva variants)', async () => {
    const artifact = await harvestComponent({ source: path.resolve(import.meta.dirname, '../fixtures/badge.tsx') })
    // Badge's three variants (default/success/warning) each contribute a
    // background + text color utility, plus rounded-full/px/py/text-xs/
    // font-semibold shared across all of them.
    expect(artifact.themeVars['color-blue-100']).toBeDefined()
    expect(artifact.themeVars['color-green-100']).toBeDefined()
    expect(artifact.themeVars['color-amber-100']).toBeDefined()
    expect(artifact.themeVars['color-blue-800']).toBeDefined()
    expect(artifact.themeVars['color-green-800']).toBeDefined()
    expect(artifact.themeVars['color-amber-800']).toBeDefined()
    expect(artifact.themeVars['font-weight-semibold']).toBe('600')
    expect(artifact.themeVars['spacing']).toBeDefined()
    expect(artifact.unresolvedThemeVars).toContain('--tw-leading')
  })

  it("icon.tsx (empty classIndex) has empty themeVars/unresolvedThemeVars too", async () => {
    const artifact = await harvestComponent({ source: path.resolve(import.meta.dirname, '../fixtures/icon.tsx') })
    expect(artifact.themeVars).toEqual({})
    expect(artifact.unresolvedThemeVars).toEqual([])
  })
})
