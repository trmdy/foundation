import { describe, expect, it } from 'vitest'
import { evaluateInterpolation, evaluateWhen, interpolateString, type ExprContext } from '../src/bake/expr.js'
import type { FdnLookup } from '../src/types.js'

function ctx(overrides: Partial<ExprContext> = {}): ExprContext {
  return {
    bindings: {
      prop: { title: 'Hello', selected: true, count: 3, empty: '' },
      param: { theme: 'dark', flag: false },
      item: { name: 'Row A', state: 'failed' },
      ...overrides.bindings,
    },
    lookups: overrides.lookups ?? [],
  }
}

const statusLookup: FdnLookup = {
  name: 'statusColor',
  entries: { failed: '#B0512E', waiting: '#D4A72C' },
}

describe('expr: refs', () => {
  it('resolves a prop ref', () => {
    const r = evaluateInterpolation('prop.title', ctx())
    expect(r.value).toBe('Hello')
    expect(r.reports).toEqual([])
  })

  it('resolves a param ref', () => {
    const r = evaluateInterpolation('param.theme', ctx())
    expect(r.value).toBe('dark')
  })

  it('resolves an item ref', () => {
    const r = evaluateInterpolation('item.name', ctx())
    expect(r.value).toBe('Row A')
  })

  it('resolves nested dotted paths', () => {
    const r = evaluateInterpolation('prop.deep.field', ctx({ bindings: { prop: { deep: { field: 'nested' } }, param: {}, item: {} } }))
    expect(r.value).toBe('nested')
  })

  it('stringifies booleans and numbers', () => {
    expect(evaluateInterpolation('prop.selected', ctx()).value).toBe('true')
    expect(evaluateInterpolation('prop.count', ctx()).value).toBe('3')
  })

  it('unknown-ref: unrecognized prefix', () => {
    const r = evaluateInterpolation('bogus.field', ctx())
    expect(r.value).toBe('')
    expect(r.reports).toHaveLength(1)
    expect(r.reports[0]?.code).toBe('unknown-ref')
  })

  it('unknown-ref: missing field on a known prefix', () => {
    const r = evaluateInterpolation('prop.doesNotExist', ctx())
    expect(r.value).toBe('')
    expect(r.reports[0]?.code).toBe('unknown-ref')
  })
})

describe('expr: string literals', () => {
  it('evaluates a bare quoted string literal', () => {
    expect(evaluateInterpolation("'hello world'", ctx()).value).toBe('hello world')
    expect(evaluateInterpolation('"double quoted"', ctx()).value).toBe('double quoted')
  })
})

describe('expr: number literals (types.ts grammar: value := ref | lookupref | quoted-string-literal | number-literal)', () => {
  it('evaluates a bare integer literal', () => {
    expect(evaluateInterpolation('12', ctx()).value).toBe('12')
  })

  it('evaluates a bare leading-zero decimal literal', () => {
    expect(evaluateInterpolation('0.5', ctx()).value).toBe('0.5')
  })

  it('evaluates a bare leading-dot decimal literal', () => {
    expect(evaluateInterpolation('.5', ctx()).value).toBe('0.5')
  })

  it('a number literal is legal as a ternary branch value (the reported bug: opacity/font-weight ternaries)', () => {
    expect(evaluateInterpolation('prop.selected ? .5 : 1', ctx()).value).toBe('0.5')
    expect(evaluateInterpolation('param.flag ? 0.5 : 1', ctx()).value).toBe('1')
    expect(evaluateInterpolation('param.flag ? 600 : 400', ctx()).value).toBe('400')
    expect(evaluateInterpolation("item.state == 'failed' ? 600 : 400", ctx()).value).toBe('600')
  })

  it('a number literal may be mixed with a ref branch on the other side of the ternary', () => {
    const r = evaluateInterpolation("item.state == 'failed' ? prop.count : 0", ctx())
    expect(r.value).toBe('3')
  })

  it('reports no errors for a numeric ternary', () => {
    const r = evaluateInterpolation('prop.selected ? .5 : 1', ctx())
    expect(r.reports).toEqual([])
  })
})

describe('expr: ternary', () => {
  it('bare-ref truthy ternary picks the then-branch', () => {
    const r = evaluateInterpolation("prop.selected ? 'yes' : 'no'", ctx())
    expect(r.value).toBe('yes')
  })

  it('bare-ref falsy ternary picks the else-branch', () => {
    const r = evaluateInterpolation("param.flag ? 'yes' : 'no'", ctx())
    expect(r.value).toBe('no')
  })

  it('comparison ternary', () => {
    const r = evaluateInterpolation("item.state == 'failed' ? 'red' : 'green'", ctx())
    expect(r.value).toBe('red')
  })

  it('!= comparison ternary', () => {
    const r = evaluateInterpolation("item.state != 'failed' ? 'red' : 'green'", ctx())
    expect(r.value).toBe('green')
  })

  it('ternary branches may be refs', () => {
    const r = evaluateInterpolation('prop.selected ? prop.title : param.theme', ctx())
    expect(r.value).toBe('Hello')
  })

  it('a bare comparison outside a ternary is a parse error', () => {
    const r = evaluateInterpolation("item.state == 'failed'", ctx())
    expect(r.value).toBe('')
    expect(r.reports[0]?.code).toBe('expr-parse-error')
  })
})

