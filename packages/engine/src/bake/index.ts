/**
 * bakeDocument — template + state → BakeResult (see API.md, src/types.ts).
 *
 * Pipeline (per node, depth-first over doc.body):
 *   1. state resolution → a flat params bag (defaults, or a named state's
 *      assignments layered over defaults; missing default → empty + report).
 *   2. each expansion (before when: an each-node is expanded first, then
 *      each iteration is independently when-gated in its own scope).
 *   3. when gating (drop node if false; malformed when → false + report).
 *   4. fdn-overlay trigger-binding exclusion (Q13 candidate v0 rule).
 *   5. fdn-use component instantiation (props bound + typed, slots filled,
 *      recursion with a component-name cycle guard).
 *   6. fdn-slot resolution inside a component body (fill content, baked in
 *      the *caller's* scope, or the slot's own default content).
 *   7. interpolation of text/attrs/style values.
 *   8. named-style inlining (styleRef merged under the node's own style —
 *      node wins) + styleStates → style-hover/-focus/-active/-disabled.
 *   9. conformance audit (off-token values, unused tokens) threaded
 *      throughout steps 7–8.
 */

import type {
  ConformanceReport,
  FdnComponent,
  FdnDocument,
  FdnNamedStyle,
  FdnNode,
  FdnParamType,
  FdnState,
  NodeId,
  ReportLine,
  StateStyleKey,
} from '../types.js'
import { evaluateWhen, interpolateString, resolveRef, stringifyValue, type ExprContext } from './expr.js'
import { emitHtml } from './emit.js'

export { emitHtml } from './emit.js'
export * from './expr.js'

const STATE_STYLE_KEYS: StateStyleKey[] = ['hover', 'focus', 'active', 'disabled']

interface BakeCtx extends ExprContext {
  doc: FdnDocument
  componentStack: string[]
  slotFills?: Record<string, FdnNode[]>
  reports: ReportLine[]
  tokenValueIndex: Map<string, string[]>
  referencedTokens: Set<string>
}

function pushReport(ctx: BakeCtx, line: ReportLine): void {
  ctx.reports.push(line)
}

export function bakeDocument(doc: FdnDocument, opts?: { state?: string }): { html: string; tree: FdnNode[]; state: string | null; report: ConformanceReport } {
  const reports: ReportLine[] = []
  const stateName = opts?.state ?? null

  let state: FdnState | undefined
  if (stateName !== null) {
    state = doc.states.find((s) => s.name === stateName)
    if (!state) {
      reports.push({
        code: 'unknown-state',
        severity: 'error',
        message: `state "${stateName}" is not declared; baking with defaults only`,
      })
    }
  }

  const params: Record<string, unknown> = {}
  for (const p of doc.params) {
    if (state && Object.prototype.hasOwnProperty.call(state.assignments, p.name)) {
      params[p.name] = state.assignments[p.name]
    } else if (p.default !== undefined) {
      params[p.name] = p.default
    } else {
      params[p.name] = ''
      reports.push({
        code: 'param-missing-default',
        severity: 'warning',
        message: `param "${p.name}" has no default and no state assignment; baked empty`,
      })
    }
  }

  const tokenValueIndex = new Map<string, string[]>()
  for (const [name, value] of Object.entries(doc.tokens)) {
    const arr = tokenValueIndex.get(value) ?? []
    arr.push(name)
    tokenValueIndex.set(value, arr)
  }

  const ctx: BakeCtx = {
    doc,
    bindings: { prop: {}, param: params },
    lookups: doc.lookups,
    componentStack: [],
    reports,
    tokenValueIndex,
    referencedTokens: new Set(),
  }

  const tree = doc.body.flatMap((n) => bakeNode(n, ctx))

  for (const name of Object.keys(doc.tokens)) {
    if (!ctx.referencedTokens.has(name)) {
      reports.push({
        code: 'unused-token',
        severity: 'info',
        message: `token "--${name}" is declared but never referenced via var(--${name}) in the baked output`,
      })
    }
  }

  const html = emitHtml(doc, tree)

  return { html, tree, state: stateName, report: { lines: reports } }
}

// ——— each / when / dispatch ———

function bakeNode(node: FdnNode, ctx: BakeCtx): FdnNode[] {
  if (node.each) {
    return bakeEach(node, ctx)
  }
  return bakeSingle(node, ctx)
}

