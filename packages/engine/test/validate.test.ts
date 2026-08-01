import { describe, expect, it } from 'vitest'
import { validateDocument } from '../src/validate/index.js'
import type { FdnDocument, FdnNode } from '../src/types.js'

function node(partial: Partial<FdnNode> & { id: string; tag: string }): FdnNode {
  return { attrs: {}, style: {}, styleStates: {}, children: [], ...partial }
}

function doc(partial: Partial<FdnDocument> = {}): FdnDocument {
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
    ...partial,
  }
}

function issueCodes(result: ReturnType<typeof validateDocument>): string[] {
  return result.issues.map((i) => i.code)
}

describe('validateDocument: schema conformance', () => {
  it('accepts a plain, well-formed document', () => {
    const d = doc({ body: [node({ id: 'n1', tag: 'div', children: [node({ id: 'n2', tag: 'span', text: 'hi' })] })] })
    const result = validateDocument(d)
    expect(result.valid).toBe(true)
    expect(result.issues).toEqual([])
  })

  it('flags an unknown, non-HTML5, non-fdn element', () => {
    const d = doc({ body: [node({ id: 'n1', tag: 'x-widget' })] })
    const result = validateDocument(d)
    expect(result.valid).toBe(false)
    expect(issueCodes(result)).toContain('unknown-element')
  })

  it('flags an event-handler attribute even when constructed directly (bypassing parse)', () => {
    const d = doc({ body: [node({ id: 'n1', tag: 'div', attrs: { onclick: 'x()' } })] })
    const result = validateDocument(d)
    expect(issueCodes(result)).toContain('excluded-attribute')
  })

  it('flags a text+children conflict', () => {
    const d = doc({
      body: [node({ id: 'n1', tag: 'div', text: 'hello', children: [node({ id: 'n2', tag: 'span' })] })],
    })
    const result = validateDocument(d)
    expect(issueCodes(result)).toContain('text-children-conflict')
  })

  it('requires fdn-use to carry a component attribute', () => {
    const d = doc({ body: [node({ id: 'n1', tag: 'fdn-use' })] })
    const result = validateDocument(d)
    expect(issueCodes(result)).toContain('missing-required-attribute')
  })
})

describe('validateDocument: style-property rules', () => {
  it('rejects float with the corrective D1 message', () => {
    const d = doc({ body: [node({ id: 'n1', tag: 'div', style: { float: 'left' } })] })
    const result = validateDocument(d)
    const issue = result.issues.find((i) => i.code === 'excluded-style-property')
    expect(issue?.message).toMatch(/float is not in the subset; use flex on the parent/)
  })

  it('rejects clear with a corrective message', () => {
    const d = doc({ body: [node({ id: 'n1', tag: 'div', style: { clear: 'both' } })] })
    const result = validateDocument(d)
    expect(result.issues.find((i) => i.code === 'excluded-style-property')?.message).toMatch(/clear is not in the subset/)
  })

  it('rejects !important', () => {
    const d = doc({ body: [node({ id: 'n1', tag: 'div', style: { color: 'red !important' } })] })
    const result = validateDocument(d)
    expect(issueCodes(result)).toContain('important-not-allowed')
  })

  it('rejects an embedded rule/selector-shaped value', () => {
    const d = doc({ body: [node({ id: 'n1', tag: 'div', style: { background: '.foo { color: red }' } })] })
    const result = validateDocument(d)
    expect(issueCodes(result)).toContain('embedded-rule-not-allowed')
  })

  it('does not flag {{ }} interpolation braces as an embedded rule', () => {
    const d = doc({ body: [node({ id: 'n1', tag: 'div', style: { opacity: '{{ prop.dim ? .5 : 1 }}' } })] })
    const result = validateDocument(d)
    expect(issueCodes(result)).not.toContain('embedded-rule-not-allowed')
  })

  it('rejects position:absolute outside fdn-overlay', () => {
    const d = doc({ body: [node({ id: 'n1', tag: 'div', style: { position: 'absolute', inset: '0' } })] })
    const result = validateDocument(d)
    expect(issueCodes(result)).toContain('position-outside-overlay')
  })

  it('accepts position:absolute inside an fdn-overlay subtree', () => {
    const d = doc({
      body: [
        node({
          id: 'n1',
          tag: 'fdn-overlay',
          attrs: { 'data-fdn-role': 'dialog' },
          children: [node({ id: 'n2', tag: 'div', style: { position: 'absolute', inset: '0' } })],
        }),
      ],
    })
    const result = validateDocument(d)
    expect(issueCodes(result)).not.toContain('position-outside-overlay')
  })

  it('accepts position:absolute on the fdn-overlay element itself', () => {
    const d = doc({ body: [node({ id: 'n1', tag: 'fdn-overlay', style: { position: 'absolute', inset: '0' } })] })
    const result = validateDocument(d)
    expect(issueCodes(result)).not.toContain('position-outside-overlay')
  })

  it('always rejects position:absolute in a named style (usage site is unknown statically)', () => {
    const d = doc({ namedStyles: [{ name: 'panel', style: { position: 'absolute' }, styleStates: {} }] })
    const result = validateDocument(d)
    expect(issueCodes(result)).toContain('position-outside-overlay')
  })
})

