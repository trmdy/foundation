import { describe, expect, it } from 'vitest'
import { projectArtifact } from '../src/project/index.js'
import { artifact, classIndex, prop } from './fixtures.js'

describe('projectArtifact: variant folding', () => {
  it('boolean attr/style-only difference -> ternary (import-attr-ternary)', () => {
    const a = artifact({
      name: 'Btn',
      propSchema: [prop('active', 'boolean', { default: false })],
      samples: [
        { props: { active: false }, html: '<button class="text-gray-500">Btn</button>' },
        { varied: 'active', props: { active: true }, html: '<button class="text-blue-500">Btn</button>' },
      ],
      classIndex: classIndex({
        'text-gray-500': { base: { color: 'gray' } },
        'text-blue-500': { base: { color: 'blue' } },
      }),
    })
    const result = projectArtifact(a)
    expect(result.mode).toBe('native')
    expect(result.component.body[0]?.style['color']).toBe("{{ prop.active ? 'blue' : 'gray' }}")
    expect(result.report.some((r) => r.code === 'import-attr-ternary')).toBe(true)
    expect(result.extraLookups).toHaveLength(0)
  })

  it('2-value enum difference -> ternary keyed on the first observed arm', () => {
    const a = artifact({
      name: 'Btn',
      propSchema: [prop('variant', 'enum')],
      samples: [
        { props: { variant: 'primary' }, html: '<button class="bg-blue-500">Btn</button>' },
        { varied: 'variant', props: { variant: 'secondary' }, html: '<button class="bg-gray-500">Btn</button>' },
      ],
      classIndex: classIndex({
        'bg-blue-500': { base: { 'background-color': 'blue' } },
        'bg-gray-500': { base: { 'background-color': 'gray' } },
      }),
    })
    const result = projectArtifact(a)
    expect(result.mode).toBe('native')
    expect(result.component.body[0]?.style['background-color']).toBe(
      "{{ prop.variant == 'primary' ? 'blue' : 'gray' }}",
    )
    expect(result.extraLookups).toHaveLength(0)
  })

  it('3+-value enum difference -> a generated fdn-lookup, referenced as lookupName[prop.x]', () => {
    const a = artifact({
      name: 'Btn',
      propSchema: [prop('size', 'enum')],
      samples: [
        { props: { size: 'md' }, html: '<button class="h-10">Btn</button>' },
        { varied: 'size', props: { size: 'sm' }, html: '<button class="h-8">Btn</button>' },
        { varied: 'size', props: { size: 'lg' }, html: '<button class="h-12">Btn</button>' },
      ],
      classIndex: classIndex({
        'h-10': { base: { height: '2.5rem' } },
        'h-8': { base: { height: '2rem' } },
        'h-12': { base: { height: '3rem' } },
      }),
    })
    const result = projectArtifact(a)
    expect(result.mode).toBe('native')
    expect(result.extraLookups).toHaveLength(1)
    const lookup = result.extraLookups[0]
    expect(lookup?.entries).toStrictEqual({ md: '2.5rem', sm: '2rem', lg: '3rem' })
    expect(result.component.body[0]?.style['height']).toBe(`{{ ${lookup?.name}[prop.size] }}`)
  })

  it('a field that does not actually vary across arms is left as a literal (no over-templating)', () => {
    const a = artifact({
      name: 'Btn',
      propSchema: [prop('variant', 'enum')],
      samples: [
        { props: { variant: 'primary' }, html: '<button class="p-4">Btn</button>' },
        { varied: 'variant', props: { variant: 'secondary' }, html: '<button class="p-4">Btn</button>' },
      ],
      classIndex: classIndex({ 'p-4': { base: { padding: '1rem' } } }),
    })
    const result = projectArtifact(a)
    expect(result.mode).toBe('native')
    // padding got longhand-expanded but never templated (identical across arms)
    expect(result.component.body[0]?.style['padding-top']).toBe('1rem')
    expect(result.report.some((r) => r.code === 'import-attr-ternary')).toBe(false)
  })

  it('structural difference (a node the baseline has disappears for another value) -> when= (import-variant-branch)', () => {
    const a = artifact({
      name: 'Btn',
      propSchema: [prop('withIcon', 'boolean', { default: true })],
      samples: [
        { props: { withIcon: true }, html: '<button><svg></svg><span>Label</span></button>' },
        { varied: 'withIcon', props: { withIcon: false }, html: '<button><span>Label</span></button>' },
      ],
    })
    const result = projectArtifact(a)
    expect(result.mode).toBe('native')
    const button = result.component.body[0]
    const svg = button?.children.find((c) => c.tag === 'svg')
    expect(svg?.when).toBe('prop.withIcon')
    const span = button?.children.find((c) => c.tag === 'span')
    expect(span?.when).toBeUndefined()
    expect(result.report.some((r) => r.code === 'import-variant-branch' && r.severity === 'info')).toBe(true)
  })

  it('a node present only in a variant (not the baseline) is reported unresolved, not silently dropped (documented v1 scope cut)', () => {
    const a = artifact({
      name: 'Btn',
      propSchema: [prop('loading', 'boolean', { default: false })],
      samples: [
        { props: { loading: false }, html: '<button><span>Label</span></button>' },
        { varied: 'loading', props: { loading: true }, html: '<button><svg class="spinner"></svg><span>Label</span></button>' },
      ],
      classIndex: classIndex({ spinner: { base: { animation: 'spin 1s linear infinite' } } }),
    })
    const result = projectArtifact(a)
    expect(result.mode).toBe('native')
    const warn = result.report.find((r) => r.code === 'import-variant-branch' && r.severity === 'warning')
    expect(warn).toBeDefined()
    expect((warn?.detail as { resolved?: boolean })?.resolved).toBe(false)
    // the baseline body itself is unaffected (no svg synthesized) — the
    // documented scope cut, not a crash or corruption.
    expect(result.component.body[0]?.children.some((c) => c.tag === 'svg')).toBe(false)
  })
})
