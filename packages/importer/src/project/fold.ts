/**
 * Variant folding (API.md projection rules): compares the (sentinel-
 * substituted, class-resolved) baseline tree against each single-prop-variant
 * sample's tree and folds the observed differences into the baseline —
 * `when=` for structural (node presence) differences, `{{ … ? … : … }}`
 * ternary or a generated `fdn-lookup` for attribute/style/text VALUE
 * differences (boolean or 2-value enum -> ternary; 3+-value enum -> lookup).
 *
 * SCOPE CUT (documented, not silent): this module folds structural presence
 * only in the direction "a node the BASELINE has disappears for some other
 * prop value" (case A — by far the common shape: an icon/badge/decoration
 * shown by default that some variant suppresses). The mirror case — a node
 * that does NOT appear in the baseline but DOES appear for some other prop
 * value (a spinner that only shows up when loading=true, say) — is detected
 * but NOT synthesized into the tree in v1: safely splicing a new subtree
 * into an accumulating tree while multiple props fold independently (without
 * risking index drift / cross-prop corruption) is materially harder than the
 * rest of this module and didn't fit the time budget; it is reported via
 * `import-variant-branch` with `resolved: false` in `detail` rather than
 * silently dropped, and if a real fixture needs it, --sealed remains the
 * escape hatch. This is the single biggest simplification in this
 * implementation — flagged prominently in the final report, not buried here.
 */
import type { FdnLookup, FdnNode, FdnProp, ReportLine, StateStyleKey } from 'foundation-engine'
import { alignSiblings, type NodePath, pathKey } from './tree.js'

const STATE_KEYS: readonly StateStyleKey[] = ['hover', 'focus', 'active', 'disabled']

interface Arm {
  value: unknown
  tree: FdnNode[]
}

function stringifyDomainValue(v: unknown): string {
  return typeof v === 'boolean' ? (v ? 'true' : 'false') : String(v)
}

/** One prop-comparable value literal for use inside `{{ … }}` / `when=`. */
function valueLiteral(v: unknown, propType: FdnProp['type']): string {
  if (propType === 'boolean') return v ? 'true' : 'false'
  return `'${String(v).replace(/'/g, "\\'")}'`
}

/** Build one equality/inequality condition for a single domain value.
 *  `assertEqual: true` -> "prop is this value"; `false` -> "prop is NOT this
 *  value" (the negated form callers AND together for a shorter `when=`). */
function condFor(propName: string, propType: FdnProp['type'], value: unknown, assertEqual: boolean): string {
  if (propType === 'boolean') {
    const truthy = value === true
    const positive = truthy ? `prop.${propName}` : `!prop.${propName}`
    const negative = truthy ? `!prop.${propName}` : `prop.${propName}`
    return assertEqual ? positive : negative
  }
  return `prop.${propName} ${assertEqual ? '==' : '!='} ${valueLiteral(value, propType)}`
}

// ——— recursive alignment against a fixed reference tree ———

interface AlignResult {
  /** ref-tree paths (keyed) with no counterpart in the variant tree. */
  absent: Set<string>
  /** ref-tree paths -> the variant's matched counterpart node. */
  matched: Map<string, FdnNode>
}

function alignAgainstRef(ref: FdnNode[], variant: FdnNode[], path: NodePath, out: AlignResult): void {
  const { matched, onlyA } = alignSiblings(ref, variant)
  for (const { index } of onlyA) {
    out.absent.add(pathKey([...path, index]))
  }
  for (const { a, b, aIndex } of matched) {
    const p = [...path, aIndex]
    out.matched.set(pathKey(p), b)
    alignAgainstRef(a.children, b.children, p, out)
  }
}

// ——— per-prop arm collection ———

function collectArms(prop: FdnProp, baselineProps: Record<string, unknown>, refTree: FdnNode[], variantsForProp: { value: unknown; tree: FdnNode[] }[]): Arm[] {
  const byValue = new Map<string, Arm>()
  byValue.set(stringifyDomainValue(baselineProps[prop.name]), { value: baselineProps[prop.name], tree: refTree })
  for (const v of variantsForProp) {
    byValue.set(stringifyDomainValue(v.value), { value: v.value, tree: v.tree })
  }
  return [...byValue.values()]
}