describe('validateDocument: undeclared references', () => {
  it('flags an undeclared styleRef', () => {
    const d = doc({ body: [node({ id: 'n1', tag: 'div', styleRef: 'ghost' })] })
    const result = validateDocument(d)
    expect(issueCodes(result)).toContain('undeclared-ref')
  })

  it('accepts a declared styleRef', () => {
    const d = doc({
      namedStyles: [{ name: 'row-label', style: { color: 'red' }, styleStates: {} }],
      body: [node({ id: 'n1', tag: 'div', styleRef: 'row-label' })],
    })
    const result = validateDocument(d)
    expect(result.valid).toBe(true)
  })

  it('flags an undeclared fdn-use component (friction §3, real bug)', () => {
    const d = doc({ body: [node({ id: 'n1', tag: 'fdn-use', attrs: { component: 'Ghost' } })] })
    const result = validateDocument(d)
    expect(result.valid).toBe(false)
    const line = result.issues.find((i) => i.code === 'undeclared-ref' && i.detail && (i.detail as { component?: string }).component === 'Ghost')
    expect(line).toBeDefined()
    expect(line?.severity).toBe('error')
    expect(line?.message).toContain('component="Ghost"')
  })

  it('accepts an fdn-use referencing a declared component (positive case for friction §3)', () => {
    const d = doc({
      components: [{ name: 'QueuedRow', props: [], slots: [], body: [] }],
      body: [node({ id: 'n1', tag: 'fdn-use', attrs: { component: 'QueuedRow' } })],
    })
    const result = validateDocument(d)
    expect(result.valid).toBe(true)
  })

  // Loose-end investigation (docs/dogfood/tracks-pane-run.md friction §3):
  // hypothesis was "fdn-use INSIDE another component's template body is
  // unchecked" — i.e. walkComponent()'s traversal of component.body might
  // not reach the same undeclared-fdn-use check walkNode() applies to
  // doc.body. It does not hold: walkComponent() calls the SAME walkNode()
  // used for doc.body, which recurses into every child (including fdn-use
  // nodes nested inside a component's own template, and nodes reached via
  // an each-bound fdn-use inside that template) — there is only one code
  // path for this check, not a main-tree-only one. These two cases
  // (undeclared ref as a direct child of a component body, and nested two
  // levels deep under a wrapping div + each binding, closest to the real
  // QueuedRow repro) both correctly fail validation today.
  //
  // The real explanation for the bee's "0 issues" report is ordering, not a
  // coverage gap: this whole undeclared-fdn-use-component check (the one
  // covering BOTH doc.body and component bodies, since it's one function)
  // was added in the same "Dogfood fix round" commit that followed the
  // dogfood run friction §3 came from — it did not exist yet when the bee
  // ran validate against the QueuedRow deletion. There is no template-body
  // gap to close; the check the bee asked for was shipped, and it already
  // covers component template bodies because it was never main-tree-scoped
  // to begin with.
  it('flags an undeclared fdn-use component nested directly inside another component\'s body (loose-end investigation: already covered)', () => {
    const d = doc({
      components: [
        {
          name: 'DetailPane',
          props: [],
          slots: [],
          body: [node({ id: 'ghost-use', tag: 'fdn-use', attrs: { component: 'Ghost' } })],
        },
      ],
    })
    const result = validateDocument(d)
    expect(result.valid).toBe(false)
    const line = result.issues.find((i) => i.code === 'undeclared-ref' && i.detail && (i.detail as { component?: string }).component === 'Ghost')
    expect(line).toBeDefined()
    expect(line?.nodeId).toBe('ghost-use')
  })

  it('flags an undeclared fdn-use component nested (wrapping div + each binding) inside a component body — closest shape to the real QueuedRow repro (loose-end investigation: already covered)', () => {
    const d = doc({
      data: [{ name: 'queued', items: [{ id: 'x', label: 'X' }] }],
      components: [
        {
          name: 'DetailPane',
          props: [],
          slots: [],
          body: [
            node({
              id: 'wrap',
              tag: 'div',
              children: [node({ id: 'row', tag: 'fdn-use', each: 'q in data.queued', attrs: { component: 'QueuedRow' } })],
            }),
          ],
        },
      ],
    })
    const result = validateDocument(d)
    expect(result.valid).toBe(false)
    const line = result.issues.find((i) => i.code === 'undeclared-ref' && i.detail && (i.detail as { component?: string }).component === 'QueuedRow')
    expect(line).toBeDefined()
    expect(line?.nodeId).toBe('row')
  })

  it('flags param.X interpolation against an undeclared param', () => {
    const d = doc({ body: [node({ id: 'n1', tag: 'div', text: '{{ param.missing }}' })] })
    const result = validateDocument(d)
    expect(issueCodes(result)).toContain('undeclared-ref')
  })

  it('accepts param.X against a declared param', () => {
    const d = doc({
      params: [{ name: 'entrycontext', type: 'string' }],
      body: [node({ id: 'n1', tag: 'div', text: '{{ param.entrycontext }}' })],
    })
    const result = validateDocument(d)
    expect(result.valid).toBe(true)
  })

  it('rejects prop.* used outside a component body', () => {
    const d = doc({ body: [node({ id: 'n1', tag: 'div', text: '{{ prop.title }}' })] })
    const result = validateDocument(d)
    expect(issueCodes(result)).toContain('undeclared-ref-root')
  })

  it('accepts a declared prop inside a component body, rejects an undeclared one', () => {
    const good: FdnDocument = doc({
      components: [
        {
          name: 'KbdCap',
          props: [{ name: 'keys', type: 'string' }],
          slots: [],
          body: [node({ id: 'n1', tag: 'span', text: '{{ prop.keys }}' })],
        },
      ],
    })
    expect(validateDocument(good).valid).toBe(true)

    const bad: FdnDocument = doc({
      components: [
        {
          name: 'KbdCap',
          props: [{ name: 'keys', type: 'string' }],
          slots: [],
          body: [node({ id: 'n1', tag: 'span', text: '{{ prop.ghost }}' })],
        },
      ],
    })
    expect(issueCodes(validateDocument(bad))).toContain('undeclared-ref')
  })

  it('accepts an each-bound alias as a ref root within its subtree', () => {
    const d = doc({
      data: [{ name: 'guideTopics', items: [{ id: 'a', label: 'A' }] }],
      body: [
        node({
          id: 'n1',
          tag: 'fdn-use',
          each: 'topic in data.guideTopics',
          attrs: { component: 'NavRow', 'data-fdn-prop-label': '{{ topic.label }}' },
        }),
      ],
      components: [{ name: 'NavRow', props: [{ name: 'label', type: 'string' }], slots: [], body: [] }],
    })
    const result = validateDocument(d)
    expect(result.valid).toBe(true)
  })

  it('flags an each source referencing an undeclared data set', () => {
    const d = doc({
      body: [node({ id: 'n1', tag: 'fdn-use', each: 'topic in data.ghostSet', attrs: { component: 'X' } })],
      components: [{ name: 'X', props: [], slots: [], body: [] }],
    })
    const result = validateDocument(d)
    expect(issueCodes(result)).toContain('undeclared-ref')
  })

  it('flags a method call in an each source (grammar budget: no .split(), GRAMMAR-FINDINGS b.4)', () => {
    const d = doc({
      components: [
        {
          name: 'ShortcutRow',
          props: [{ name: 'keyGroups', type: 'string' }],
          slots: [],
          body: [node({ id: 'n1', tag: 'span', each: "group in prop.keyGroups.split(' · ')" })],
        },
      ],
    })
    const result = validateDocument(d)
    expect(issueCodes(result)).toContain('expression-not-in-subset')
  })

  it('flags a method call inside a {{ }} interpolation', () => {
    const d = doc({ body: [node({ id: 'n1', tag: 'div', text: "{{ param.x.toUpperCase() }}" })] })
    const result = validateDocument(d)
    expect(issueCodes(result)).toContain('expression-not-in-subset')
  })

  it('flags an undeclared lookup reference', () => {
    const d = doc({
      params: [{ name: 'state', type: 'enum', values: ['failed'] }],
      body: [node({ id: 'n1', tag: 'div', text: '{{ statusColor[param.state] }}' })],
    })
    const result = validateDocument(d)
    expect(issueCodes(result)).toContain('undeclared-ref')
  })

  it('accepts a declared lookup reference', () => {
    const d = doc({
      params: [{ name: 'state', type: 'enum', values: ['failed'] }],
      lookups: [{ name: 'statusColor', entries: { failed: 'red' } }],
      body: [node({ id: 'n1', tag: 'div', text: '{{ statusColor[param.state] }}' })],
    })
    const result = validateDocument(d)
    expect(result.valid).toBe(true)
  })

  it('flags a state assignment to an undeclared param', () => {
    const d = doc({ states: [{ name: 's1', assignments: { ghostParam: 'x' } }] })
    const result = validateDocument(d)
    expect(issueCodes(result)).toContain('undeclared-ref')
  })

  it('accepts a state assignment to a declared param', () => {
    // NOTE: assignments carry the param-typed value here (as parseStates now
    // produces post friction-§2 fix — coerce() through the declared type,
    // exactly like defaults), not the raw attribute string.
    const d = doc({
      params: [{ name: 'dialogopen', type: 'boolean' }],
      states: [{ name: 's1', assignments: { dialogopen: true } }],
    })
    const result = validateDocument(d)
    expect(result.valid).toBe(true)
  })

  it('flags a state assignment whose value did not coerce to the param type (friction §2)', () => {
    // A raw string surviving in an assignment slot for a boolean/number/enum
    // param means coerce() couldn't recognize it (e.g. neither "true" nor
    // "false" for a boolean) — bake would then treat it via isTruthy(), which
    // is exactly the silent-wrong-render bug the bee hit.
    const d = doc({
      params: [{ name: 'dialogopen', type: 'boolean' }],
      states: [{ name: 's1', assignments: { dialogopen: 'yes' } }],
    })
    const result = validateDocument(d)
    expect(result.valid).toBe(false)
    expect(issueCodes(result)).toContain('state-assignment-type-mismatch')
  })

  it('flags a state assignment to an enum param with a value outside the declared values', () => {
    const d = doc({
      params: [{ name: 'mode', type: 'enum', values: ['a', 'b'] }],
      states: [{ name: 's1', assignments: { mode: 'ghost' } }],
    })
    const result = validateDocument(d)
    expect(issueCodes(result)).toContain('state-assignment-type-mismatch')
  })

  it('flags a matrix cell referencing an undeclared state or viewport', () => {
    const d = doc({ matrix: [{ state: 'ghost', viewport: 'ghost' }] })
    const result = validateDocument(d)
    const codes = issueCodes(result)
    expect(codes.filter((c) => c === 'undeclared-ref')).toHaveLength(2)
  })

  it('accepts a matrix cell referencing declared state and viewport', () => {
    const d = doc({
      states: [{ name: 'wide-open', assignments: {} }],
      viewports: [{ name: 'wide', width: 1480, height: 900 }],
      matrix: [{ state: 'wide-open', viewport: 'wide' }],
    })
    const result = validateDocument(d)
    expect(result.valid).toBe(true)
  })
})

