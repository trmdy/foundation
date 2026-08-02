import { describe, expect, it } from 'vitest'
import { parseDocument } from '../src/parse/index.js'
import { projectDocument } from '../src/project/index.js'
import { bakeDocument } from '../src/bake/index.js'
import type { FdnAnnotation, FdnDocument, FdnNode } from '../src/types.js'

function node(partial: Partial<FdnNode> & { id: string; tag: string }): FdnNode {
  return { attrs: {}, style: {}, styleStates: {}, children: [], ...partial }
}

function makeDoc(annotations: FdnAnnotation[]): FdnDocument {
  return {
    specVersion: '0.0.1-draft',
    title: 'Annotated Board',
    tokens: {},
    params: [],
    data: [],
    lookups: [],
    states: [{ name: 'default', assignments: {} }],
    viewports: [],
    matrix: [],
    namedStyles: [],
    components: [],
    annotations,
    body: [
      node({ id: 'n1', tag: 'div', text: 'Hello' }),
      node({ id: 'n2', tag: 'span', text: 'World' }),
    ],
  }
}

const ANNOTATIONS: FdnAnnotation[] = [
  { id: 'a1', nodeId: 'n1', state: 'default', text: 'padding looks off here', status: 'open' },
  { id: 'a2', x: 120, y: 340, text: 'this region needs a & <b>tag</b> escape check', status: 'resolved' },
  { id: 'a3', nodeId: 'n2', text: 'not worth fixing', status: 'wontfix' },
]

describe('annotations: parse/project round-trip (SPEC D2/D4/13a — first-class chain citizens, hidden metadata)', () => {
  it('project -> parse round-trips annotations exactly (id, anchor, state, text, status)', () => {
    const doc0 = makeDoc(ANNOTATIONS)
    const text = projectDocument(doc0)
    const { doc: doc1 } = parseDocument(text)
    expect(doc1.annotations).toEqual(ANNOTATIONS)
  })

  it('is a fixpoint: parse(project(doc)) deep-equals doc, and project is idempotent past round 1', () => {
    const doc0 = makeDoc(ANNOTATIONS)
    const text1 = projectDocument(doc0)
    const { doc: doc1 } = parseDocument(text1)
    expect(doc1).toStrictEqual(doc0)
    const text2 = projectDocument(doc1)
    expect(text2).toBe(text1)
  })

  it('emits a single <fdn-annotations> block nested inside the (already hidden) <fdn-doc> header', () => {
    const text = projectDocument(makeDoc(ANNOTATIONS))
    const docOpen = text.indexOf('<fdn-doc ')
    const docClose = text.indexOf('</fdn-doc>')
    const annotationsBlock = text.indexOf('<fdn-annotations>')
    expect(docOpen).toBeGreaterThanOrEqual(0)
    expect(annotationsBlock).toBeGreaterThan(docOpen)
    expect(annotationsBlock).toBeLessThan(docClose)
    // <fdn-doc> itself carries `hidden` — nested metadata inherits browser-inertness
    // from it (same convention as fdn-params/fdn-states/fdn-lookups, none of which
    // carry their own `hidden` either).
    expect(text.slice(docOpen, docOpen + 40)).toContain('hidden')
  })

  it('round-trips special characters in annotation text (&, <, >) without corrupting the HTML', () => {
    const withSpecials: FdnAnnotation[] = [{ id: 'a1', text: 'A & B <weird> "quoted"', status: 'open' }]
    const doc0 = makeDoc(withSpecials)
    const text = projectDocument(doc0)
    expect(text).toContain('A &amp; B &lt;weird&gt; "quoted"')
    const { doc: doc1 } = parseDocument(text)
    expect(doc1.annotations).toEqual(withSpecials)
  })

  it('no annotations produces no <fdn-annotations> block at all', () => {
    const text = projectDocument(makeDoc([]))
    expect(text).not.toContain('fdn-annotations')
    expect(text).not.toContain('fdn-annotation ')
  })

  it('bake NEVER emits annotations into the baked design output', () => {
    const doc = makeDoc(ANNOTATIONS)
    const baked = bakeDocument(doc)
    for (const a of ANNOTATIONS) {
      expect(baked.html).not.toContain(a.text)
    }
    expect(baked.html).not.toContain('fdn-annotation')
  })
})
