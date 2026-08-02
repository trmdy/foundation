/**
 * Stage 2 half of the follow-up wave ("Tailwind theme vars become
 * Foundation tokens on import"): projectArtifact passes artifact.themeVars
 * through as `extraTokens` (the CLI/MCP merge these into doc.tokens — see
 * commands/import.ts's `mergeTokens`), reporting `import-theme-token` per
 * emitted token and `import-unresolved-theme-var` (warning) per var()
 * reference the harness couldn't resolve. This is an ARTIFACT-level fact
 * (computed once from artifact.themeVars/unresolvedThemeVars, both already
 * resolved by harness/class-index.ts's resolveThemeVars before Stage 2 ever
 * runs), so it must show up identically regardless of which native/sealed
 * branch projectArtifact ends up taking — asserted explicitly below.
 */
import { describe, expect, it } from 'vitest'
import { projectArtifact } from '../src/project/index.js'
import { artifact, classIndex, prop } from './fixtures.js'

const THEME_VARS = { 'color-green-100': 'oklch(96.2% 0.044 156.743)', 'color-green-800': 'oklch(44.8% 0.119 151.328)' }
const UNRESOLVED = ['--tw-leading']

describe('projectArtifact: theme tokens (extraTokens)', () => {
  it('native mode: extraTokens mirrors artifact.themeVars, one import-theme-token report line per token', () => {
    const a = artifact({
      name: 'Badge',
      samples: [{ props: {}, html: '<span class="bg-green-100">x</span>' }],
      classIndex: classIndex({ 'bg-green-100': { base: { 'background-color': 'var(--color-green-100)' } } }),
      themeVars: THEME_VARS,
    })
    const result = projectArtifact(a)
    expect(result.mode).toBe('native')
    expect(result.extraTokens).toEqual(THEME_VARS)
    const tokenLines = result.report.filter((l) => l.code === 'import-theme-token')
    expect(tokenLines).toHaveLength(2)
    expect(tokenLines.every((l) => l.severity === 'info')).toBe(true)
    expect(tokenLines.map((l) => (l.detail as { name: string }).name).sort()).toEqual(['color-green-100', 'color-green-800'])
  })

  it('reports import-unresolved-theme-var (warning) for vars with no theme definition, and leaves them out of extraTokens', () => {
    const a = artifact({
      name: 'Badge',
      samples: [{ props: {}, html: '<span>x</span>' }],
      themeVars: {},
      unresolvedThemeVars: UNRESOLVED,
    })
    const result = projectArtifact(a)
    expect(result.extraTokens).toEqual({})
    const line = result.report.find((l) => l.code === 'import-unresolved-theme-var')
    expect(line).toBeDefined()
    expect(line?.severity).toBe('warning')
    expect(line?.message).toContain('--tw-leading')
    expect(line?.detail).toEqual({ name: '--tw-leading' })
  })

  it('an artifact with no theme vars at all emits no theme-token report lines and an empty extraTokens', () => {
    const a = artifact({ name: 'Icon', samples: [{ props: {}, html: '<svg></svg>' }] })
    const result = projectArtifact(a)
    expect(result.extraTokens).toEqual({})
    expect(result.report.some((l) => l.code === 'import-theme-token' || l.code === 'import-unresolved-theme-var')).toBe(false)
  })

  it('--sealed (forced) still returns extraTokens — a sealed capsule\'s css references the same vars', () => {
    const a = artifact({
      name: 'Badge',
      samples: [{ props: {}, html: '<span class="bg-green-100">x</span>' }],
      classIndex: classIndex({ 'bg-green-100': { base: { 'background-color': 'var(--color-green-100)' } } }),
      themeVars: THEME_VARS,
    })
    const result = projectArtifact(a, { forceSealed: true })
    expect(result.mode).toBe('sealed')
    expect(result.extraTokens).toEqual(THEME_VARS)
  })

  it('the "no samples" early-sealed branch still returns extraTokens', () => {
    const a = artifact({ name: 'Empty', samples: [], themeVars: THEME_VARS })
    const result = projectArtifact(a)
    expect(result.mode).toBe('sealed')
    expect(result.extraTokens).toEqual(THEME_VARS)
  })

  it('the interaction-mismatch sealed branch still returns extraTokens', () => {
    // Same composed-variant shape project-interaction.test.ts uses to force
    // a genuine prop-interaction sealed result — just also carrying themeVars.
    const a = artifact({
      name: 'Btn',
      propSchema: [prop('variant', 'enum'), prop('active', 'boolean', { default: false })],
      samples: [
        { props: { variant: 'primary', active: false }, html: '<button class="bg-green-100">x</button>' },
        { varied: 'variant', props: { variant: 'secondary', active: false }, html: '<button class="bg-red-500">x</button>' },
        { varied: 'active', props: { variant: 'primary', active: true }, html: '<button class="bg-green-100 opacity-50">x</button>' },
        {
          varied: 'variant+active',
          props: { variant: 'secondary', active: true },
          // pairwise probe deliberately NOT reproducible by independently
          // combining the two single-prop transforms above.
          html: '<button class="bg-red-500">unexpected-extra-text</button>',
        },
      ],
      classIndex: classIndex({
        'bg-green-100': { base: { 'background-color': 'var(--color-green-100)' } },
        'bg-red-500': { base: { 'background-color': 'var(--color-red-500)' } },
        'opacity-50': { base: { opacity: '0.5' } },
      }),
      themeVars: THEME_VARS,
    })
    const result = projectArtifact(a)
    expect(result.mode).toBe('sealed')
    expect(result.report.some((l) => l.code === 'import-prop-interaction')).toBe(true)
    expect(result.extraTokens).toEqual(THEME_VARS)
  })

  it('is deterministic: projecting the same artifact twice yields byte-identical extraTokens + theme report lines', () => {
    const a = artifact({
      name: 'Badge',
      samples: [{ props: {}, html: '<span class="bg-green-100">x</span>' }],
      classIndex: classIndex({ 'bg-green-100': { base: { 'background-color': 'var(--color-green-100)' } } }),
      themeVars: THEME_VARS,
      unresolvedThemeVars: UNRESOLVED,
    })
    const r1 = projectArtifact(a)
    const r2 = projectArtifact(a)
    expect(JSON.stringify(r1.extraTokens)).toBe(JSON.stringify(r2.extraTokens))
    expect(JSON.stringify(r1.report.filter((l) => l.code.startsWith('import-theme-token') || l.code.startsWith('import-unresolved-theme-var')))).toBe(
      JSON.stringify(r2.report.filter((l) => l.code.startsWith('import-theme-token') || l.code.startsWith('import-unresolved-theme-var'))),
    )
  })
})
