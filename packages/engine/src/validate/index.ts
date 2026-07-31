/**
 * foundation-engine — validate: FdnDocument -> ValidationResult.
 *
 * Corrective error messages are the teaching mechanism (D1): every issue names
 * what's wrong AND the sanctioned alternative, e.g. "float is not in the subset;
 * use flex on the parent" rather than a bare "invalid property".
 */
import {
  excludedStylePropertyMessage,
  FDN_ELEMENTS,
  isExcludedAttr,
  isKnownTag,
  OVERLAY_ELEMENT,
  OVERLAY_ONLY_POSITION_VALUES,
} from '../grammar/schema.js'
import { extractInterpolations, extractLookupRefs, extractRefs, findDisallowedConstructs, parseEachBinding } from '../grammar/expr.js'
import type { FdnComponent, FdnDocument, FdnNamedStyle, FdnNode, ReportLine, ValidationResult } from '../types.js'

interface Scope {
  /** Names legal as a ref root in addition to the fixed `param`/`item` roots:
   *  declared component props (if inComponent) and any bound `each` aliases. */
  props: Set<string> | null
  aliases: Set<string>
}

interface ValidateCtx {
  issues: ReportLine[]
  doc: FdnDocument
  paramNames: Set<string>
  dataNames: Set<string>
  lookupNames: Set<string>
  namedStyleNames: Set<string>
  componentNames: Set<string>
  stateNames: Set<string>
  viewportNames: Set<string>
}

function push(ctx: ValidateCtx, line: ReportLine): void {
  ctx.issues.push(line)
}

// ——————————————————————————————————————————————————————————————————————————
// style declaration checks: exclusions, !important, embedded rules, overlay-only position
// ——————————————————————————————————————————————————————————————————————————

function checkDeclarations(
  ctx: ValidateCtx,
  decls: Record<string, string>,
  opts: { nodeId?: string; allowOverlayPosition: boolean; label: string },
): void {
  for (const [prop, value] of Object.entries(decls)) {
    const excludedMsg = excludedStylePropertyMessage(prop)
    if (excludedMsg) {
      push(ctx, {
        code: 'excluded-style-property',
        severity: 'error',
        message: excludedMsg,
        ...(opts.nodeId ? { nodeId: opts.nodeId } : {}),
        detail: { property: prop, value, on: opts.label },
      })
    }
    if (/!important/i.test(value)) {
      push(ctx, {
        code: 'important-not-allowed',
        severity: 'error',
        message: `"${prop}: ${value}" uses !important — the subset's cascade is local and total, !important is not legal`,
        ...(opts.nodeId ? { nodeId: opts.nodeId } : {}),
        detail: { property: prop, value, on: opts.label },
      })
    }
    // `{{ … }}` interpolation legitimately contains braces — only flag braces
    // OUTSIDE interpolation spans as a possible embedded CSS rule/selector.
    if (/[{}]/.test(value.replace(/\{\{[\s\S]*?\}\}/g, ''))) {
      push(ctx, {
        code: 'embedded-rule-not-allowed',
        severity: 'error',
        message: `"${prop}: ${value}" looks like it embeds a CSS rule/selector — declare a named style instead (no descendant selectors, no specificity games)`,
        ...(opts.nodeId ? { nodeId: opts.nodeId } : {}),
        detail: { property: prop, value, on: opts.label },
      })
    }
    if (prop === 'position' && OVERLAY_ONLY_POSITION_VALUES.includes(value.trim())) {
      if (!opts.allowOverlayPosition) {
        push(ctx, {
          code: 'position-outside-overlay',
          severity: 'error',
          message: `position:${value.trim()} is only legal inside <fdn-overlay> — wrap this content in fdn-overlay, or use flex/grid layout instead`,
          ...(opts.nodeId ? { nodeId: opts.nodeId } : {}),
          detail: { property: prop, value, on: opts.label },
        })
      }
    }
  }
}

// ——————————————————————————————————————————————————————————————————————————
// reference checks (styleRef, when/each, interpolations, lookups)
// ——————————————————————————————————————————————————————————————————————————

function refRootLegal(ctx: ValidateCtx, root: string, scope: Scope): boolean {
  if (root === 'param' || root === 'item') return true
  if (root === 'prop') return scope.props !== null
  if (scope.aliases.has(root)) return true
  return false
}

