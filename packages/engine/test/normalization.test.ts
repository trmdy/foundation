import { describe, expect, it } from 'vitest'
import { parseDocument } from '../src/parse/index.js'

function wrap(bodyHtml: string): string {
  return `<!DOCTYPE html><html><head><style>:root{--x:1px}</style></head><body><main>${bodyHtml}</main></body></html>`
}

function reportCodes(lines: { code: string }[]): string[] {
  return lines.map((l) => l.code)
}

describe('normalization v0: shorthand expansion', () => {
  it('expands padding (4-value TRBL, no wraparound)', () => {
    const { doc } = parseDocument(wrap('<div style="padding:1px 2px 3px 4px"></div>'))
    expect(doc.body[0]?.style).toEqual({
      'padding-top': '1px',
      'padding-right': '2px',
      'padding-bottom': '3px',
      'padding-left': '4px',
    })
  })

  it('expands padding (3-value: top / left-right / bottom)', () => {
    const { doc } = parseDocument(wrap('<div style="padding:7px 9px 8px"></div>'))
    expect(doc.body[0]?.style).toEqual({
      'padding-top': '7px',
      'padding-right': '9px',
      'padding-bottom': '8px',
      'padding-left': '9px',
    })
  })

  it('expands padding (2-value: top-bottom / left-right)', () => {
    const { doc } = parseDocument(wrap('<div style="padding:5px 10px"></div>'))
    expect(doc.body[0]?.style).toEqual({
      'padding-top': '5px',
      'padding-bottom': '5px',
      'padding-right': '10px',
      'padding-left': '10px',
    })
  })

  it('expands padding (1-value: all sides)', () => {
    const { doc } = parseDocument(wrap('<div style="padding:6px"></div>'))
    expect(doc.body[0]?.style).toEqual({
      'padding-top': '6px',
      'padding-right': '6px',
      'padding-bottom': '6px',
      'padding-left': '6px',
    })
  })

  it('expands margin the same way as padding', () => {
    const { doc } = parseDocument(wrap('<div style="margin:1px 2px"></div>'))
    expect(doc.body[0]?.style).toEqual({
      'margin-top': '1px',
      'margin-bottom': '1px',
      'margin-right': '2px',
      'margin-left': '2px',
    })
  })

  it('expands inset to physical top/right/bottom/left longhands', () => {
    const { doc } = parseDocument(wrap('<div style="inset:0"></div>'))
    expect(doc.body[0]?.style).toEqual({ top: '0', right: '0', bottom: '0', left: '0' })
  })

  it('expands border-radius with diagonal wraparound (2-value: TL/BR, TR/BL)', () => {
    const { doc } = parseDocument(wrap('<div style="border-radius:4px 8px"></div>'))
    expect(doc.body[0]?.style).toEqual({
      'border-top-left-radius': '4px',
      'border-bottom-right-radius': '4px',
      'border-top-right-radius': '8px',
      'border-bottom-left-radius': '8px',
    })
  })

  it('leaves elliptical (slash-form) border-radius unexpanded (out of v0 scope)', () => {
    const { doc } = parseDocument(wrap('<div style="border-radius:4px / 8px"></div>'))
    expect(doc.body[0]?.style).toEqual({ 'border-radius': '4px / 8px' })
  })

  it('expands gap (2-value: row then column)', () => {
    const { doc } = parseDocument(wrap('<div style="gap:3px 6px"></div>'))
    expect(doc.body[0]?.style).toEqual({ 'row-gap': '3px', 'column-gap': '6px' })
  })

  it('expands gap (1-value: both)', () => {
    const { doc } = parseDocument(wrap('<div style="gap:9px"></div>'))
    expect(doc.body[0]?.style).toEqual({ 'row-gap': '9px', 'column-gap': '9px' })
  })

  it('expands font shorthand to longhands, defaulting style/variant to normal', () => {
    const { doc } = parseDocument(wrap('<div style="font:600 13px var(--font-sans)"></div>'))
    expect(doc.body[0]?.style).toEqual({
      'font-style': 'normal',
      'font-variant': 'normal',
      'font-weight': '600',
      'font-size': '13px',
      'font-family': 'var(--font-sans)',
    })
  })

  it('expands font shorthand with a line-height component', () => {
    const { doc } = parseDocument(wrap('<div style="font:400 12.5px/1.6 var(--font-sans)"></div>'))
    expect(doc.body[0]?.style).toEqual({
      'font-style': 'normal',
      'font-variant': 'normal',
      'font-weight': '400',
      'font-size': '12.5px',
      'line-height': '1.6',
      'font-family': 'var(--font-sans)',
    })
  })

  it('keeps an interpolation-bearing font weight atomic through expansion', () => {
    const { doc } = parseDocument(
      wrap(`<div style="font:{{ prop.active ? '600' : '500' }} 13px var(--font-sans)"></div>`),
    )
    expect(doc.body[0]?.style?.['font-weight']).toBe("{{ prop.active ? '600' : '500' }}")
    expect(doc.body[0]?.style?.['font-family']).toBe('var(--font-sans)')
  })

  it('emits a shorthand-expanded report line naming the property and its expansion', () => {
    const { report } = parseDocument(wrap('<div style="padding:1px"></div>'))
    const line = report.lines.find((l) => l.code === 'shorthand-expanded')
    expect(line).toBeDefined()
    expect(line?.detail).toMatchObject({ property: 'padding' })
  })

  it('never snaps an arbitrary value (D1: values are not policed)', () => {
    const { doc } = parseDocument(wrap('<div style="width:316.5px;z-index:9999"></div>'))
    expect(doc.body[0]?.style).toEqual({ width: '316.5px', 'z-index': '9999' })
  })
})

