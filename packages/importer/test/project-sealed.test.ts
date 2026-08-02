import { describe, expect, it } from 'vitest'
import { projectArtifact } from '../src/project/index.js'
import { artifact, classIndex, prop } from './fixtures.js'

describe('projectArtifact: sealed fallback', () => {
  it('--sealed (forceSealed) always produces a sealed component, verbatim baseline html', () => {
    const a = artifact({
      name: 'Simple',
      samples: [{ props: {}, html: '<div class="p-4">hi</div>' }],
      classIndex: classIndex({ 'p-4': { base: { padding: '1rem' } } }),
    })
    const result = projectArtifact(a, { forceSealed: true })
    expect(result.mode).toBe('sealed')
    expect(result.component.sealed?.html).toBe('<div class="p-4">hi</div>')
    expect(result.component.body).toStrictEqual([])
    expect(result.report.some((r) => r.code === 'import-sealed' && String(r.message).includes('--sealed'))).toBe(true)
  })

  it('sealed css is the classIndex rules for classes actually used, base + state pseudo-classes, unscoped', () => {
    const a = artifact({
      name: 'Simple',
      samples: [{ props: {}, html: '<button class="px-4 hover:bg-blue-700 unused-elsewhere">hi</button>' }],
      classIndex: classIndex({
        'px-4': { base: { 'padding-left': '1rem', 'padding-right': '1rem' } },
        'bg-blue-700': { base: {}, states: { hover: { 'background-color': 'darkblue' } } },
      }),
    })
    const result = projectArtifact(a, { forceSealed: true })
    const css = result.component.sealed?.css ?? ''
    expect(css).toContain('.px-4 { padding-left: 1rem; padding-right: 1rem; }')
    // selector uses the LITERAL class token as written in html
    // ("hover:bg-blue-700"), colon-escaped, plus the real :hover
    // pseudo-class appended — matching Tailwind's own generated css shape.
    expect(css).toContain('.hover\\:bg-blue-700:hover { background-color: darkblue; }')
    // css is unscoped — no capsule-class prefix (bake adds that)
    expect(css).not.toContain('fdn-capsule')
  })

  it('an unresolvable class in the sealed css is omitted, not thrown, and reported', () => {
    const a = artifact({
      name: 'Simple',
      samples: [{ props: {}, html: '<div class="mystery-class">hi</div>' }],
      classIndex: classIndex({}),
    })
    const result = projectArtifact(a, { forceSealed: true })
    expect(result.component.sealed?.css).toBe('')
    expect(result.report.some((r) => r.code === 'import-unprojectable-css')).toBe(true)
  })

  it('a prop-interaction-triggered sealed fallback still uses the ORIGINAL (un-sentinel-substituted) baseline html', () => {
    const a = artifact({
      name: 'Btn',
      propSchema: [prop('label', 'string')],
      samples: [
        { props: { label: '⟦fdn:prop:label⟧', variant: 'primary', active: false }, html: '<button class="bg-blue-500">⟦fdn:prop:label⟧</button>' },
      ],
      classIndex: classIndex({ 'bg-blue-500': { base: { 'background-color': 'blue' } } }),
    })
    const result = projectArtifact(a, { forceSealed: true })
    expect(result.component.sealed?.html).toContain('⟦fdn:prop:label⟧')
    expect(result.component.sealed?.html).not.toContain('{{ prop.label }}')
  })

  it('propSchema and provenance survive into the sealed component (props stay legal to bind, just inert)', () => {
    const a = artifact({
      name: 'Simple',
      propSchema: [prop('label', 'string', { required: true })],
      samples: [{ props: { label: 'x' }, html: '<div>x</div>' }],
    })
    const result = projectArtifact(a, { forceSealed: true })
    expect(result.component.props).toStrictEqual(a.propSchema)
    expect(result.component.provenance).toStrictEqual(a.provenance)
  })

  it('no samples in the artifact falls back to sealed gracefully (never throws)', () => {
    const a = artifact({ name: 'Empty', samples: [] })
    expect(() => projectArtifact(a)).not.toThrow()
    const result = projectArtifact(a)
    expect(result.mode).toBe('sealed')
  })
})
