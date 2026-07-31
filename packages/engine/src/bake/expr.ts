/**
 * Expression grammar (parser + evaluator) for the {{ … }} interpolation
 * facility and `when` conditionals — see the EXPRESSION GRAMMAR comment
 * block in src/types.ts, which is the normative source for this module.
 *
 * Hand-rolled recursive descent, no dependencies. Nothing in this module
 * ever throws out of its public entry points: malformed expressions and
 * unknown references resolve to an empty string / false and surface as a
 * ConformanceReport line instead.
 */

import type { FdnLookup, NodeId, ReportLine } from '../types.js'

// ——— evaluation context ———

/** Binding namespace → field bag. Always has 'prop' and 'param'; 'item' and
 *  any named each-loop binding are added dynamically by the bake walk. */
export interface ExprContext {
  bindings: Record<string, Record<string, unknown>>
  lookups: FdnLookup[]
}

export interface EvalResult {
  value: string
  reports: ReportLine[]
}

export interface RefResolution {
  ok: boolean
  value: unknown
}

// ——— tokenizer ———

type Tok =
  | { t: 'ident'; v: string }
  | { t: 'str'; v: string }
  | { t: 'num'; v: string }
  | { t: 'dot' }
  | { t: 'lbrack' }
  | { t: 'rbrack' }
  | { t: 'qmark' }
  | { t: 'colon' }
  | { t: 'eqeq' }
  | { t: 'noteq' }
  | { t: 'andand' }
  | { t: 'oror' }
  | { t: 'bang' }
  | { t: 'eof' }

class ExprSyntaxError extends Error {}

const IDENT_START = /[A-Za-z_]/
const IDENT_CHAR = /[A-Za-z0-9_-]/
const DIGIT = /[0-9]/

function tokenize(src: string): Tok[] {
  const toks: Tok[] = []
  let i = 0
  const n = src.length
  while (i < n) {
    const c = src[i] as string
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++
      continue
    }
    if (c === '.') {
      toks.push({ t: 'dot' })
      i++
      continue
    }
    if (c === '[') {
      toks.push({ t: 'lbrack' })
      i++
      continue
    }
    if (c === ']') {
      toks.push({ t: 'rbrack' })
      i++
      continue
    }
    if (c === '?') {
      toks.push({ t: 'qmark' })
      i++
      continue
    }
    if (c === ':') {
      toks.push({ t: 'colon' })
      i++
      continue
    }
    if (c === '!') {
      if (src[i + 1] === '=') {
        toks.push({ t: 'noteq' })
        i += 2
      } else {
        toks.push({ t: 'bang' })
        i++
      }
      continue
    }
    if (c === '=') {
      if (src[i + 1] === '=') {
        toks.push({ t: 'eqeq' })
        i += 2
        continue
      }
      throw new ExprSyntaxError(`unexpected '=' at position ${i} (did you mean '=='?)`)
    }
    if (c === '&') {
      if (src[i + 1] === '&') {
        toks.push({ t: 'andand' })
        i += 2
        continue
      }
      throw new ExprSyntaxError(`unexpected '&' at position ${i} (did you mean '&&'?)`)
    }
    if (c === '|') {
      if (src[i + 1] === '|') {
        toks.push({ t: 'oror' })
        i += 2
        continue
      }
      throw new ExprSyntaxError(`unexpected '|' at position ${i} (did you mean '||'?)`)
    }
    if (c === "'" || c === '"') {
      const quote = c
      let j = i + 1
      let out = ''
      while (j < n && src[j] !== quote) {
        out += src[j]
        j++
      }
      if (j >= n) throw new ExprSyntaxError(`unterminated string literal starting at position ${i}`)
      toks.push({ t: 'str', v: out })
      i = j + 1
      continue
    }
    if (DIGIT.test(c) || (c === '-' && DIGIT.test(src[i + 1] ?? ''))) {
      let j = i + 1
      while (j < n && (DIGIT.test(src[j] as string) || src[j] === '.')) j++
      toks.push({ t: 'num', v: src.slice(i, j) })
      i = j
      continue
    }
    if (IDENT_START.test(c)) {
      let j = i + 1
      while (j < n && IDENT_CHAR.test(src[j] as string)) j++
      toks.push({ t: 'ident', v: src.slice(i, j) })
      i = j
      continue
    }
    throw new ExprSyntaxError(`unexpected character '${c}' at position ${i}`)
  }
  toks.push({ t: 'eof' })
  return toks
}