describe('normalization v0: drops with report lines', () => {
  it('drops <script> and reports excluded-element-dropped', () => {
    const { doc, report } = parseDocument(wrap('<div><script>alert(1)</script><span>ok</span></div>'))
    expect(doc.body[0]?.children.map((c) => c.tag)).toEqual(['span'])
    expect(reportCodes(report.lines)).toContain('excluded-element-dropped')
  })

  it('drops on* event-handler attributes and reports excluded-attribute-dropped', () => {
    const { doc, report } = parseDocument(wrap('<div onclick="doStuff()" id="x"></div>'))
    expect(doc.body[0]?.attrs).toEqual({ id: 'x' })
    expect(reportCodes(report.lines)).toContain('excluded-attribute-dropped')
  })

  it('drops autoplay/loop media-behavior attributes', () => {
    const { doc, report } = parseDocument(wrap('<video autoplay loop controls></video>'))
    expect(doc.body[0]?.attrs.controls).toBeDefined()
    expect(doc.body[0]?.attrs.autoplay).toBeUndefined()
    expect(doc.body[0]?.attrs.loop).toBeUndefined()
    expect(reportCodes(report.lines)).toContain('excluded-attribute-dropped')
  })

  it('drops float/clear from inline style with the corrective normalization message', () => {
    const { doc, report } = parseDocument(wrap('<div style="float:left;clear:both;color:red"></div>'))
    expect(doc.body[0]?.style).toEqual({ color: 'red' })
    const line = report.lines.find((l) => l.code === 'excluded-style-property-dropped')
    expect(line?.message).toMatch(/float is not in the subset; use flex on the parent/)
  })

  it('drops unknown, non-HTML5, non-fdn elements', () => {
    const { doc, report } = parseDocument(wrap('<x-dc><span>content</span></x-dc>'))
    expect(doc.body).toHaveLength(0)
    expect(reportCodes(report.lines)).toContain('unknown-element-dropped')
  })

  it('drops non-:root rules from the <style> block', () => {
    const html =
      '<!DOCTYPE html><html><head><style>:root{--a:1px} * { box-sizing: border-box } body{margin:0}</style></head><body><main></main></body></html>'
    const { doc, report } = parseDocument(html)
    expect(doc.tokens).toEqual({ a: '1px' })
    expect(reportCodes(report.lines).filter((c) => c === 'non-root-style-rule-dropped')).toHaveLength(2)
  })

  it('stores :root tokens without the leading -- (types.ts convention)', () => {
    const { doc } = parseDocument(wrap('<div></div>'))
    expect(Object.keys(doc.tokens)).toEqual(['x'])
  })
})

