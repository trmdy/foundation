import { describe, expect, it } from 'vitest'
import { bakeDocument } from '../src/bake/index.js'
import { parseDocument } from '../src/parse/index.js'
import type { FdnDocument, FdnNode } from '../src/types.js'

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

describe('bake: state resolution', () => {
  it('no state selected uses each param default', () => {
    const d = doc({
      params: [{ name: 'title', type: 'string', default: 'Default Title' }],
      body: [node({ id: 'n1', tag: 'div', text: '{{ param.title }}' })],
    })
    const result = bakeDocument(d)
    expect(result.state).toBeNull()
    expect(result.tree[0]?.text).toBe('Default Title')
    expect(result.report.lines).toEqual([])
  })

  it('a named state layers assignments over defaults', () => {
    const d = doc({
      params: [
        { name: 'title', type: 'string', default: 'Default Title' },
        { name: 'mode', type: 'string', default: 'idle' },
      ],
      states: [{ name: 'busy', assignments: { mode: 'loading' } }],
      body: [node({ id: 'n1', tag: 'div', text: '{{ param.title }} / {{ param.mode }}' })],
    })
    const result = bakeDocument(d, { state: 'busy' })
    expect(result.state).toBe('busy')
    expect(result.tree[0]?.text).toBe('Default Title / loading')
  })

  it('param with no default and no state assignment bakes empty with a report line', () => {
    const d = doc({
      params: [{ name: 'title', type: 'string' }],
      body: [node({ id: 'n1', tag: 'div', text: '{{ param.title }}' })],
    })
    const result = bakeDocument(d)
    expect(result.tree[0]?.text).toBe('')
    expect(result.report.lines.some((l) => l.code === 'param-missing-default')).toBe(true)
  })

  it('a state assignment overrides even when a default exists, using the state value verbatim', () => {
    const d = doc({
      params: [{ name: 'count', type: 'number', default: 1 }],
      states: [{ name: 's', assignments: { count: 42 } }],
      body: [node({ id: 'n1', tag: 'div', text: '{{ param.count }}' })],
    })
    const result = bakeDocument(d, { state: 's' })
    expect(result.tree[0]?.text).toBe('42')
  })

  it('an unknown state name reports unknown-state and falls back to defaults', () => {
    const d = doc({
      params: [{ name: 'title', type: 'string', default: 'Default' }],
      body: [node({ id: 'n1', tag: 'div', text: '{{ param.title }}' })],
    })
    const result = bakeDocument(d, { state: 'nope' })
    expect(result.report.lines.some((l) => l.code === 'unknown-state')).toBe(true)
    expect(result.tree[0]?.text).toBe('Default')
  })
})

describe('bake: state assignments are coerced through the param type (friction §2, real bug)', () => {
  // Ingestion-to-bake integration: a hand-authored fdn-state assigns a
  // boolean param the STRING "false" (that's all an HTML attribute can ever
  // be). Before the fix, parseStates stored that raw string verbatim, bake
  // copied it through unchanged, and isTruthy("false") === true — so
  // when="param.proposalopen" rendered and when="!param.proposalopen" never
  // did, silently and with zero validate/normalization report noise.
  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"></head>
<body>
<fdn-doc hidden data-fdn-spec-version="0.0.1-draft">
  <fdn-params>
    <fdn-param name="proposalopen" type="boolean" default="true"></fdn-param>
  </fdn-params>
  <fdn-states>
    <fdn-state name="at-rest" proposalopen="false"></fdn-state>
  </fdn-states>
</fdn-doc>
<main>
<div data-fdn-id="n10" when="param.proposalopen">pending card</div>
<div data-fdn-id="n11" when="!param.proposalopen">empty state</div>
</main>
</body>
</html>
`

  it('parses a boolean state assignment into a real boolean, not the string "false"', () => {
    const { doc: d } = parseDocument(html)
    const state = d.states.find((s) => s.name === 'at-rest')
    expect(state?.assignments.proposalopen).toBe(false)
  })

  it('bakes with when="param.x" dropped and when="!param.x" kept', () => {
    const { doc: d } = parseDocument(html)
    const result = bakeDocument(d, { state: 'at-rest' })
    const ids = result.tree.map((n) => n.id)
    expect(ids).not.toContain('n10')
    expect(ids).toContain('n11')
  })

  it('the default (no state) still renders the "param.x" branch, since the default is true', () => {
    const { doc: d } = parseDocument(html)
    const result = bakeDocument(d)
    const ids = result.tree.map((n) => n.id)
    expect(ids).toContain('n10')
    expect(ids).not.toContain('n11')
  })
})