describe('expr: lookup refs', () => {
  it('resolves a declared lookup by a ref key', () => {
    const r = evaluateInterpolation('statusColor[item.state]', ctx({ lookups: [statusLookup] }))
    expect(r.value).toBe('#B0512E')
    expect(r.reports).toEqual([])
  })

  it('undeclared-lookup when the lookup name is not declared', () => {
    const r = evaluateInterpolation('missingLookup[item.state]', ctx())
    expect(r.value).toBe('')
    expect(r.reports[0]?.code).toBe('undeclared-lookup')
  })

  it('lookup-key-miss when the lookup exists but the key does not', () => {
    const r = evaluateInterpolation('statusColor[prop.title]', ctx({ lookups: [statusLookup] }))
    expect(r.value).toBe('')
    expect(r.reports[0]?.code).toBe('lookup-key-miss')
  })

  it('lookupref with an unknown inner ref reports unknown-ref, not lookup-key-miss', () => {
    const r = evaluateInterpolation('statusColor[item.bogus]', ctx({ lookups: [statusLookup] }))
    expect(r.reports[0]?.code).toBe('unknown-ref')
  })
})

describe('expr: malformed expressions never throw', () => {
  const bad = ['prop', 'prop.', '???', "prop.title ? 'a'", 'prop.title[', "'unterminated", 'prop..title', 'lookup[prop.x', 'prop.title == ']
  it.each(bad)('malformed "%s" resolves to empty string with expr-parse-error', (src) => {
    const r = evaluateInterpolation(src, ctx())
    expect(r.value).toBe('')
    expect(r.reports.some((l) => l.code === 'expr-parse-error')).toBe(true)
  })
})

describe('expr: interpolateString', () => {
  it('leaves plain text untouched', () => {
    expect(interpolateString('just text', ctx()).value).toBe('just text')
  })

  it('splices multiple interpolations into surrounding text', () => {
    const r = interpolateString('{{ prop.title }} is {{ item.state }}', ctx())
    expect(r.value).toBe('Hello is failed')
  })

  it('trims whitespace inside the braces', () => {
    const r = interpolateString('{{   prop.title   }}', ctx())
    expect(r.value).toBe('Hello')
  })

  it('collects reports from every embedded expression', () => {
    const r = interpolateString('{{ bogus.a }} and {{ another.bogus }}', ctx())
    expect(r.reports).toHaveLength(2)
    expect(r.reports.every((l) => l.code === 'unknown-ref')).toBe(true)
  })
})

describe('expr: when — comparisons and boolean composition', () => {
  it('plain ref truthiness', () => {
    expect(evaluateWhen('prop.selected', ctx()).value).toBe(true)
    expect(evaluateWhen('param.flag', ctx()).value).toBe(false)
  })

  it('== and !=', () => {
    expect(evaluateWhen("item.state == 'failed'", ctx()).value).toBe(true)
    expect(evaluateWhen("item.state != 'failed'", ctx()).value).toBe(false)
  })

  it('&& composition', () => {
    expect(evaluateWhen("prop.selected && item.state == 'failed'", ctx()).value).toBe(true)
    expect(evaluateWhen('prop.selected && param.flag', ctx()).value).toBe(false)
  })

  it('|| composition', () => {
    expect(evaluateWhen('param.flag || prop.selected', ctx()).value).toBe(true)
    expect(evaluateWhen('param.flag || param.flag', ctx()).value).toBe(false)
  })

  it('! negation', () => {
    expect(evaluateWhen('!param.flag', ctx()).value).toBe(true)
    expect(evaluateWhen('!prop.selected', ctx()).value).toBe(false)
  })

  it('precedence: ! tighter than &&, && tighter than ||', () => {
    // !flag && selected  =>  true && true => true
    expect(evaluateWhen('!param.flag && prop.selected', ctx()).value).toBe(true)
    // flag || selected && !flag  =>  false || (true && true) => true
    expect(evaluateWhen('param.flag || prop.selected && !param.flag', ctx()).value).toBe(true)
  })

  it('malformed when resolves to false with expr-parse-error, never throws', () => {
    const r = evaluateWhen('prop.title &&& param.flag', ctx())
    expect(r.value).toBe(false)
    expect(r.reports[0]?.code).toBe('expr-parse-error')
  })

  it('unknown ref inside when resolves to false with unknown-ref', () => {
    const r = evaluateWhen('bogus.field', ctx())
    expect(r.value).toBe(false)
    expect(r.reports[0]?.code).toBe('unknown-ref')
  })
})