describe('normalization v0: root-wrapper styles dropped (friction §1)', () => {
  it('reports root-wrapper-styles-dropped when <main> carries style', () => {
    const html =
      '<!DOCTYPE html><html><head></head><body><main style="padding:32px;row-gap:44px"><div>x</div></main></body></html>'
    const { doc, report } = parseDocument(html)
    // the children still come through untouched — only the wrapper's own
    // style is lost, and that loss is now named rather than silent.
    expect(doc.body.map((n) => n.tag)).toEqual(['div'])
    const line = report.lines.find((l) => l.code === 'root-wrapper-styles-dropped' && l.detail && (l.detail as { tag?: string }).tag === 'main')
    expect(line).toBeDefined()
    expect(line?.severity).toBe('warning')
    expect(line?.message).toContain('padding:32px;row-gap:44px')
    expect(line?.detail).toMatchObject({ tag: 'main', style: 'padding:32px;row-gap:44px' })
  })

  it('reports root-wrapper-styles-dropped when <body> carries style/data-fdn-style', () => {
    const html =
      '<!DOCTYPE html><html><head></head><body style="background:var(--color-bg)" data-fdn-style="page"><main><div>x</div></main></body></html>'
    const { report } = parseDocument(html)
    const line = report.lines.find((l) => l.code === 'root-wrapper-styles-dropped' && l.detail && (l.detail as { tag?: string }).tag === 'body')
    expect(line).toBeDefined()
    expect(line?.detail).toMatchObject({ tag: 'body', style: 'background:var(--color-bg)', 'data-fdn-style': 'page' })
  })

  it('does not report root-wrapper-styles-dropped when main/body carry no style', () => {
    const { report } = parseDocument(wrap('<div>x</div>'))
    expect(reportCodes(report.lines)).not.toContain('root-wrapper-styles-dropped')
  })
})

describe('normalization v0: node identity (data-fdn-id minting)', () => {
  it('mints ids for elements lacking data-fdn-id, in document order', () => {
    const { doc } = parseDocument(wrap('<div><span>a</span><span>b</span></div>'))
    const [outer] = doc.body
    expect(outer?.id).toBe('n1')
    expect(outer?.children.map((c) => c.id)).toEqual(['n2', 'n3'])
  })

  it('preserves an existing data-fdn-id and continues minting after its numeric value', () => {
    const { doc } = parseDocument(wrap('<div data-fdn-id="n5"><span>a</span></div>'))
    expect(doc.body[0]?.id).toBe('n5')
    expect(doc.body[0]?.children[0]?.id).toBe('n6')
  })

  it('is deterministic for a given input text (API.md "node identity")', () => {
    const html = wrap('<div><span>a</span><b>c</b><i><u>d</u></i></div>')
    const { doc: doc1 } = parseDocument(html)
    const { doc: doc2 } = parseDocument(html)
    expect(doc2).toStrictEqual(doc1)
  })
})

describe('normalization v0: self-closing fdn-* tag rewrite', () => {
  it('does not let a self-closed fdn-use swallow a following sibling', () => {
    // Verified empirically: parse5 (spec-conformant HTML5 tree construction)
    // ignores "/>" on non-void, non-foreign elements, so this would otherwise
    // nest <span>after</span> INSIDE the fdn-use. See parse/index.ts.
    const html = wrap('<div><fdn-use component="X"/><span>after</span></div>')
    const { doc, report } = parseDocument(html)
    const container = doc.body[0]
    expect(container?.children.map((c) => c.tag)).toEqual(['fdn-use', 'span'])
    expect(reportCodes(report.lines)).toContain('self-closing-tag-normalized')
  })
})

