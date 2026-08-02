/**
 * Sealed capsule support (SPEC D3/Q3, resolved; API.md Wave 4) — engine-side:
 *   - parse/project canonical text representation round-trips byte-for-byte
 *     (the same fixpoint contract as native content, API.md's "project MUST
 *     be a fixpoint with parse").
 *   - bake emits `<div class="fdn-capsule-<name>">` + naive-scoped css
 *     collected into the document's <style> block.
 *   - validate accepts a sealed component (empty body + sealed present) and
 *     still legally allows fdn-use instances to reference it.
 */
import { describe, expect, it } from 'vitest'
import { parseDocument } from '../src/parse/index.js'
import { projectDocument } from '../src/project/index.js'
import { validateDocument } from '../src/validate/index.js'
import { bakeDocument } from '../src/bake/index.js'
import { scopeCss, capsuleClassName } from '../src/bake/capsule.js'
import type { FdnComponent, FdnDocument, FdnNode } from '../src/types.js'

function node(overrides: Partial<FdnNode> & Pick<FdnNode, 'id' | 'tag'>): FdnNode {
  return { attrs: {}, style: {}, styleStates: {}, children: [], ...overrides }
}

function doc(overrides: Partial<FdnDocument> = {}): FdnDocument {
  return {
    specVersion: '0.0.1-draft',
    tokens: {},
    params: [],
    data: [],
    lookups: [],
    states: [],
    viewports: [],
    matrix: [],
    namedStyles: [],
    components: [],
    body: [],
    ...overrides,
  }
}

// A sealed body deliberately exercises escaping-fidelity edge cases: nested
// entities, angle brackets, quotes, and multi-line content.
const SEALED_HTML =
  '<button class="btn btn-primary" data-note="a &amp; b &lt;3&gt;">\n  Click &amp; Save "quoted"\n</button>'
const SEALED_CSS = '.btn { color: red; padding: 4px 8px; }\n.btn:hover { color: blue; }\n.btn:disabled { color: gray; }'

function sealedButton(overrides: Partial<FdnComponent> = {}): FdnComponent {
  return {
    name: 'SealedButton',
    props: [{ name: 'label', type: 'string', required: true }],
    slots: [],
    body: [],
    sealed: { html: SEALED_HTML, css: SEALED_CSS },
    provenance: { source: 'vendor/button.tsx', contentSha256: 'sha256-deadbeef' },
    ...overrides,
  }
}

describe('sealed component: parse/project fixpoint', () => {
  it('round-trips html/css byte-for-byte through project -> parse', () => {
    const d = doc({ components: [sealedButton()] })
    const text = projectDocument(d)
    const { doc: reparsed } = parseDocument(text)
    const comp = reparsed.components.find((c) => c.name === 'SealedButton')
    expect(comp).toBeDefined()
    expect(comp?.sealed).toStrictEqual({ html: SEALED_HTML, css: SEALED_CSS })
    expect(comp?.provenance).toStrictEqual({ source: 'vendor/button.tsx', contentSha256: 'sha256-deadbeef' })
    expect(comp?.body).toStrictEqual([])
  })

  it('is a full fixpoint: parse(project(doc)) deep-equals doc', () => {
    const d = doc({ components: [sealedButton()] })
    const text = projectDocument(d)
    const { doc: reparsed } = parseDocument(text)
    expect(reparsed).toStrictEqual(d)
  })

  it('project(parse(project(doc))) is byte-identical to project(doc)', () => {
    const d = doc({ components: [sealedButton()] })
    const text1 = projectDocument(d)
    const { doc: doc1 } = parseDocument(text1)
    const text2 = projectDocument(doc1)
    expect(text2).toBe(text1)
  })

  it('canonical text carries the sealed body as <fdn-sealed> with escaped text leaves', () => {
    const d = doc({ components: [sealedButton()] })
    const text = projectDocument(d)
    expect(text).toContain('<fdn-sealed>')
    expect(text).toContain('<fdn-sealed-html>')
    expect(text).toContain('<fdn-sealed-css>')
    // the raw '<' of the sealed html must be entity-escaped in the projection
    // (never emitted as real markup — that would corrupt the outer parse).
    expect(text).toContain('&lt;button')
    expect(text).not.toMatch(/<fdn-sealed-html>\s*<button/)
  })

  it('projected component carries provenance as data-fdn-import-* attrs', () => {
    const d = doc({ components: [sealedButton()] })
    const text = projectDocument(d)
    expect(text).toContain('data-fdn-import-source="vendor/button.tsx"')
    expect(text).toContain('data-fdn-import-sha256="sha256-deadbeef"')
  })

  it('an empty html/css sealed body round-trips too (no dangling whitespace)', () => {
    const d = doc({ components: [sealedButton({ sealed: { html: '', css: '' } })] })
    const text = projectDocument(d)
    const { doc: reparsed } = parseDocument(text)
    expect(reparsed.components[0]?.sealed).toStrictEqual({ html: '', css: '' })
  })

  it('native (non-sealed) components are unaffected — no <fdn-sealed> emitted', () => {
    const native: FdnComponent = {
      name: 'Native',
      props: [],
      slots: [],
      body: [node({ id: 'root', tag: 'div', text: 'hi' })],
    }
    const d = doc({ components: [native] })
    const text = projectDocument(d)
    expect(text).not.toContain('<fdn-sealed')
    const { doc: reparsed } = parseDocument(text)
    expect(reparsed).toStrictEqual(d)
  })
})