// ——— AST ———

type ValueNode =
  | { kind: 'lit'; value: string }
  | { kind: 'ref'; path: string[] }
  | { kind: 'lookup'; name: string; ref: string[] }

type Literal = { kind: 'lit'; value: string | number | boolean }

type CondNode = { kind: 'truthy'; ref: string[] } | { kind: 'cmp'; ref: string[]; op: '==' | '!='; literal: Literal }

type BoolNode = { kind: 'cond'; cond: CondNode } | { kind: 'and'; left: BoolNode; right: BoolNode } | { kind: 'or'; left: BoolNode; right: BoolNode } | { kind: 'not'; inner: BoolNode }

type InterpTop = { kind: 'value'; node: ValueNode } | { kind: 'ternary'; cond: CondNode; then: ValueNode; else: ValueNode }

// ——— parser ———

class Parser {
  private pos = 0
  constructor(private toks: Tok[]) {}

  peek(): Tok {
    return this.toks[this.pos] as Tok
  }

  next(): Tok {
    const t = this.toks[this.pos] as Tok
    this.pos++
    return t
  }

  expectEof(): void {
    if (this.peek().t !== 'eof') throw new ExprSyntaxError(`unexpected trailing input at token ${this.pos}`)
  }

  expectIdent(): string {
    const t = this.next()
    if (t.t !== 'ident') throw new ExprSyntaxError('expected identifier')
    return t.v
  }

  parseRefPath(): string[] {
    const first = this.expectIdent()
    const path = [first]
    if (this.peek().t !== 'dot') {
      throw new ExprSyntaxError(`expected '.' after '${first}' (a ref is prefix.ident[.ident...])`)
    }
    while (this.peek().t === 'dot') {
      this.next()
      path.push(this.expectIdent())
    }
    return path
  }

  /** value := ref | lookupref | quoted-string-literal */
  parseValue(): ValueNode {
    const t = this.peek()
    if (t.t === 'str') {
      this.next()
      return { kind: 'lit', value: t.v }
    }
    if (t.t === 'ident') {
      const name = t.v
      this.next()
      if (this.peek().t === 'lbrack') {
        this.next()
        const ref = this.parseRefPath()
        if (this.peek().t !== 'rbrack') throw new ExprSyntaxError(`expected ']' to close lookup "${name}[...]"`)
        this.next()
        return { kind: 'lookup', name, ref }
      }
      if (this.peek().t === 'dot') {
        const path = [name]
        while (this.peek().t === 'dot') {
          this.next()
          path.push(this.expectIdent())
        }
        return { kind: 'ref', path }
      }
      throw new ExprSyntaxError(`expected '.' or '[' after identifier '${name}'`)
    }
    throw new ExprSyntaxError('expected a value (ref, lookup[ref], or quoted string)')
  }

  parseLiteral(): Literal {
    const t = this.next()
    if (t.t === 'str') return { kind: 'lit', value: t.v }
    if (t.t === 'num') return { kind: 'lit', value: Number(t.v) }
    if (t.t === 'ident' && (t.v === 'true' || t.v === 'false')) return { kind: 'lit', value: t.v === 'true' }
    throw new ExprSyntaxError('expected a literal (quoted string, number, or boolean) after comparison operator')
  }

  /** cond := ref | ref ('==' | '!=') (quoted-string-literal | number | boolean) */
  parseCond(): CondNode {
    const ref = this.parseRefPath()
    const t = this.peek()
    if (t.t === 'eqeq' || t.t === 'noteq') {
      this.next()
      const literal = this.parseLiteral()
      return { kind: 'cmp', ref, op: t.t === 'eqeq' ? '==' : '!=', literal }
    }
    return { kind: 'truthy', ref }
  }