describe('normalization v0: resolved <fdn-use> children collapse to template form', () => {
  it('drops resolved children of fdn-use and reports resolved-instance-collapsed', () => {
    const html = wrap(
      '<fdn-use component="NavRow" data-fdn-prop-label="Getting started"><span>Getting started</span></fdn-use>',
    )
    const { doc, report } = parseDocument(html)
    const use = doc.body[0]
    expect(use?.tag).toBe('fdn-use')
    expect(use?.children).toEqual([])
    expect(use?.attrs.component).toBe('NavRow')
    expect(use?.attrs['data-fdn-prop-label']).toBe('Getting started')
    expect(reportCodes(report.lines)).toContain('resolved-instance-collapsed')
  })

  it('does not report resolved-instance-collapsed for an already-empty fdn-use', () => {
    const { report } = parseDocument(wrap('<fdn-use component="X" data-fdn-prop-a="1"></fdn-use>'))
    expect(reportCodes(report.lines)).not.toContain('resolved-instance-collapsed')
  })
})

describe('normalization v0: legacy attribute folding', () => {
  it('folds data-fdn-when into `when`', () => {
    const { doc, report } = parseDocument(wrap(`<div data-fdn-when="detailMode == 'review'">x</div>`))
    expect(doc.body[0]?.when).toBe("detailMode == 'review'")
    expect(reportCodes(report.lines)).toContain('legacy-attr-folded')
  })

  it('folds data-fdn-each-filter alongside `each` into `when`', () => {
    const { doc } = parseDocument(
      wrap(`<fdn-use each="item in data.x" data-fdn-each-filter="item.outside == 'false'" component="Row"></fdn-use>`),
    )
    expect(doc.body[0]?.each).toBe('item in data.x')
    expect(doc.body[0]?.when).toContain("item.outside == 'false'")
    expect(doc.body[0]?.attrs['data-fdn-each-filter']).toBeUndefined()
  })
})

describe('normalization v0: text whitespace', () => {
  it('trims and collapses pretty-printed whitespace around text content', () => {
    const html = wrap('<div>\n        Hello   world\n      </div>')
    const { doc } = parseDocument(html)
    expect(doc.body[0]?.text).toBe('Hello world')
  })

  it('leaves a node with only whitespace-only text children untouched (no false text)', () => {
    const html = wrap('<div>\n  <span>a</span>\n  <span>b</span>\n</div>')
    const { doc } = parseDocument(html)
    expect(doc.body[0]?.text).toBeUndefined()
  })
})

describe('normalization v0: style lifting and text/children carrying', () => {
  it('lifts inline style="" into node.style', () => {
    const { doc } = parseDocument(wrap('<div style="color:red;background:blue"></div>'))
    expect(doc.body[0]?.style).toEqual({ color: 'red', background: 'blue' })
  })

  it('lifts data-fdn-style into styleRef', () => {
    const { doc } = parseDocument(wrap('<div data-fdn-style="row-label"></div>'))
    expect(doc.body[0]?.styleRef).toBe('row-label')
  })

  it('lifts style-hover/-focus/-active/-disabled into styleStates planes', () => {
    const html = wrap('<div style-hover="background:red" style-focus="outline:1px solid blue"></div>')
    const { doc } = parseDocument(html)
    expect(doc.body[0]?.styleStates.hover).toEqual({ background: 'red' })
    expect(doc.body[0]?.styleStates.focus).toEqual({ outline: '1px solid blue' })
  })

  it('carries BOTH text and children when a node mixes them (validation concern, not a parse drop)', () => {
    const html = wrap('<div>{{ prop.text }}<span>trailing</span></div>')
    const { doc } = parseDocument(html)
    expect(doc.body[0]?.text).toBe('{{ prop.text }}')
    expect(doc.body[0]?.children.map((c) => c.tag)).toEqual(['span'])
  })
})