function parseEachSpec(each: string): { binding: string; source: string } | undefined {
  const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s+in\s+(.+?)\s*$/.exec(each)
  if (!m) return undefined
  const binding = m[1] as string
  const source = m[2] as string
  return { binding, source }
}

function toBindable(item: unknown): Record<string, unknown> {
  if (item !== null && typeof item === 'object' && !Array.isArray(item)) return item as Record<string, unknown>
  // Primitive list items (list-typed params have an informal item shape per
  // types.ts) are wrapped so `{{ x.value }}` reaches them under the ref
  // grammar, which requires a dotted path. See final-report contract note.
  return { value: item }
}

// `data.<name>` is the sanctioned each-source shape (matches validate's
// checkEachSource and every board) — dispatched first, ahead of the generic
// dotted-ref fallback, since 'data' is not a binding prefix resolveRef knows
// about and would otherwise always fail as unknown-ref (the zero-items bug).
const DATA_EACH_SOURCE = /^data\.([A-Za-z_][A-Za-z0-9_]*)$/

function resolveEachSource(source: string, node: FdnNode, ctx: BakeCtx): unknown[] | undefined {
  const trimmed = source.trim()

  const dataMatch = DATA_EACH_SOURCE.exec(trimmed)
  if (dataMatch) {
    const setName = dataMatch[1] as string
    const ds = ctx.doc.data.find((d) => d.name === setName)
    if (!ds) {
      pushReport(ctx, { code: 'unknown-ref', severity: 'warning', message: `each source "${trimmed}" is not a declared data set`, nodeId: node.id })
      return undefined
    }
    return ds.items
  }

  // Dotted, non-`data.` sources: prop./param. list-typed refs, or a ref into
  // a bound each-alias (nested each, e.g. "member in group.members").
  if (trimmed.includes('.')) {
    const path = trimmed.split('.')
    const r = resolveRef(path, ctx)
    if (!r.ok) {
      pushReport(ctx, { code: 'unknown-ref', severity: 'warning', message: `each source "${trimmed}" not found`, nodeId: node.id })
      return undefined
    }
    if (!Array.isArray(r.value)) {
      pushReport(ctx, { code: 'each-source-not-list', severity: 'error', message: `each source "${trimmed}" did not resolve to a list`, nodeId: node.id })
      return undefined
    }
    return r.value
  }

  // Bare data-set name: deprecated back-compat form. `validate` requires the
  // dotted `data.<name>` shape, so this always trips a report line even on
  // success — the deprecation is the point, not an error.
  const ds = ctx.doc.data.find((d) => d.name === trimmed)
  if (!ds) {
    pushReport(ctx, { code: 'unknown-ref', severity: 'warning', message: `each source "${trimmed}" is not a declared data set`, nodeId: node.id })
    return undefined
  }
  pushReport(ctx, {
    code: 'each-bare-data-source',
    severity: 'warning',
    message: `each source "${trimmed}" uses the deprecated bare data-set name; write "data.${trimmed}" instead (the shape validate requires)`,
    nodeId: node.id,
  })
  return ds.items
}

function bakeEach(node: FdnNode, ctx: BakeCtx): FdnNode[] {
  const spec = parseEachSpec(node.each as string)
  if (!spec) {
    pushReport(ctx, { code: 'expr-parse-error', severity: 'error', message: `malformed each="${node.each}" (expected "<name> in <ref>")`, nodeId: node.id })
    return []
  }
  const items = resolveEachSource(spec.source, node, ctx)
  if (!items) return []
  const stripped: FdnNode = { ...node, each: undefined }
  const out: FdnNode[] = []
  items.forEach((item, i) => {
    const childBindings = { ...ctx.bindings, [spec.binding]: toBindable(item) }
    const childCtx: BakeCtx = { ...ctx, bindings: childBindings }
    const baked = bakeSingle(stripped, childCtx)
    out.push(...prefixIds(baked, `${node.id}#${i}`))
  })
  return out
}

function prefixIds(nodes: FdnNode[], prefix: string): FdnNode[] {
  return nodes.map((n) => ({ ...n, id: `${prefix}::${n.id}`, children: prefixIds(n.children, prefix) }))
}