  /** {{ … }} top level: ternary | value */
  parseInterpTop(): InterpTop {
    const t = this.peek()
    if (t.t === 'str') {
      const v = this.parseValue()
      this.expectEof()
      return { kind: 'value', node: v }
    }
    if (t.t === 'ident') {
      // lookahead: ident '[' => lookupref value, no ternary condition possible
      const save = this.pos
      this.next()
      if (this.peek().t === 'lbrack') {
        this.pos = save
        const v = this.parseValue()
        this.expectEof()
        return { kind: 'value', node: v }
      }
      this.pos = save
      const cond = this.parseCond()
      if (this.peek().t === 'qmark') {
        this.next()
        const thenV = this.parseValue()
        if (this.peek().t !== 'colon') throw new ExprSyntaxError("expected ':' in ternary")
        this.next()
        const elseV = this.parseValue()
        this.expectEof()
        return { kind: 'ternary', cond, then: thenV, else: elseV }
      }
      if (cond.kind === 'cmp') {
        throw new ExprSyntaxError('a bare comparison is only valid as a ternary condition, not a standalone value')
      }
      this.expectEof()
      return { kind: 'value', node: { kind: 'ref', path: cond.ref } }
    }
    throw new ExprSyntaxError('expected a value or condition')
  }

  /** orExpr := andExpr ('||' andExpr)* */
  parseOr(): BoolNode {
    let left = this.parseAnd()
    while (this.peek().t === 'oror') {
      this.next()
      const right = this.parseAnd()
      left = { kind: 'or', left, right }
    }
    return left
  }

  /** andExpr := notExpr ('&&' notExpr)* */
  parseAnd(): BoolNode {
    let left = this.parseNot()
    while (this.peek().t === 'andand') {
      this.next()
      const right = this.parseNot()
      left = { kind: 'and', left, right }
    }
    return left
  }

  /** notExpr := '!' notExpr | cond */
  parseNot(): BoolNode {
    if (this.peek().t === 'bang') {
      this.next()
      return { kind: 'not', inner: this.parseNot() }
    }
    return { kind: 'cond', cond: this.parseCond() }
  }

  parseWhenTop(): BoolNode {
    const node = this.parseOr()
    this.expectEof()
    return node
  }
}

// ——— reference resolution ———

/** Resolve a dotted ref path against the current binding scope. Public so
 *  the bake walk can resolve `each`'s source expression, which uses the
 *  same ref grammar but is not wrapped in {{ }}. */
export function resolveRef(path: string[], ctx: ExprContext): RefResolution {
  if (path.length < 1) return { ok: false, value: undefined }
  const [prefix, ...rest] = path as [string, ...string[]]
  const bag = ctx.bindings[prefix]
  if (bag === undefined) return { ok: false, value: undefined }
  let cur: unknown = bag
  for (const seg of rest) {
    if (cur === null || typeof cur !== 'object') return { ok: false, value: undefined }
    if (!Object.prototype.hasOwnProperty.call(cur, seg)) return { ok: false, value: undefined }
    cur = (cur as Record<string, unknown>)[seg]
  }
  return { ok: true, value: cur }
}