describe('validateDocument: prop-name-not-lowercase', () => {
  it('flags a camelCase component prop name, naming the binding hazard', () => {
    const d = doc({
      components: [{ name: 'Row', props: [{ name: 'activeTopicId', type: 'string' }], slots: [], body: [] }],
    })
    const result = validateDocument(d)
    expect(result.valid).toBe(false)
    const line = result.issues.find((i) => i.code === 'prop-name-not-lowercase')
    expect(line).toBeDefined()
    expect(line?.severity).toBe('error')
    expect(line?.message).toContain('HTML lowercases attribute names')
    expect(line?.message).toContain('activeTopicId')
    expect(line?.detail).toEqual({ kind: 'prop', name: 'activeTopicId', component: 'Row' })
  })

  it('flags a camelCase top-level param name', () => {
    const d = doc({ params: [{ name: 'selectedItemId', type: 'string' }] })
    const result = validateDocument(d)
    const line = result.issues.find((i) => i.code === 'prop-name-not-lowercase')
    expect(line).toBeDefined()
    expect(line?.message).toContain('selectedItemId')
    expect(line?.detail).toEqual({ kind: 'param', name: 'selectedItemId', component: undefined })
  })

  it('accepts all-lowercase prop and param names', () => {
    const d = doc({
      params: [{ name: 'selecteditemid', type: 'string' }],
      components: [{ name: 'Row', props: [{ name: 'active_topic_id', type: 'string' }], slots: [], body: [] }],
    })
    const result = validateDocument(d)
    expect(result.issues.some((i) => i.code === 'prop-name-not-lowercase')).toBe(false)
  })
})