/**
 * CONTRACT FINDING: `FdnProp` (types.ts) has no `values` field — only
 * `FdnParam` does. There is no schema-declared enum domain to read for a
 * component prop, so this module never reads `prop.values` at all; the enum
 * domain is derived empirically from the sampled arms themselves (baseline's
 * own value + every `varied === prop.name` sample's value) — which the
 * contract's own promise ("every enum value" gets a sample) makes exact
 * anyway. Ternary-vs-lookup arity (2 vs 3+) is decided from `arms.length`
 * in foldValues, not from a schema field.
 */
function isFoldable(prop: FdnProp): boolean {
  return prop.type === 'boolean' || prop.type === 'enum'
}

function fieldValue(node: FdnNode, field: FieldRef): string | undefined {
  if (field.kind === 'attr') return node.attrs[field.key]
  if (field.kind === 'text') return node.text
  if (field.kind === 'style') return node.style[field.key]
  return node.styleStates[field.state]?.[field.key]
}

function setFieldValue(node: FdnNode, field: FieldRef, value: string): void {
  if (field.kind === 'attr') node.attrs[field.key] = value
  else if (field.kind === 'text') node.text = value
  else if (field.kind === 'style') node.style[field.key] = value
  else node.styleStates[field.state] = { ...(node.styleStates[field.state] ?? {}), [field.key]: value }
}

type FieldRef =
  | { kind: 'attr'; key: string }
  | { kind: 'text' }
  | { kind: 'style'; key: string }
  | { kind: 'stateStyle'; state: StateStyleKey; key: string }

function fieldsOf(node: FdnNode): FieldRef[] {
  const out: FieldRef[] = []
  for (const key of Object.keys(node.attrs).sort()) out.push({ kind: 'attr', key })
  if (node.text !== undefined) out.push({ kind: 'text' })
  for (const key of Object.keys(node.style).sort()) out.push({ kind: 'style', key })
  for (const state of STATE_KEYS) {
    for (const key of Object.keys(node.styleStates[state] ?? {}).sort()) out.push({ kind: 'stateStyle', state, key })
  }
  return out
}

function fieldLabel(field: FieldRef): string {
  if (field.kind === 'attr') return `attr:${field.key}`
  if (field.kind === 'text') return 'text'
  if (field.kind === 'style') return `style:${field.key}`
  return `style-${field.state}:${field.key}`
}

export interface FoldContext {
  componentName: string
  report: (line: ReportLine) => void
  extraLookups: FdnLookup[]
  /** Per-call counter (NOT module-level — a module-level counter would keep
   *  incrementing across separate projectArtifact() calls in the same
   *  process, so the SAME artifact projected twice would mint DIFFERENT
   *  lookup names the second time, breaking the "repeated projection is
   *  byte-identical" determinism contract. Caught by this module's own
   *  determinism test. Starts fresh at 0 for every projectArtifact() call —
   *  see project/index.ts, which constructs one FoldContext per call. */
  lookupCounter: { n: number }
}

function sanitizeIdent(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9_]/g, '_')
  return /^[A-Za-z_]/.test(cleaned) ? cleaned : `_${cleaned}`
}

function nextLookupName(ctx: FoldContext): string {
  ctx.lookupCounter.n += 1
  return `${sanitizeIdent(ctx.componentName)}Lookup${ctx.lookupCounter.n}`
}

/**
 * Fold every single-prop-variant sample's differences (already parsed to
 * FdnNode[] trees, sentinels substituted only where the harness applies them
 * — never here — and classes resolved) into `workingTree`, IN PLACE.
 * `refTree` is the untouched (structurally stable) baseline reference every
 * arm is compared against — see module doc for why it must never be mutated
 * mid-fold (keeps every prop's comparison independent and conflict-free).
 */
