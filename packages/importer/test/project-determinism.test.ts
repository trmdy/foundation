import { describe, expect, it } from 'vitest'
import { projectArtifact } from '../src/project/index.js'
import { artifact, classIndex, prop } from './fixtures.js'

/** projectArtifact must be a pure function of its input: repeated projection
 *  of the same artifact is byte-identical (API.md acceptance suite: "repeated
 *  import byte-identical"). */
describe('projectArtifact: determinism', () => {
  function buildRichArtifact() {
    return artifact({
      name: 'Btn',
      propSchema: [prop('variant', 'enum'), prop('size', 'enum'), prop('active', 'boolean', { default: false }), prop('label', 'string')],
      samples: [
        {
          props: { variant: 'primary', size: 'md', active: false, label: '⟦fdn:prop:label⟧' },
          html: '<button class="bg-blue-500 h-10 opacity-100">⟦fdn:prop:label⟧</button>',
        },
        {
          varied: 'variant',
          props: { variant: 'secondary', size: 'md', active: false, label: 'x' },
          html: '<button class="bg-gray-500 h-10 opacity-100">x</button>',
        },
        {
          varied: 'size',
          props: { variant: 'primary', size: 'sm', active: false, label: 'x' },
          html: '<button class="bg-blue-500 h-8 opacity-100">x</button>',
        },
        {
          varied: 'size',
          props: { variant: 'primary', size: 'lg', active: false, label: 'x' },
          html: '<button class="bg-blue-500 h-12 opacity-100">x</button>',
        },
        {
          varied: 'active',
          props: { variant: 'primary', size: 'md', active: true, label: 'x' },
          html: '<button class="bg-blue-500 h-10 opacity-50">x</button>',
        },
        {
          varied: 'variant+active',
          props: { variant: 'secondary', size: 'md', active: true, label: 'x' },
          html: '<button class="bg-gray-500 h-10 opacity-50">x</button>',
        },
      ],
      classIndex: classIndex({
        'bg-blue-500': { base: { 'background-color': 'blue' } },
        'bg-gray-500': { base: { 'background-color': 'gray' } },
        'h-10': { base: { height: '2.5rem' } },
        'h-8': { base: { height: '2rem' } },
        'h-12': { base: { height: '3rem' } },
        'opacity-100': { base: { opacity: '1' } },
        'opacity-50': { base: { opacity: '0.5' } },
      }),
    })
  }

  it('projecting the same (native-mode) artifact twice yields byte-identical JSON output', () => {
    const a = buildRichArtifact()
    const r1 = projectArtifact(a)
    const r2 = projectArtifact(a)
    expect(r1.mode).toBe('native')
    expect(JSON.stringify(r1.component)).toBe(JSON.stringify(r2.component))
    expect(JSON.stringify(r1.report)).toBe(JSON.stringify(r2.report))
    expect(JSON.stringify(r1.extraLookups)).toBe(JSON.stringify(r2.extraLookups))
  })

  it('projecting the same (sealed-mode) artifact twice yields byte-identical JSON output', () => {
    const a = artifact({
      name: 'Sealed',
      samples: [{ props: {}, html: '<div class="p-4">x</div>' }],
      classIndex: classIndex({ 'p-4': { base: { padding: '1rem' } } }),
    })
    const r1 = projectArtifact(a, { forceSealed: true })
    const r2 = projectArtifact(a, { forceSealed: true })
    expect(JSON.stringify(r1.component)).toBe(JSON.stringify(r2.component))
  })

  it('node ids are minted deterministically (n1..nN in tree order) on every projection', () => {
    const a = artifact({
      name: 'Tree',
      samples: [{ props: {}, html: '<div><span>a</span><span>b</span></div>' }],
    })
    const r1 = projectArtifact(a)
    const ids = (function collect(nodes: typeof r1.component.body): string[] {
      return nodes.flatMap((n) => [n.id, ...collect(n.children)])
    })(r1.component.body)
    expect(ids).toStrictEqual(['n1', 'n2', 'n3'])
    const r2 = projectArtifact(a)
    expect(r2.component.body[0]?.id).toBe('n1')
  })
})
