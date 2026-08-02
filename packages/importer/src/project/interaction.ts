/**
 * Interaction check (API.md "Composed-variant check"): for each pairwise
 * probe sample (two props varied together), verify that the NATIVE component
 * we just folded — baked with both prop values bound simultaneously —
 * reproduces the probe's actual rendered output. A mismatch means the two
 * props interact in a way single-prop folding cannot represent -> the whole
 * component must go sealed instead (API.md: "structural prop interactions,
 * unrepresentable CSS" are the only reasons transparent-first backs off).
 *
 * Implementation choice: rather than re-implementing template evaluation,
 * this bakes a throwaway one-component FdnDocument through
 * foundation-engine's REAL `bakeDocument` and diffs the resulting tree
 * against the probe's parsed tree — reusing the actual evaluator instead of
 * a second, possibly-diverging one.
 */
import { bakeDocument, type FdnComponent, type FdnDocument, type FdnLookup } from 'foundation-engine'
import { stringifyValue } from 'foundation-engine/src/bake/expr.js'
import { parseSampleHtml } from './html.js'
import { resolveClassesInTree } from './style.js'
import { structurallyEqual } from './tree.js'
import type { ClassIndex, RenderSample } from '../types.js'

/**
 * See types.ts's module-doc CONTRACT FINDING: neither delimiter is actually
 * written down in API.md. Stage 1 (the field's real producer) emits
 * "<a>+<b>" (plus-joined) — matched first; ","-joined is kept as a
 * defensive fallback for this module's own originally-guessed convention,
 * in case either side changes again before integration settles.
 */
export function pairwiseProps(sample: RenderSample): [string, string] | undefined {
  const v = sample.varied
  if (!v) return undefined
  const delimiter = v.includes('+') ? '+' : v.includes(',') ? ',' : undefined
  if (!delimiter) return undefined
  const parts = v.split(delimiter).map((s) => s.trim()).filter(Boolean)
  if (parts.length !== 2) return undefined
  return [parts[0] as string, parts[1] as string]
}

function buildTempDoc(component: FdnComponent, lookups: FdnLookup[], propValues: Record<string, unknown>): FdnDocument {
  const attrs: Record<string, string> = { component: component.name }
  for (const prop of component.props) {
    const value = Object.prototype.hasOwnProperty.call(propValues, prop.name) ? propValues[prop.name] : prop.default
    if (value === undefined) continue
    attrs[`data-fdn-prop-${prop.name}`] = stringifyValue(value)
  }
  return {
    specVersion: '0.0.1-draft',
    tokens: {},
    params: [],
    data: [],
    lookups,
    states: [],
    viewports: [],
    matrix: [],
    namedStyles: [],
    components: [component],
    body: [{ id: 'probe', tag: 'fdn-use', attrs, style: {}, styleStates: {}, children: [] }],
  }
}

export interface InteractionMismatch {
  propA: string
  propB: string
  detail: unknown
}

/**
 * Check every pairwise probe sample against the folded component. Returns
 * the mismatches found (empty = interaction check passed, native holds).
 */
export function checkInteractions(
  component: FdnComponent,
  lookups: FdnLookup[],
  probes: RenderSample[],
  classIndex: ClassIndex,
): InteractionMismatch[] {
  const mismatches: InteractionMismatch[] = []
  for (const probe of probes) {
    const pair = pairwiseProps(probe)
    if (!pair) continue
    const tempDoc = buildTempDoc(component, lookups, probe.props)
    const baked = bakeDocument(tempDoc)
    const bakedChildren = baked.tree[0]?.children ?? []
    // The baked side is fully class-resolved (Tailwind classes -> inline
    // style, `class` consumed) — the probe's RAW html still carries its
    // literal `class="…"` attribute. Without resolving it the same way here,
    // every single comparison would mismatch on that attribute alone,
    // regardless of whether the two props actually interact. Caught by this
    // module's own test suite before it ever reached a real fixture.
    const probeTree = parseSampleHtml(probe.html)
    resolveClassesInTree(probeTree, classIndex, () => {
      // dropped/unsupported classes on a probe only reduce comparison
      // precision (a field that can't be resolved just won't be compared
      // meaningfully) — not reported a second time here.
    })
    if (!structurallyEqual(bakedChildren, probeTree)) {
      mismatches.push({
        propA: pair[0],
        propB: pair[1],
        detail: { probeProps: probe.props },
      })
    }
  }
  return mismatches
}