export function foldVariants(
  workingTree: FdnNode[],
  refTree: FdnNode[],
  baselineProps: Record<string, unknown>,
  propSchema: FdnProp[],
  variantsByProp: Map<string, { value: unknown; tree: FdnNode[] }[]>,
  ctx: FoldContext,
): void {
  for (const prop of propSchema) {
    if (!isFoldable(prop)) continue
    const variants = variantsByProp.get(prop.name)
    if (!variants || variants.length === 0) continue

    const arms = collectArms(prop, baselineProps, refTree, variants)
    if (arms.length < 2) continue

    // One alignment per non-reference arm, all against the SAME refTree.
    const alignments: { arm: Arm; result: AlignResult }[] = []
    for (const arm of arms) {
      if (arm.tree === refTree) continue
      const result: AlignResult = { absent: new Set(), matched: new Map() }
      alignAgainstRef(refTree, arm.tree, [], result)
      alignments.push({ arm, result })
    }

    foldStructural(workingTree, refTree, prop, arms, alignments, ctx)
    foldValues(workingTree, refTree, prop, arms, alignments, ctx)
  }
}

function walkPath(roots: FdnNode[], path: NodePath): FdnNode | undefined {
  let cur = roots
  let node: FdnNode | undefined
  for (const i of path) {
    node = cur[i]
    if (!node) return undefined
    cur = node.children
  }
  return node
}

function collectAllPaths(nodes: FdnNode[], path: NodePath, out: Map<string, NodePath>): void {
  nodes.forEach((n, i) => {
    const p = [...path, i]
    out.set(pathKey(p), p)
    collectAllPaths(n.children, p, out)
  })
}

function foldStructural(
  workingTree: FdnNode[],
  refTree: FdnNode[],
  prop: FdnProp,
  arms: Arm[],
  alignments: { arm: Arm; result: AlignResult }[],
  ctx: FoldContext,
): void {
  const refPaths = new Map<string, NodePath>()
  collectAllPaths(refTree, [], refPaths)

  let foldedAny = false
  let unresolvedAny = false

  for (const [key, path] of refPaths) {
    const absentValues: unknown[] = []
    const presentValues: unknown[] = []
    for (const { arm, result } of alignments) {
      if (result.absent.has(key)) absentValues.push(arm.value)
      else presentValues.push(arm.value)
    }
    if (absentValues.length === 0) continue // present in every arm — nothing to fold here

    const refValue = arms.find((a) => a.tree === refTree)?.value
    const positiveSet = [refValue, ...presentValues]
    // prefer whichever expresses fewer terms: "is one of the present values"
    // (OR of equalities) vs "is none of the absent values" (AND of inequalities).
    const useNegative = absentValues.length < positiveSet.length
    const expr = useNegative
      ? absentValues.map((v) => condFor(prop.name, prop.type, v, false)).join(' && ')
      : positiveSet.map((v) => condFor(prop.name, prop.type, v, true)).join(' || ')

    const node = walkPath(workingTree, path)
    if (!node) continue
    node.when = node.when ? `(${node.when}) && (${expr})` : expr
    foldedAny = true
  }

  // case-B detection (documented scope cut): variant-only nodes with no ref
  // counterpart. Reported, not synthesized — see module doc.
  for (const { arm, result } of alignments) {
    const variantPaths = new Map<string, NodePath>()
    collectAllPaths(arm.tree, [], variantPaths)
    for (const key of variantPaths.keys()) {
      if (!result.matched.has(key) && !refPaths.has(key)) {
        unresolvedAny = true
        break
      }
    }
    if (unresolvedAny) break
  }

  if (foldedAny) {
    ctx.report({
      code: 'import-variant-branch',
      severity: 'info',
      message: `prop "${prop.name}" gates node presence via when= (structural difference across its sampled values)`,
      detail: { prop: prop.name },
    })
  }
  if (unresolvedAny) {
    ctx.report({
      code: 'import-variant-branch',
      severity: 'warning',
      message: `prop "${prop.name}" introduces content in at least one sampled variant that the baseline does not have; v1 folding does not synthesize new nodes — that content is not represented natively (use --sealed if this loses meaningful fidelity)`,
      detail: { prop: prop.name, resolved: false },
    })
  }
}