function checkRef(ctx: ValidateCtx, root: string, path: string[], scope: Scope, nodeId: string | undefined, source: string): void {
  if (!refRootLegal(ctx, root, scope)) {
    push(ctx, {
      code: 'undeclared-ref-root',
      severity: 'error',
      message: `"${root}.${path.join('.')}" is not a legal reference root here — expected param./item./prop. (inside a component) or a bound each-loop alias`,
      ...(nodeId ? { nodeId } : {}),
      detail: { root, path, source },
    })
    return
  }
  const field = path[0]
  if (root === 'param' && field && !ctx.paramNames.has(field)) {
    push(ctx, {
      code: 'undeclared-ref',
      severity: 'error',
      message: `param.${field} is not a declared param`,
      ...(nodeId ? { nodeId } : {}),
      detail: { root, path, source },
    })
  }
  if (root === 'prop' && field && scope.props && !scope.props.has(field)) {
    push(ctx, {
      code: 'undeclared-ref',
      severity: 'error',
      message: `prop.${field} is not a declared prop on this component`,
      ...(nodeId ? { nodeId } : {}),
      detail: { root, path, source },
    })
  }
}

function checkExpr(ctx: ValidateCtx, expr: string, scope: Scope, nodeId: string | undefined, label: string): void {
  for (const construct of findDisallowedConstructs(expr)) {
    push(ctx, {
      code: 'expression-not-in-subset',
      severity: 'error',
      message: `"${expr}" uses a ${construct} — the expression grammar admits only refs, one ternary, comparisons, and lookup refs (no arithmetic, no method calls, no string operations)`,
      ...(nodeId ? { nodeId } : {}),
      detail: { expr, label },
    })
  }
  for (const lref of extractLookupRefs(expr)) {
    if (!ctx.lookupNames.has(lref.lookupName)) {
      push(ctx, {
        code: 'undeclared-ref',
        severity: 'error',
        message: `"${lref.lookupName}[…]" references an undeclared lookup table`,
        ...(nodeId ? { nodeId } : {}),
        detail: { lookupName: lref.lookupName, label },
      })
    }
    checkRef(ctx, lref.ref.root, lref.ref.path, scope, nodeId, expr)
  }
  // top-level refs, minus refs already covered as the inner ref of a lookup[...]
  const lookupInnerIndices = new Set(extractLookupRefs(expr).map((l) => l.ref.index))
  for (const ref of extractRefs(expr)) {
    if (lookupInnerIndices.has(ref.index)) continue
    checkRef(ctx, ref.root, ref.path, scope, nodeId, expr)
  }
}

/**
 * `each="<alias> in <source>"` — the source half is NOT a `{{ … }}` expression
 * and is not covered by the `ref` production in types.ts's expression-grammar
 * comment (that EBNF's roots are prop/item/param/alias; it has no provision for
 * naming a *declared data set*, which is what real `each` sources actually need
 * — see boards/*.fdn.html's `each="item in data.inboxItems"`). CONTRACT FINDING:
 * `data.<name>` is the sanctioned each-source shape in practice; this checker
 * validates it as its own small grammar rather than forcing it through
 * `checkRef`, which would (incorrectly) reject `data` as an unknown ref root.
 */
function checkEachSource(ctx: ValidateCtx, source: string, scope: Scope, nodeId: string | undefined): void {
  const trimmed = source.trim()
  for (const construct of findDisallowedConstructs(trimmed)) {
    push(ctx, {
      code: 'expression-not-in-subset',
      severity: 'error',
      message: `each source "${trimmed}" uses a ${construct} — iterate a declared data set (data.<name>) or a list-typed prop (prop.<name>) directly, no operations`,
      ...(nodeId ? { nodeId } : {}),
      detail: { source: trimmed },
    })
  }
  const dataMatch = /^data\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(trimmed)
  if (dataMatch) {
    const setName = dataMatch[1]
    if (setName && !ctx.dataNames.has(setName)) {
      push(ctx, {
        code: 'undeclared-ref',
        severity: 'error',
        message: `data.${setName} is not a declared data set`,
        ...(nodeId ? { nodeId } : {}),
        detail: { dataSet: setName },
      })
    }
    return
  }
  const propMatch = /^prop\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(trimmed)
  if (propMatch) {
    const propName = propMatch[1]
    if (!scope.props) {
      push(ctx, {
        code: 'undeclared-ref-root',
        severity: 'error',
        message: `each source "${trimmed}" uses prop.* outside a component body`,
        ...(nodeId ? { nodeId } : {}),
        detail: { source: trimmed },
      })
    } else if (propName && !scope.props.has(propName)) {
      push(ctx, {
        code: 'undeclared-ref',
        severity: 'error',
        message: `prop.${propName} is not a declared prop on this component`,
        ...(nodeId ? { nodeId } : {}),
        detail: { source: trimmed },
      })
    }
    return
  }
  if (trimmed) {
    push(ctx, {
      code: 'undeclared-ref-root',
      severity: 'error',
      message: `each source "${trimmed}" must reference a declared data set (data.<name>) or a component prop (prop.<name>)`,
      ...(nodeId ? { nodeId } : {}),
      detail: { source: trimmed },
    })
  }
}

