import { describe, expect, it } from 'vitest'
import { parseDocument } from '../src/parse/index.js'
import { projectDocument } from '../src/project/index.js'

function wrap(bodyHtml: string): string {
  return `<!DOCTYPE html><html><head><style>:root{--x:1px}</style></head><body><main>${bodyHtml}</main></body></html>`
}

function wrapCss(css: string, bodyHtml: string): string {
  return `<!DOCTYPE html><html><head><style>${css}</style></head><body><main>${bodyHtml}</main></body></html>`
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

  // Regression (Wave 4 Stage 3 bug fix): tokenizeTopLevel used to split a
  // shorthand value on EVERY top-level whitespace character with no
  // paren-depth tracking, so a calc()-shaped value's internal whitespace
  // (e.g. Tailwind v4's `border-radius: calc(infinity * 1px)`) split into
  // bogus extra tokens and corrupted TRBL/radius expansion. Covered here in
  // both a "shorthand position" (the whole declaration value is one calc()
  // expression) and a "longhand position" (calc() is one of several
  // space-separated values within a multi-value shorthand).
  it('treats a calc() value as one atomic token in border-radius (shorthand position)', () => {
    const { doc } = parseDocument(wrap('<div style="border-radius:calc(infinity * 1px)"></div>'))
    expect(doc.body[0]?.style).toEqual({
      'border-top-left-radius': 'calc(infinity * 1px)',
      'border-top-right-radius': 'calc(infinity * 1px)',
      'border-bottom-right-radius': 'calc(infinity * 1px)',
      'border-bottom-left-radius': 'calc(infinity * 1px)',
    })
  })

  it('treats a calc() value as one atomic token in padding (longhand position, mixed with a plain value)', () => {
    const { doc } = parseDocument(wrap('<div style="padding:calc(infinity * 1px) 8px"></div>'))
    expect(doc.body[0]?.style).toEqual({
      'padding-top': 'calc(infinity * 1px)',
      'padding-right': '8px',
      'padding-bottom': 'calc(infinity * 1px)',
      'padding-left': '8px',
    })
  })

  it('does not corrupt a nested calc()-in-var() longhand slot inside a 4-value shorthand', () => {
    const { doc } = parseDocument(
      wrap('<div style="margin:1px calc(2px + var(--gap, 3px)) 4px 5px"></div>'),
    )
    expect(doc.body[0]?.style).toEqual({
      'margin-top': '1px',
      'margin-right': 'calc(2px + var(--gap, 3px))',
      'margin-bottom': '4px',
      'margin-left': '5px',
    })
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

describe('normalization v0: class-CSS lifting (SPEC D1 — classes/stylesheets lifted into node/named-style model)', () => {
  it('lifts a single-class flat selector into a named style and refs it via data-fdn-style, consuming the class attr', () => {
    const html = wrapCss('.card { color: red; background: blue; }', '<div class="card"></div>')
    const { doc, report } = parseDocument(html)
    const node = doc.body[0]
    expect(node?.attrs.class).toBeUndefined()
    expect(node?.styleRef).toBe('card')
    const named = doc.namedStyles.find((s) => s.name === 'card')
    expect(named?.style).toEqual({ color: 'red', background: 'blue' })
    expect(reportCodes(report.lines)).toContain('class-style-lifted')
    expect(reportCodes(report.lines)).toContain('class-attr-consumed')
  })

  it('longhand-normalizes lifted class declarations through the existing shorthand pipeline', () => {
    const html = wrapCss('.box { padding: 1px 2px 3px 4px; }', '<div class="box"></div>')
    const { doc, report } = parseDocument(html)
    const named = doc.namedStyles.find((s) => s.name === 'box')
    expect(named?.style).toEqual({
      'padding-top': '1px',
      'padding-right': '2px',
      'padding-bottom': '3px',
      'padding-left': '4px',
    })
    expect(reportCodes(report.lines)).toContain('shorthand-expanded')
  })

  it('merges multi-class elements into the node\'s own inline style instead of a named-style ref, and keeps the class attr', () => {
    const html = wrapCss('.a { color: red; } .b { background: blue; }', '<div class="a b"></div>')
    const { doc, report } = parseDocument(html)
    const node = doc.body[0]
    expect(node?.styleRef).toBeUndefined()
    expect(node?.style).toEqual({ color: 'red', background: 'blue' })
    expect(node?.attrs.class).toBe('a b')
    const line = report.lines.find((l) => l.code === 'class-styles-merged')
    expect(line).toBeDefined()
    expect(line?.detail).toMatchObject({ class: 'a b', merged: ['a', 'b'] })
  })

  it('multi-class merge follows stylesheet order for conflicting properties, later rule wins', () => {
    const html = wrapCss('.a { color: red; } .b { color: blue; }', '<div class="b a"></div>')
    const { doc } = parseDocument(html)
    // .b is declared AFTER .a in the stylesheet, so .b wins on the shared
    // "color" property regardless of the order the classes are listed on
    // the element itself (class="b a") — merge order follows the cascade
    // (stylesheet order), not attribute-string order.
    expect(doc.body[0]?.style.color).toBe('blue')
  })

  it('the node\'s own inline style="" wins over merged class declarations on conflicting props', () => {
    const html = wrapCss('.a { color: red; } .b { background: blue; }', '<div class="a b" style="color:green"></div>')
    const { doc } = parseDocument(html)
    expect(doc.body[0]?.style).toEqual({ color: 'green', background: 'blue' })
  })

  it('a multi-class element merges only the classes that matched a lifted rule; unmatched classes are inert', () => {
    const html = wrapCss('.turn-line { width: 76%; }', '<div class="turn-line short"></div>')
    const { doc, report } = parseDocument(html)
    const node = doc.body[0]
    expect(node?.style).toEqual({ width: '76%' })
    expect(node?.attrs.class).toBe('turn-line short')
    const line = report.lines.find((l) => l.code === 'class-styles-merged')
    expect(line?.detail).toMatchObject({ merged: ['turn-line'] })
  })

  it('lifts .foo:hover/:focus/:active/:disabled into the named style\'s state planes', () => {
    const html = wrapCss(
      '.row { padding: 4px; } .row:hover { background: red; } .row:focus { outline: 1px solid blue; }',
      '<div class="row"></div>',
    )
    const { doc, report } = parseDocument(html)
    const named = doc.namedStyles.find((s) => s.name === 'row')
    expect(named?.styleStates.hover).toEqual({ background: 'red' })
    expect(named?.styleStates.focus).toEqual({ outline: '1px solid blue' })
    expect(reportCodes(report.lines)).toContain('class-style-state-lifted')
  })

  it('a class with ONLY a pseudo-state rule (no base rule) still lifts into a named style', () => {
    const html = wrapCss('.ghost:hover { color: red; }', '<div class="ghost"></div>')
    const { doc } = parseDocument(html)
    expect(doc.body[0]?.styleRef).toBe('ghost')
    const named = doc.namedStyles.find((s) => s.name === 'ghost')
    expect(named?.style).toEqual({})
    expect(named?.styleStates.hover).toEqual({ color: 'red' })
  })

  it('a class with no matching CSS rule is left as an ordinary, unreported class attribute', () => {
    const html = wrapCss(':root{--x:1px}', '<div class="mystery"></div>')
    const { doc, report } = parseDocument(html)
    expect(doc.body[0]?.attrs.class).toBe('mystery')
    expect(doc.body[0]?.styleRef).toBeUndefined()
    expect(reportCodes(report.lines)).not.toContain('class-styles-merged')
    expect(reportCodes(report.lines)).not.toContain('class-attr-consumed')
  })

  describe('unliftable selectors are reported and dropped with a corrective message', () => {
    const cases: { css: string; selector: string; snippet: string }[] = [
      { css: '* { box-sizing: border-box; }', selector: '*', snippet: 'universal selector' },
      { css: 'body { margin: 0; }', selector: 'body', snippet: 'element/type selector' },
      { css: '.a.b { color: red; }', selector: '.a.b', snippet: 'compound class selector' },
      { css: '.a .b { color: red; }', selector: '.a .b', snippet: 'descendant/child/sibling combinator' },
      { css: '.a > .b { color: red; }', selector: '.a > .b', snippet: 'descendant/child/sibling combinator' },
      { css: '.a::before { content: ""; }', selector: '.a::before', snippet: 'pseudo-element' },
      { css: '.a[data-x="y"] { color: red; }', selector: '.a[data-x="y"]', snippet: 'attribute selector' },
      { css: '#a { color: red; }', selector: '#a', snippet: 'id selector' },
      { css: '.a:nth-child(2) { color: red; }', selector: '.a:nth-child(2)', snippet: 'structural/functional pseudo-class' },
      { css: '.a:visited { color: red; }', selector: '.a:visited', snippet: 'sanctioned interaction-state planes' },
    ]
    for (const { css, snippet } of cases) {
      it(`drops "${css.split('{')[0]?.trim()}" — ${snippet}`, () => {
        const html = wrapCss(css, '<div class="a"></div>')
        const { report } = parseDocument(html)
        const line = report.lines.find((l) => l.code === 'non-root-style-rule-dropped')
        expect(line).toBeDefined()
        expect(line?.message).toContain(snippet)
      })
    }
  })

  it('drops @media rules with a corrective message pointing at the states × viewports matrix', () => {
    const html = wrapCss('@media (max-width: 850px) { .a { color: red; } }', '<div class="a"></div>')
    const { doc, report } = parseDocument(html)
    // the nested .a inside the dropped @media block is never reached/lifted
    expect(doc.namedStyles.find((s) => s.name === 'a')).toBeUndefined()
    const line = report.lines.find((l) => l.code === 'non-root-style-rule-dropped' && l.message.includes('@media'))
    expect(line?.message).toContain('states × viewports matrix')
  })

  it('a grouped selector (.a, .b) lifts each comma-separated class independently', () => {
    const html = wrapCss('.a, .b { color: red; }', '<div class="a"></div><div class="b"></div>')
    const { doc } = parseDocument(html)
    expect(doc.body[0]?.styleRef).toBe('a')
    expect(doc.body[1]?.styleRef).toBe('b')
    expect(doc.namedStyles.map((s) => s.name).sort()).toEqual(['a', 'b'])
  })

  it('an explicitly declared <fdn-style> wins over a same-named lifted class rule, with a collision report', () => {
    // <fdn-styles> must be a DIRECT child of <body> (sibling of <main>), same
    // as any other board — not nested inside the content tree.
    const html =
      '<!DOCTYPE html><html><head><style>.card { color: red; }</style></head>' +
      '<body><fdn-styles hidden><fdn-style name="card" color="green"></fdn-style></fdn-styles>' +
      '<main><div class="card"></div></main></body></html>'
    const { doc, report } = parseDocument(html)
    const cardStyles = doc.namedStyles.filter((s) => s.name === 'card')
    expect(cardStyles).toHaveLength(1)
    expect(cardStyles[0]?.style).toEqual({ color: 'green' })
    expect(reportCodes(report.lines)).toContain('class-style-name-collision')
  })

  it('determinism/fixpoint: re-parsing the projected output of a lifted document produces zero further lifting activity', () => {
    const html = wrapCss(
      '.card { padding: 4px; } .card:hover { color: red; } .a { color: blue; } .b { background: aqua; }',
      '<div class="card"></div><div class="a b"></div>',
    )
    const first = parseDocument(html)
    const projected = projectDocument(first.doc)
    const second = parseDocument(projected)

    // the document itself is stable (no further transformation possible)
    expect(second.doc.body).toEqual(first.doc.body)
    expect(second.doc.namedStyles).toEqual(first.doc.namedStyles)

    // and no class-lifting activity happens on the second pass — there is no
    // more class-only CSS left in the projected <style> block to lift from
    const liftCodes = ['class-style-lifted', 'class-style-state-lifted', 'class-attr-consumed', 'class-styles-merged']
    expect(second.report.lines.filter((l) => liftCodes.includes(l.code))).toHaveLength(0)

    // re-projecting the second parse is byte-identical to the first projection
    expect(projectDocument(second.doc)).toBe(projected)
  })
})