function foldValues(
  workingTree: FdnNode[],
  refTree: FdnNode[],
  prop: FdnProp,
  arms: Arm[],
  alignments: { arm: Arm; result: AlignResult }[],
  ctx: FoldContext,
): void {
  const refPaths = new Map<string, NodePath>()
  collectAllPaths(refTree, [], refPaths)

  for (const [key, path] of refPaths) {
    // only fold values at positions present in EVERY arm (structurally stable)
    if (alignments.some(({ result }) => result.absent.has(key))) continue

    const refNode = walkPath(refTree, path)
    if (!refNode) continue

    for (const field of fieldsOf(refNode)) {
      const refFieldValue = fieldValue(refNode, field)
      if (refFieldValue === undefined) continue
      if (refFieldValue.includes('{{')) continue // already explained by sentinel substitution

      const outputs = new Map<string, string>() // stringified domain value -> field output
      const refArm = arms.find((a) => a.tree === refTree)
      if (refArm) outputs.set(stringifyDomainValue(refArm.value), refFieldValue)
      for (const { arm, result } of alignments) {
        const counterpart = result.matched.get(key)
        if (!counterpart) continue
        const v = fieldValue(counterpart, field)
        if (v !== undefined) outputs.set(stringifyDomainValue(arm.value), v)
      }

      const distinctOutputs = new Set(outputs.values())
      if (distinctOutputs.size < 2) continue // no real variation for this field

      const workingNode = walkPath(workingTree, path)
      if (!workingNode) continue

      if (prop.type === 'boolean') {
        const trueOut = outputs.get('true')
        const falseOut = outputs.get('false')
        if (trueOut === undefined || falseOut === undefined) continue
        const expr = `{{ prop.${prop.name} ? '${escLit(trueOut)}' : '${escLit(falseOut)}' }}`
        setFieldValue(workingNode, field, expr)
        ctx.report(ternaryReport(prop, field, path))
        continue
      }

      // enum domain (see the CONTRACT FINDING at isFoldable): derived from the
      // observed arms themselves, in arm order (ref/baseline first, then each
      // sampled variant in encounter order) — never from a schema field.
      if (arms.length === 2) {
        const v0 = arms[0] as Arm
        const v1 = arms[1] as Arm
        const a = outputs.get(stringifyDomainValue(v0.value))
        const b = outputs.get(stringifyDomainValue(v1.value))
        if (a === undefined || b === undefined) continue
        const expr = `{{ prop.${prop.name} == '${escLit(String(v0.value))}' ? '${escLit(a)}' : '${escLit(b)}' }}`
        setFieldValue(workingNode, field, expr)
        ctx.report(ternaryReport(prop, field, path))
        continue
      }

      // 3+ enum values -> a generated lookup table
      const entries: Record<string, string> = {}
      for (const arm of arms) {
        const out = outputs.get(stringifyDomainValue(arm.value))
        if (out !== undefined) entries[String(arm.value)] = out
      }
      if (Object.keys(entries).length === 0) continue
      const lookupName = nextLookupName(ctx)
      ctx.extraLookups.push({ name: lookupName, entries })
      const expr = `{{ ${lookupName}[prop.${prop.name}] }}`
      setFieldValue(workingNode, field, expr)
      ctx.report(ternaryReport(prop, field, path, lookupName))
    }
  }
}

function escLit(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

function ternaryReport(prop: FdnProp, field: FieldRef, path: NodePath, lookupName?: string): ReportLine {
  return {
    code: 'import-attr-ternary',
    severity: 'info',
    message: lookupName
      ? `prop "${prop.name}" (${field.kind === 'attr' ? 'attr' : 'style'} ${fieldLabel(field)}) folded into generated lookup "${lookupName}"`
      : `prop "${prop.name}" (${fieldLabel(field)}) folded into a ternary`,
    detail: { prop: prop.name, field: fieldLabel(field), path: pathKey(path), lookup: lookupName },
  }
}