// ——————————————————————————————————————————————————————————————————————————
// node walk
// ——————————————————————————————————————————————————————————————————————————

function walkNode(ctx: ValidateCtx, node: FdnNode, scope: Scope, inOverlay: boolean): void {
  if (!isKnownTag(node.tag)) {
    push(ctx, {
      code: 'unknown-element',
      severity: 'error',
      message: `<${node.tag}> is neither an HTML5 element nor a declared fdn-* element`,
      nodeId: node.id,
      detail: { tag: node.tag },
    })
  }

  const rule = FDN_ELEMENTS[node.tag]
  if (rule?.requiredAttrs) {
    for (const req of rule.requiredAttrs) {
      if (!node.attrs[req]) {
        push(ctx, {
          code: 'missing-required-attribute',
          severity: 'error',
          message: `<${node.tag}> requires "${req}"`,
          nodeId: node.id,
          detail: { tag: node.tag, attribute: req },
        })
      }
    }
  }

  for (const key of Object.keys(node.attrs)) {
    if (isExcludedAttr(key)) {
      push(ctx, {
        code: 'excluded-attribute',
        severity: 'error',
        message: `attribute "${key}" is not in the subset (event-handler / live-media-behavior exclusion)`,
        nodeId: node.id,
        detail: { attribute: key },
      })
    }
  }

  if (node.text !== undefined && node.text.trim() !== '' && node.children.length > 0) {
    push(ctx, {
      code: 'text-children-conflict',
      severity: 'error',
      message: 'node has both text content and element children — children win at bake time; remove one',
      nodeId: node.id,
    })
  }

  if (node.styleRef !== undefined && !ctx.namedStyleNames.has(node.styleRef)) {
    push(ctx, {
      code: 'undeclared-ref',
      severity: 'error',
      message: `data-fdn-style="${node.styleRef}" references an undeclared named style`,
      nodeId: node.id,
      detail: { styleRef: node.styleRef },
    })
  }

  if (node.tag === 'fdn-use' && node.attrs.component && !ctx.componentNames.has(node.attrs.component)) {
    push(ctx, {
      code: 'undeclared-ref',
      severity: 'error',
      message: `component="${node.attrs.component}" references an undeclared component`,
      nodeId: node.id,
      detail: { component: node.attrs.component },
    })
  }

  const stateAttr = node.attrs['data-fdn-state']
  if (stateAttr !== undefined && !ctx.stateNames.has(stateAttr)) {
    push(ctx, {
      code: 'undeclared-ref',
      severity: 'warning',
      message: `data-fdn-state="${stateAttr}" references an undeclared state`,
      nodeId: node.id,
      detail: { state: stateAttr },
    })
  }
  const viewportAttr = node.attrs['data-fdn-viewport']
  if (viewportAttr !== undefined && !ctx.viewportNames.has(viewportAttr)) {
    push(ctx, {
      code: 'undeclared-ref',
      severity: 'warning',
      message: `data-fdn-viewport="${viewportAttr}" references an undeclared viewport`,
      nodeId: node.id,
      detail: { viewport: viewportAttr },
    })
  }

  const overlayHere = node.tag === OVERLAY_ELEMENT || inOverlay
  checkDeclarations(ctx, node.style, { nodeId: node.id, allowOverlayPosition: overlayHere, label: 'style' })
  for (const decls of Object.values(node.styleStates)) {
    if (decls) checkDeclarations(ctx, decls, { nodeId: node.id, allowOverlayPosition: overlayHere, label: 'styleState' })
  }

  // scope for THIS node's own each/when/attrs/text: include its own each alias.
  let ownScope = scope
  if (node.each !== undefined) {
    const binding = parseEachBinding(node.each)
    if (!binding) {
      push(ctx, {
        code: 'malformed-each-binding',
        severity: 'error',
        message: `each="${node.each}" is not of the form "<alias> in <ref>"`,
        nodeId: node.id,
      })
    } else {
      checkEachSource(ctx, binding.source, scope, node.id)
      ownScope = { props: scope.props, aliases: new Set([...scope.aliases, binding.alias]) }
    }
  }

  if (node.when !== undefined) checkExpr(ctx, node.when, ownScope, node.id, 'when')

  const bindAttr = node.attrs['data-fdn-bind']
  if (bindAttr !== undefined) checkExpr(ctx, bindAttr, ownScope, node.id, 'data-fdn-bind')

  for (const [attrName, attrValue] of Object.entries(node.attrs)) {
    for (const expr of extractInterpolations(attrValue)) checkExpr(ctx, expr, ownScope, node.id, `attr:${attrName}`)
  }
  if (node.text !== undefined) {
    for (const expr of extractInterpolations(node.text)) checkExpr(ctx, expr, ownScope, node.id, 'text')
  }

  for (const child of node.children) walkNode(ctx, child, ownScope, overlayHere)
}

