import { describe, expect, it } from 'vitest'
import { projectArtifact } from '../src/project/index.js'
import { artifact, prop } from './fixtures.js'

describe('projectArtifact: sentinel substitution', () => {
  it('substitutes a sentinel in text content and reports import-sentinel-substituted', () => {
    const a = artifact({
      name: 'Label',
      propSchema: [prop('text', 'string', { required: true })],
      samples: [{ props: { text: '⟦fdn:prop:text⟧' }, html: '<span>⟦fdn:prop:text⟧</span>' }],
    })
    const result = projectArtifact(a)
    expect(result.mode).toBe('native')
    expect(result.component.body[0]?.text).toBe('{{ prop.text }}')
    expect(result.report.some((r) => r.code === 'import-sentinel-substituted')).toBe(true)
  })

  it('substitutes a sentinel inside an attribute value', () => {
    const a = artifact({
      name: 'Icon',
      propSchema: [prop('label', 'string')],
      samples: [
        {
          props: { label: '⟦fdn:prop:label⟧' },
          html: '<svg aria-label="⟦fdn:prop:label⟧"><circle cx="1" cy="1" r="1"></circle></svg>',
        },
      ],
    })
    const result = projectArtifact(a)
    expect(result.mode).toBe('native')
    expect(result.component.body[0]?.attrs['aria-label']).toBe('{{ prop.label }}')
  })

  it('dedupes the report to one line per distinct prop even with multiple occurrences', () => {
    const a = artifact({
      name: 'Dup',
      propSchema: [prop('text', 'string')],
      samples: [
        {
          props: { text: '⟦fdn:prop:text⟧' },
          html: '<div title="⟦fdn:prop:text⟧">⟦fdn:prop:text⟧</div>',
        },
      ],
    })
    const result = projectArtifact(a)
    const lines = result.report.filter((r) => r.code === 'import-sentinel-substituted')
    expect(lines).toHaveLength(1)
  })

  it('the degenerate icon case (no classes, one string prop) projects trivially', () => {
    const a = artifact({
      name: 'Icon',
      propSchema: [prop('label', 'string')],
      samples: [
        {
          props: { label: '⟦fdn:prop:label⟧' },
          html:
            '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" role="img" aria-label="⟦fdn:prop:label⟧"><circle cx="12" cy="12" r="10"></circle></svg>',
        },
      ],
    })
    const result = projectArtifact(a)
    expect(result.mode).toBe('native')
    expect(result.component.body[0]?.tag).toBe('svg')
    expect(result.component.body[0]?.children[0]?.tag).toBe('circle')
    expect(result.component.body[0]?.attrs['aria-label']).toBe('{{ prop.label }}')
    // no class resolution work at all for a pure-svg, class-free component
    expect(result.report.some((r) => r.code === 'import-attr-ternary')).toBe(false)
    expect(result.report.some((r) => r.code === 'import-unsupported-variant')).toBe(false)
  })
})
