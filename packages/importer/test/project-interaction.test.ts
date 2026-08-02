import { describe, expect, it } from 'vitest'
import { projectArtifact } from '../src/project/index.js'
import { artifact, classIndex, prop } from './fixtures.js'

/**
 * Interaction check: pairwise probes (varied = "propA+propB", API.md's
 * literal-but-unwritten-down convention Stage 1 landed on — see
 * src/types.ts's CONTRACT FINDING) verify the folded template against real
 * combined output. Independent effects should pass through native;
 * genuinely interacting effects must be caught and demoted to sealed.
 */
describe('projectArtifact: interaction check (pairwise probes)', () => {
  const classes = classIndex({
    'bg-blue-500': { base: { 'background-color': 'blue' } },
    'bg-gray-500': { base: { 'background-color': 'gray' } },
    'bg-red-600': { base: { 'background-color': 'red' } },
    'opacity-100': { base: { opacity: '1' } },
    'opacity-50': { base: { opacity: '0.5' } },
  })

  it('a matching pairwise probe (props are truly independent) stays native', () => {
    const a = artifact({
      name: 'Btn',
      propSchema: [prop('variant', 'enum'), prop('active', 'boolean', { default: false })],
      samples: [
        { props: { variant: 'primary', active: false }, html: '<button class="bg-blue-500 opacity-100">Btn</button>' },
        { varied: 'variant', props: { variant: 'secondary', active: false }, html: '<button class="bg-gray-500 opacity-100">Btn</button>' },
        { varied: 'active', props: { variant: 'primary', active: true }, html: '<button class="bg-blue-500 opacity-50">Btn</button>' },
        {
          varied: 'variant+active',
          props: { variant: 'secondary', active: true },
          html: '<button class="bg-gray-500 opacity-50">Btn</button>',
        },
      ],
      classIndex: classes,
    })
    const result = projectArtifact(a)
    expect(result.mode).toBe('native')
    expect(result.report.some((r) => r.code === 'import-prop-interaction')).toBe(false)
  })

  it('a mismatching pairwise probe (a genuine interaction) demotes to sealed + import-prop-interaction', () => {
    const a = artifact({
      name: 'Btn',
      propSchema: [prop('variant', 'enum'), prop('active', 'boolean', { default: false })],
      samples: [
        { props: { variant: 'primary', active: false }, html: '<button class="bg-blue-500 opacity-100">Btn</button>' },
        { varied: 'variant', props: { variant: 'secondary', active: false }, html: '<button class="bg-gray-500 opacity-100">Btn</button>' },
        { varied: 'active', props: { variant: 'primary', active: true }, html: '<button class="bg-blue-500 opacity-50">Btn</button>' },
        {
          // special-cased combination: real output is red, not the gray the
          // independent single-prop transformations would predict.
          varied: 'variant+active',
          props: { variant: 'secondary', active: true },
          html: '<button class="bg-red-600 opacity-50">Btn</button>',
        },
      ],
      classIndex: classes,
    })
    const result = projectArtifact(a)
    expect(result.mode).toBe('sealed')
    expect(result.report.some((r) => r.code === 'import-prop-interaction')).toBe(true)
    expect(result.report.some((r) => r.code === 'import-sealed')).toBe(true)
    // sealed fallback still carries the baseline html/css and provenance
    expect(result.component.sealed?.html).toContain('<button')
    expect(result.component.provenance).toStrictEqual(a.provenance)
    expect(result.extraLookups).toHaveLength(0)
  })

  it('the comma-joined fallback convention is also recognized (defensive)', () => {
    // if the comparison logic didn't treat unresolved `class=` on the probe
    // side, this would always mismatch regardless of delimiter — this test
    // also guards that regression (see project/interaction.ts's fix note).
    const a = artifact({
      name: 'Btn',
      propSchema: [prop('variant', 'enum'), prop('active', 'boolean', { default: false })],
      samples: [
        { props: { variant: 'primary', active: false }, html: '<button class="bg-blue-500 opacity-100">Btn</button>' },
        { varied: 'variant', props: { variant: 'secondary', active: false }, html: '<button class="bg-gray-500 opacity-100">Btn</button>' },
        { varied: 'active', props: { variant: 'primary', active: true }, html: '<button class="bg-blue-500 opacity-50">Btn</button>' },
        {
          varied: 'variant,active',
          props: { variant: 'secondary', active: true },
          html: '<button class="bg-gray-500 opacity-50">Btn</button>',
        },
      ],
      classIndex: classes,
    })
    const result = projectArtifact(a)
    expect(result.mode).toBe('native')
  })
})