function walkComponent(ctx: ValidateCtx, component: FdnComponent): void {
  const scope: Scope = { props: new Set(component.props.map((p) => p.name)), aliases: new Set() }
  for (const node of component.body) walkNode(ctx, node, scope, false)
}

function checkNamedStyle(ctx: ValidateCtx, style: FdnNamedStyle): void {
  checkDeclarations(ctx, style.style, { allowOverlayPosition: false, label: `fdn-style:${style.name}` })
  for (const decls of Object.values(style.styleStates)) {
    if (decls) checkDeclarations(ctx, decls, { allowOverlayPosition: false, label: `fdn-style:${style.name}` })
  }
}

// ——————————————————————————————————————————————————————————————————————————
// entry point
// ——————————————————————————————————————————————————————————————————————————

export function validateDocument(doc: FdnDocument): ValidationResult {
  const ctx: ValidateCtx = {
    issues: [],
    doc,
    paramNames: new Set(doc.params.map((p) => p.name)),
    dataNames: new Set(doc.data.map((d) => d.name)),
    lookupNames: new Set(doc.lookups.map((l) => l.name)),
    namedStyleNames: new Set(doc.namedStyles.map((s) => s.name)),
    componentNames: new Set(doc.components.map((c) => c.name)),
    stateNames: new Set(doc.states.map((s) => s.name)),
    viewportNames: new Set(doc.viewports.map((v) => v.name)),
  }

  for (const state of doc.states) {
    for (const key of Object.keys(state.assignments)) {
      if (!ctx.paramNames.has(key)) {
        push(ctx, {
          code: 'undeclared-ref',
          severity: 'error',
          message: `state "${state.name}" assigns undeclared param "${key}"`,
          detail: { state: state.name, param: key },
        })
      }
    }
    if (state.viewport !== undefined && !ctx.viewportNames.has(state.viewport)) {
      push(ctx, {
        code: 'undeclared-ref',
        severity: 'error',
        message: `state "${state.name}" references undeclared viewport "${state.viewport}"`,
        detail: { state: state.name, viewport: state.viewport },
      })
    }
  }

  for (const cell of doc.matrix) {
    if (!ctx.stateNames.has(cell.state)) {
      push(ctx, {
        code: 'undeclared-ref',
        severity: 'error',
        message: `matrix cell references undeclared state "${cell.state}"`,
        detail: { state: cell.state },
      })
    }
    if (!ctx.viewportNames.has(cell.viewport)) {
      push(ctx, {
        code: 'undeclared-ref',
        severity: 'error',
        message: `matrix cell references undeclared viewport "${cell.viewport}"`,
        detail: { viewport: cell.viewport },
      })
    }
  }

  for (const style of doc.namedStyles) checkNamedStyle(ctx, style)
  for (const component of doc.components) walkComponent(ctx, component)

  const topScope: Scope = { props: null, aliases: new Set() }
  for (const node of doc.body) walkNode(ctx, node, topScope, false)

  const valid = !ctx.issues.some((i) => i.severity === 'error')
  return { valid, issues: ctx.issues }
}