describe('sealed component: bake capsule emission', () => {
  it('emits a <div class="fdn-capsule-<name>"> wrapper around the parsed sealed html', () => {
    const d = doc({
      components: [sealedButton()],
      body: [node({ id: 'use1', tag: 'fdn-use', attrs: { component: 'SealedButton', 'data-fdn-prop-label': 'Save' } })],
    })
    const { html } = bakeDocument(d)
    expect(html).toContain('class="fdn-capsule-SealedButton"')
    expect(html).toContain('<button')
    expect(html).toContain('Click &amp; Save')
  })

  it('collects the capsule css into the baked document style block, scoped under the capsule class', () => {
    const d = doc({
      components: [sealedButton()],
      body: [node({ id: 'use1', tag: 'fdn-use', attrs: { component: 'SealedButton' } })],
    })
    const { html } = bakeDocument(d)
    expect(html).toContain('<style>')
    expect(html).toContain('.fdn-capsule-SealedButton .btn {')
    expect(html).toContain('.fdn-capsule-SealedButton .btn:hover {')
    expect(html).toContain('.fdn-capsule-SealedButton .btn:disabled {')
  })

  it('scopeCss is the naive selector-list prefixer used by bake', () => {
    const scoped = scopeCss('.a, .b:hover { color: red; }', capsuleClassName('X'))
    expect(scoped).toBe('.fdn-capsule-X .a, .fdn-capsule-X .b:hover { color: red; }')
  })

  it('does not duplicate capsule css across multiple instances of the same sealed component', () => {
    const d = doc({
      components: [sealedButton()],
      body: [
        node({ id: 'use1', tag: 'fdn-use', attrs: { component: 'SealedButton' } }),
        node({ id: 'use2', tag: 'fdn-use', attrs: { component: 'SealedButton' } }),
      ],
    })
    const { html } = bakeDocument(d)
    expect(html.split('.fdn-capsule-SealedButton .btn {').length - 1).toBe(1)
    expect(html.split('class="fdn-capsule-SealedButton"').length - 1).toBe(2)
  })

  it('merges tokens and capsule css into ONE style block', () => {
    const d = doc({
      tokens: { 'color-accent': '#123456' },
      components: [sealedButton()],
      body: [node({ id: 'use1', tag: 'fdn-use', attrs: { component: 'SealedButton' } })],
    })
    const { html } = bakeDocument(d)
    expect(html.split('<style>').length - 1).toBe(1)
    expect(html).toContain(':root {')
    expect(html).toContain('.fdn-capsule-SealedButton .btn {')
  })

  it('honors when= on the fdn-use instance (evaluated before sealed instantiation)', () => {
    const d = doc({
      params: [{ name: 'show', type: 'boolean', default: false }],
      states: [{ name: 'visible', assignments: { show: true } }],
      components: [sealedButton()],
      body: [node({ id: 'use1', tag: 'fdn-use', attrs: { component: 'SealedButton' }, when: 'param.show' })],
    })
    const { html: hiddenByDefault } = bakeDocument(d)
    expect(hiddenByDefault).not.toContain('fdn-capsule-SealedButton')
    const { html: shownInState } = bakeDocument(d, { state: 'visible' })
    expect(shownInState).toContain('fdn-capsule-SealedButton')
  })
})

describe('sealed component: validate accepts it', () => {
  it('a sealed component (empty body) validates clean', () => {
    const d = doc({ components: [sealedButton()] })
    const result = validateDocument(d)
    expect(result.valid).toBe(true)
    expect(result.issues).toStrictEqual([])
  })

  it('an fdn-use referencing a sealed component is legal', () => {
    const d = doc({
      components: [sealedButton()],
      body: [node({ id: 'use1', tag: 'fdn-use', attrs: { component: 'SealedButton', 'data-fdn-prop-label': 'Save' } })],
    })
    const result = validateDocument(d)
    expect(result.valid).toBe(true)
    expect(result.issues.filter((i) => i.severity === 'error')).toStrictEqual([])
  })

  it('an fdn-use with an undeclared prop still reports normally against a sealed component', () => {
    const d = doc({
      components: [sealedButton()],
      body: [
        node({
          id: 'use1',
          tag: 'fdn-use',
          attrs: { component: 'SealedButton', 'data-fdn-prop-label': '{{ prop.nope }}' },
        }),
      ],
    })
    const result = validateDocument(d)
    // prop.nope is referenced inside an interpolation at the TOP level (not
    // inside a component body), so it is checked against the top scope
    // (props: null) — legal check either way; the meaningful assertion here
    // is that validate walks fdn-use attrs for a sealed component exactly
    // like it would for a native one (no special-case skip).
    expect(result.issues.some((i) => i.code === 'undeclared-ref-root')).toBe(true)
  })

  it('referencing an undeclared component name is still an error when sealed components exist', () => {
    const d = doc({
      components: [sealedButton()],
      body: [node({ id: 'use1', tag: 'fdn-use', attrs: { component: 'DoesNotExist' } })],
    })
    const result = validateDocument(d)
    expect(result.valid).toBe(false)
    expect(result.issues.some((i) => i.code === 'undeclared-ref')).toBe(true)
  })
})

describe('sealed component: determinism', () => {
  it('repeated projection of the same document is byte-identical', () => {
    const d = doc({ components: [sealedButton()] })
    const t1 = projectDocument(d)
    const t2 = projectDocument(d)
    expect(t2).toBe(t1)
  })

  it('repeated bake of the same document is byte-identical', () => {
    const d = doc({
      components: [sealedButton()],
      body: [node({ id: 'use1', tag: 'fdn-use', attrs: { component: 'SealedButton' } })],
    })
    const h1 = bakeDocument(d).html
    const h2 = bakeDocument(d).html
    expect(h2).toBe(h1)
  })
})
