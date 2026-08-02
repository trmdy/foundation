import { describe, expect, it } from 'vitest'
import { buildClassIndex } from '../src/harness/class-index.js'
import { projectArtifact } from '../src/project/index.js'
import { artifact, classIndex, prop } from './fixtures.js'

describe('projectArtifact: Tailwind class resolution', () => {
  it('merges base declarations into inline style, later classes winning, class attr consumed', () => {
    const a = artifact({
      name: 'Box',
      samples: [{ props: {}, html: '<div class="p-4 text-red-500 text-blue-500">x</div>' }],
      classIndex: classIndex({
        'p-4': { base: { padding: '1rem' } },
        'text-red-500': { base: { color: 'red' } },
        'text-blue-500': { base: { color: 'blue' } }, // later class wins
      }),
    })
    const result = projectArtifact(a)
    expect(result.mode).toBe('native')
    const node = result.component.body[0]
    expect(node?.attrs['class']).toBeUndefined()
    expect(node?.style['color']).toBe('blue')
  })

  it('longhand-normalizes a shorthand declaration the same way engine parse does', () => {
    const a = artifact({
      name: 'Box',
      samples: [{ props: {}, html: '<div class="p-4">x</div>' }],
      classIndex: classIndex({ 'p-4': { base: { padding: '4px 8px' } } }),
    })
    const result = projectArtifact(a)
    const style = result.component.body[0]?.style ?? {}
    expect(style['padding']).toBeUndefined()
    expect(style['padding-top']).toBe('4px')
    expect(style['padding-right']).toBe('8px')
    expect(style['padding-bottom']).toBe('4px')
    expect(style['padding-left']).toBe('8px')
  })

  it('resolves recognized state-variant prefixes into style-hover/-focus/-active/-disabled', () => {
    const a = artifact({
      name: 'Btn',
      samples: [{ props: {}, html: '<button class="bg-blue-500 hover:bg-blue-700 focus:ring active:scale-95 disabled:opacity-50">x</button>' }],
      classIndex: classIndex({
        'bg-blue-500': { base: { 'background-color': 'blue' } },
        'bg-blue-700': { base: {}, states: { hover: { 'background-color': 'darkblue' } } },
        ring: { base: {}, states: { focus: { 'box-shadow': '0 0 0 2px' } } },
        'scale-95': { base: {}, states: { active: { transform: 'scale(0.95)' } } },
        'opacity-50': { base: {}, states: { disabled: { opacity: '0.5' } } },
      }),
    })
    const result = projectArtifact(a)
    expect(result.mode).toBe('native')
    const node = result.component.body[0]
    expect(node?.styleStates.hover).toStrictEqual({ 'background-color': 'darkblue' })
    expect(node?.styleStates.focus).toStrictEqual({ 'box-shadow': '0 0 0 2px' })
    expect(node?.styleStates.active).toStrictEqual({ transform: 'scale(0.95)' })
    expect(node?.styleStates.disabled).toStrictEqual({ opacity: '0.5' })
  })

  it('drops an unsupported variant prefix (md:/dark:) and reports import-unsupported-variant, without forcing sealed', () => {
    const a = artifact({
      name: 'Box',
      samples: [{ props: {}, html: '<div class="p-4 md:flex dark:bg-black">x</div>' }],
      classIndex: classIndex({
        'p-4': { base: { padding: '1rem' } },
        flex: { base: {}, unsupported: ['md'] },
        'bg-black': { base: {}, unsupported: ['dark'] },
      }),
    })
    const result = projectArtifact(a)
    expect(result.mode).toBe('native')
    const lines = result.report.filter((r) => r.code === 'import-unsupported-variant')
    expect(lines.length).toBe(2)
    expect(result.component.body[0]?.attrs['class']).toBeUndefined()
  })

  it('drops a recognized state prefix with no resolved declarations and reports import-unsupported-variant', () => {
    const a = artifact({
      name: 'Box',
      samples: [{ props: {}, html: '<div class="hover:opacity-90">x</div>' }],
      classIndex: classIndex({ 'opacity-90': { base: {} } }), // no `states.hover` entry
    })
    const result = projectArtifact(a)
    expect(result.mode).toBe('native')
    expect(result.report.some((r) => r.code === 'import-unsupported-variant')).toBe(true)
  })

  it('regression (dogfood cycle 3, friction §2): bg-[var(--custom)] projects NATIVE, classIndex built via the real Tailwind compiler', async () => {
    // End-to-end reproduction of the bee's stuck loop: real buildClassIndex
    // output (not a hand-built fixture) fed straight into projectArtifact
    // against the SAME html it was compiled from. Before the fix, the
    // printCandidate-normalized key never matched the literal token in the
    // html, so this class always missed classIndex, forced sealed, and
    // dropped the declaration from the sealed capsule's css too (friction §3).
    const html = '<div class="bg-[var(--custom)]">x</div>'
    const index = await buildClassIndex([html])
    const a = artifact({ name: 'UsageMeter', samples: [{ props: {}, html }], classIndex: index })
    const result = projectArtifact(a)
    expect(result.mode).toBe('native')
    expect(result.report.some((r) => r.code === 'import-unprojectable-css')).toBe(false)
    expect(result.component.body[0]?.style['background-color']).toBe('var(--custom)')
  })

  it('regression: the v4 shorthand form bg-(--custom) also projects NATIVE with the declaration resolved', async () => {
    const html = '<div class="bg-(--custom)">x</div>'
    const index = await buildClassIndex([html])
    const a = artifact({ name: 'UsageMeter', samples: [{ props: {}, html }], classIndex: index })
    const result = projectArtifact(a)
    expect(result.mode).toBe('native')
    expect(result.component.body[0]?.style['background-color']).toBe('var(--custom)')
  })

  it('an entirely unknown class forces sealed and reports import-unprojectable-css', () => {
    const a = artifact({
      name: 'Box',
      propSchema: [prop('label', 'string')],
      samples: [{ props: { label: '⟦fdn:prop:label⟧' }, html: '<div class="totally-unknown-class">⟦fdn:prop:label⟧</div>' }],
      classIndex: classIndex({}),
    })
    const result = projectArtifact(a)
    expect(result.mode).toBe('sealed')
    expect(result.report.some((r) => r.code === 'import-unprojectable-css')).toBe(true)
    expect(result.report.some((r) => r.code === 'import-sealed')).toBe(true)
    expect(result.component.sealed?.html).toBe('<div class="totally-unknown-class">⟦fdn:prop:label⟧</div>')
  })
})
