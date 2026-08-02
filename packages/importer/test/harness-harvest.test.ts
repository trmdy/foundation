/**
 * End-to-end acceptance: harvestComponent against all four vendored
 * fixtures (API.md Wave 4: "Acceptance suite: vendored fixtures — ShadCN-
 * style button (cva variants), badge, card, and a lucide icon").
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { harvestComponent } from '../src/index.js'

const fixturesDir = path.resolve(import.meta.dirname, '../fixtures')

describe('harvestComponent — acceptance fixtures', () => {
  it('button.tsx: name, propSchema, sample count, and provenance', async () => {
    const source = path.join(fixturesDir, 'button.tsx')
    const artifact = await harvestComponent({ source })

    expect(artifact.name).toBe('Button')
    expect(artifact.propSchema.map((p) => p.name).sort()).toEqual(['children', 'disabled', 'size', 'variant'])
    // baseline(1) + variant(3) + size(3) + disabled(2) + pairwise(3*2 + 3*2 = 12) = 21
    expect(artifact.samples).toHaveLength(21)
    expect(artifact.samples[0]?.varied).toBeUndefined()

    const expectedSha = createHash('sha256').update(readFileSync(source)).digest('hex')
    expect(artifact.provenance).toEqual({ source, contentSha256: expectedSha })
  })

  it('badge.tsx: single enum group, no booleans, no pairwise probes', async () => {
    const artifact = await harvestComponent({ source: path.join(fixturesDir, 'badge.tsx') })
    expect(artifact.name).toBe('Badge')
    // baseline(1) + variant(3), no booleans -> no pairwise
    expect(artifact.samples).toHaveLength(4)
    expect(artifact.samples.every((s) => !s.varied?.includes('+'))).toBe(true)
  })

  it('card.tsx: requires a children override, string + boolean props, composition renders correctly', async () => {
    const artifact = await harvestComponent({
      source: path.join(fixturesDir, 'card.tsx'),
      props: [{ name: 'children', type: 'string' }],
    })
    expect(artifact.name).toBe('Card')
    const byName = Object.fromEntries(artifact.propSchema.map((p) => [p.name, p]))
    expect(byName.title?.type).toBe('string')
    expect(byName.elevated?.type).toBe('boolean')
    expect(byName.children?.type).toBe('string')

    const baseline = artifact.samples[0]
    expect(baseline?.html).toContain('⟦fdn:prop:title⟧')
    expect(baseline?.html).toContain('⟦fdn:prop:children⟧')

    const elevatedTrue = artifact.samples.find((s) => s.varied === 'elevated' && s.props.elevated === true)
    expect(elevatedTrue?.html).toContain('shadow-lg')
    const elevatedFalse = artifact.samples.find((s) => s.varied === 'elevated' && s.props.elevated === false)
    expect(elevatedFalse?.html).toContain('shadow-sm')
  })

  it('icon.tsx: pure-svg degenerate case — no classIndex entries, svg markup present', async () => {
    const artifact = await harvestComponent({ source: path.join(fixturesDir, 'icon.tsx') })
    expect(artifact.name).toBe('Icon')
    expect(artifact.classIndex).toEqual({})
    expect(artifact.samples[0]?.html).toContain('<svg')
    expect(artifact.samples[0]?.html).toContain('<circle')
  })

  it('name override (opts.name) wins over the detected export name', async () => {
    const artifact = await harvestComponent({ source: path.join(fixturesDir, 'badge.tsx'), name: 'MyBadge' })
    expect(artifact.name).toBe('MyBadge')
  })

  it('a props override always wins over an auto-extracted prop', async () => {
    const artifact = await harvestComponent({
      source: path.join(fixturesDir, 'button.tsx'),
      props: [{ name: 'variant', type: 'enum', required: true, default: 'destructive' }],
    })
    const variantProp = artifact.propSchema.find((p) => p.name === 'variant')
    expect(variantProp).toEqual({ name: 'variant', type: 'enum', required: true, default: 'destructive' })
  })
})