function bakeSingle(node: FdnNode, ctx: BakeCtx): FdnNode[] {
  if (node.tag === 'fdn-overlay' && 'data-fdn-trigger' in node.attrs && !node.when) {
    pushReport(ctx, {
      code: 'trigger-overlay-skipped',
      severity: 'info',
      message: `overlay "${node.id}" has data-fdn-trigger with no when guard; excluded from this bake`,
      nodeId: node.id,
    })
    return []
  }

  if (node.when) {
    const { value, reports } = evaluateWhen(node.when, ctx, node.id)
    ctx.reports.push(...reports)
    if (!value) return []
  }

  if (node.tag === 'fdn-use') return instantiateComponent(node, ctx)
  if (node.tag === 'fdn-slot') return resolveSlot(node, ctx)
  return [buildRegularNode(node, ctx)]
}

// ——— style / attrs ———

interface ResolvedStyle {
  attrs: Record<string, string>
  style: Record<string, string>
  styleStates: Partial<Record<StateStyleKey, Record<string, string>>>
}

function auditStyleValue(prop: string, value: string, ctx: BakeCtx): void {
  const varRe = /var\(\s*--([A-Za-z0-9_-]+)/g
  let m: RegExpExecArray | null
  let sawVar = false
  while ((m = varRe.exec(value)) !== null) {
    sawVar = true
    ctx.referencedTokens.add(m[1] as string)
  }
  if (sawVar) return
  const trimmed = value.trim()
  if (trimmed === '') return
  const matches = ctx.tokenValueIndex.get(trimmed)
  if (matches && matches.length > 0) {
    pushReport(ctx, {
      code: 'off-token-value',
      severity: 'info',
      message: `value "${value}" for "${prop}" matches token(s) ${matches.join(', ')} — consider var(--${matches[0]})`,
      detail: { prop, value, tokens: matches },
    })
  }
}

function resolveNodeStyle(node: FdnNode, ctx: BakeCtx): ResolvedStyle {
  const attrs: Record<string, string> = {}
  for (const [k, v] of Object.entries(node.attrs)) {
    const { value, reports } = interpolateString(v, ctx, node.id)
    ctx.reports.push(...reports)
    attrs[k] = value
  }

  const namedStyle: FdnNamedStyle | undefined = node.styleRef
    ? ctx.doc.namedStyles.find((s) => s.name === node.styleRef)
    : undefined
  if (node.styleRef && !namedStyle) {
    pushReport(ctx, { code: 'unknown-style-ref', severity: 'warning', message: `named style "${node.styleRef}" is not declared`, nodeId: node.id })
  }

  const mergedRaw: Record<string, string> = { ...(namedStyle?.style ?? {}), ...node.style }
  const style: Record<string, string> = {}
  for (const [prop, raw] of Object.entries(mergedRaw)) {
    const { value, reports } = interpolateString(raw, ctx, node.id)
    ctx.reports.push(...reports)
    style[prop] = value
    auditStyleValue(prop, value, ctx)
  }
  if (node.styleRef) attrs['data-fdn-style'] = node.styleRef

  const styleStates: Partial<Record<StateStyleKey, Record<string, string>>> = {}
  for (const key of STATE_STYLE_KEYS) {
    const base = namedStyle?.styleStates?.[key] ?? {}
    const own = node.styleStates?.[key] ?? {}
    const merged: Record<string, string> = { ...base, ...own }
    const propNames = Object.keys(merged).sort()
    if (propNames.length === 0) continue
    const resolved: Record<string, string> = {}
    const parts: string[] = []
    for (const propName of propNames) {
      const raw = merged[propName] as string
      const { value, reports } = interpolateString(raw, ctx, node.id)
      ctx.reports.push(...reports)
      resolved[propName] = value
      parts.push(`${propName}:${value}`)
      auditStyleValue(propName, value, ctx)
    }
    styleStates[key] = resolved
    attrs[`style-${key}`] = parts.join(';')
  }

  return { attrs, style, styleStates }
}

function buildRegularNode(node: FdnNode, ctx: BakeCtx): FdnNode {
  const { attrs, style, styleStates } = resolveNodeStyle(node, ctx)
  const children = node.children.flatMap((c) => bakeNode(c, ctx))

  let text: string | undefined
  if (node.children.length === 0 && node.text !== undefined) {
    const r = interpolateString(node.text, ctx, node.id)
    ctx.reports.push(...r.reports)
    text = r.value
  }

  return {
    id: node.id,
    tag: node.tag,
    attrs,
    style,
    styleStates,
    text,
    children,
  }
}

// ——— component instantiation ———

function coercePropValue(raw: string, type: FdnParamType, ctx: BakeCtx, nodeId: NodeId): unknown {
  switch (type) {
    case 'string':
    case 'enum':
    case 'token':
      return raw
    case 'boolean':
      return raw === 'true'
    case 'number': {
      const n = Number(raw)
      return Number.isNaN(n) ? raw : n
    }
    case 'list':
    case 'record':
      try {
        return JSON.parse(raw)
      } catch {
        pushReport(ctx, { code: 'invalid-list-prop', severity: 'error', message: `prop value "${raw}" is not valid JSON for a ${type} prop`, nodeId })
        return type === 'list' ? [] : {}
      }
    default:
      return raw
  }
}

function stringifyPropValue(value: unknown, type: FdnParamType): string {
  if (type === 'boolean') return value ? 'true' : 'false'
  if (type === 'list' || type === 'record') {
    try {
      return JSON.stringify(value)
    } catch {
      return '[]'
    }
  }
  return stringifyValue(value)
}

function instantiateComponent(node: FdnNode, ctx: BakeCtx): FdnNode[] {
  const componentName = node.attrs['component']
  if (!componentName) {
    pushReport(ctx, { code: 'component-not-found', severity: 'error', message: 'fdn-use is missing its component="…" attribute', nodeId: node.id })
    return []
  }
  const component: FdnComponent | undefined = ctx.doc.components.find((c) => c.name === componentName)
  if (!component) {
    pushReport(ctx, { code: 'component-not-found', severity: 'error', message: `component "${componentName}" is not declared`, nodeId: node.id })
    return []
  }
  if (ctx.componentStack.includes(componentName)) {
    pushReport(ctx, {
      code: 'component-cycle',
      severity: 'error',
      message: `component "${componentName}" recurses into itself (stack: ${[...ctx.componentStack, componentName].join(' -> ')}); rendering nothing for the inner recurrence`,
      nodeId: node.id,
    })
    return []
  }

  const { attrs: bakedAttrs } = resolveNodeStyle(node, ctx)

  const propsRaw: Record<string, string> = {}
  for (const [k, v] of Object.entries(bakedAttrs)) {
    if (k.startsWith('data-fdn-prop-')) {
      propsRaw[k.slice('data-fdn-prop-'.length)] = v
    }
  }

  const propsTyped: Record<string, unknown> = {}
  const finalAttrs: Record<string, string> = { ...bakedAttrs, component: componentName }
  for (const propDef of component.props) {
    const raw = propsRaw[propDef.name]
    if (raw === undefined) {
      if (propDef.default !== undefined) {
        propsTyped[propDef.name] = propDef.default
      } else {
        propsTyped[propDef.name] = ''
        pushReport(ctx, {
          code: 'prop-missing-default',
          severity: 'warning',
          message: `prop "${propDef.name}" on component "${componentName}" has no bound value and no default; baked empty`,
          nodeId: node.id,
        })
      }
    } else {
      propsTyped[propDef.name] = coercePropValue(raw, propDef.type, ctx, node.id)
    }
    finalAttrs[`data-fdn-prop-${propDef.name}`] = stringifyPropValue(propsTyped[propDef.name], propDef.type)
  }

  const slotFills: Record<string, FdnNode[]> = {}
  for (const child of node.children) {
    if (child.tag === 'fdn-fill') {
      const slotName = child.attrs['slot'] ?? 'default'
      const baked = child.children.flatMap((c) => bakeNode(c, ctx))
      slotFills[slotName] = (slotFills[slotName] ?? []).concat(baked)
    }
  }

  const innerCtx: BakeCtx = {
    ...ctx,
    bindings: { prop: propsTyped, param: ctx.bindings['param'] ?? {} },
    componentStack: [...ctx.componentStack, componentName],
    slotFills,
  }

  const bakedBody = component.body.flatMap((n) => bakeNode(n, innerCtx))
  const namespacedBody = prefixIds(bakedBody, node.id)

  return [
    {
      id: node.id,
      tag: node.tag,
      attrs: finalAttrs,
      style: {},
      styleStates: {},
      text: undefined,
      children: namespacedBody,
    },
  ]
}

function resolveSlot(node: FdnNode, ctx: BakeCtx): FdnNode[] {
  const name = node.attrs['name'] ?? 'default'
  const fill = ctx.slotFills?.[name]
  if (fill && fill.length > 0) return fill
  return node.children.flatMap((c) => bakeNode(c, ctx))
}