function toComparable(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return String(value)
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function isTruthy(value: unknown): boolean {
  if (value === undefined || value === null) return false
  if (typeof value === 'string') return value.length > 0
  if (typeof value === 'number') return value !== 0 && !Number.isNaN(value)
  if (typeof value === 'boolean') return value
  if (Array.isArray(value)) return value.length > 0
  return true
}

export function stringifyValue(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return String(value)
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function refLabel(path: string[]): string {
  return path.join('.')
}

function makeReport(code: string, message: string, nodeId?: NodeId): ReportLine {
  return { code, severity: code === 'expr-parse-error' ? 'error' : 'warning', message, nodeId }
}

// ——— value / cond evaluation ———

function evalValueNode(node: ValueNode, ctx: ExprContext, nodeId?: NodeId): { value: unknown; reports: ReportLine[] } {
  if (node.kind === 'lit') return { value: node.value, reports: [] }
  if (node.kind === 'ref') {
    const r = resolveRef(node.path, ctx)
    if (!r.ok) {
      return { value: '', reports: [makeReport('unknown-ref', `unknown reference '${refLabel(node.path)}'`, nodeId)] }
    }
    return { value: r.value, reports: [] }
  }
  // lookup
  const lookup = ctx.lookups.find((l) => l.name === node.name)
  if (!lookup) {
    return { value: '', reports: [makeReport('undeclared-lookup', `lookup table '${node.name}' is not declared`, nodeId)] }
  }
  const keyRes = resolveRef(node.ref, ctx)
  if (!keyRes.ok) {
    return { value: '', reports: [makeReport('unknown-ref', `unknown reference '${refLabel(node.ref)}' used as lookup key`, nodeId)] }
  }
  const key = stringifyValue(keyRes.value)
  if (!Object.prototype.hasOwnProperty.call(lookup.entries, key)) {
    return { value: '', reports: [makeReport('lookup-key-miss', `lookup '${node.name}' has no entry for key '${key}'`, nodeId)] }
  }
  return { value: lookup.entries[key], reports: [] }
}

function evalCond(cond: CondNode, ctx: ExprContext, nodeId?: NodeId): { value: boolean; reports: ReportLine[] } {
  const r = resolveRef(cond.ref, ctx)
  if (!r.ok) {
    return { value: false, reports: [makeReport('unknown-ref', `unknown reference '${refLabel(cond.ref)}'`, nodeId)] }
  }
  if (cond.kind === 'truthy') return { value: isTruthy(r.value), reports: [] }
  const lhs = toComparable(r.value)
  const rhs = toComparable(cond.literal.value)
  const eq = lhs === rhs
  return { value: cond.op === '==' ? eq : !eq, reports: [] }
}

function evalBool(node: BoolNode, ctx: ExprContext, nodeId?: NodeId): { value: boolean; reports: ReportLine[] } {
  if (node.kind === 'cond') return evalCond(node.cond, ctx, nodeId)
  if (node.kind === 'not') {
    const r = evalBool(node.inner, ctx, nodeId)
    return { value: !r.value, reports: r.reports }
  }
  const left = evalBool(node.left, ctx, nodeId)
  const right = evalBool(node.right, ctx, nodeId)
  const reports = [...left.reports, ...right.reports]
  const value = node.kind === 'and' ? left.value && right.value : left.value || right.value
  return { value, reports }
}

// ——— public entry points ———

/** Evaluate the content of one `{{ … }}` span (grammar: ternary | value). */
export function evaluateInterpolation(src: string, ctx: ExprContext, nodeId?: NodeId): EvalResult {
  try {
    const p = new Parser(tokenize(src))
    const top = p.parseInterpTop()
    if (top.kind === 'value') {
      const r = evalValueNode(top.node, ctx, nodeId)
      return { value: stringifyValue(r.value), reports: r.reports }
    }
    const c = evalCond(top.cond, ctx, nodeId)
    const branch = c.value ? top.then : top.else
    const r = evalValueNode(branch, ctx, nodeId)
    return { value: stringifyValue(r.value), reports: [...c.reports, ...r.reports] }
  } catch (e) {
    return { value: '', reports: [makeReport('expr-parse-error', describeError(e, src), nodeId)] }
  }
}

/** Replace every `{{ … }}` span in `template` with its evaluated value. */
export function interpolateString(template: string, ctx: ExprContext, nodeId?: NodeId): EvalResult {
  if (!template.includes('{{')) return { value: template, reports: [] }
  const re = /\{\{\s*([\s\S]*?)\s*\}\}/g
  const reports: ReportLine[] = []
  let result = ''
  let lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(template)) !== null) {
    result += template.slice(lastIndex, m.index)
    const inner = m[1] ?? ''
    const r = evaluateInterpolation(inner, ctx, nodeId)
    reports.push(...r.reports)
    result += r.value
    lastIndex = re.lastIndex
  }
  result += template.slice(lastIndex)
  return { value: result, reports }
}

/** Evaluate a `when` attribute: <cond> plus &&/||/! composition. */
export function evaluateWhen(src: string, ctx: ExprContext, nodeId?: NodeId): { value: boolean; reports: ReportLine[] } {
  try {
    const p = new Parser(tokenize(src))
    const node = p.parseWhenTop()
    return evalBool(node, ctx, nodeId)
  } catch (e) {
    return { value: false, reports: [makeReport('expr-parse-error', describeError(e, src), nodeId)] }
  }
}

function describeError(e: unknown, src: string): string {
  const msg = e instanceof Error ? e.message : String(e)
  return `expression "${src}" failed to parse: ${msg}`
}
