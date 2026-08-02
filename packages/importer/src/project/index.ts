/**
 * Stage 2 — projection (API.md "Wave 4 — component importer").
 *
 *   projectArtifact(artifact: RenderArtifact): {
 *     component: FdnComponent
 *     mode: 'native' | 'sealed'
 *     report: ReportLine[]
 *   }
 *
 * CONTRACT FINDINGS (widened beyond the literal API.md signature — both
 * additive, neither breaks the three documented fields):
 *
 *   1. `extraLookups: FdnLookup[]` — FdnComponent has no `lookups` field
 *      (lookups are document-level, `FdnDocument.lookups`). The projection
 *      rules require generating an `fdn-lookup` for 3+-value enum folds, so
 *      the result needed a place to carry them. Returned as a sibling field;
 *      the CLI's `foundation import` must merge these into the target
 *      document's `lookups` (deduping by name) when committing — this module
 *      cannot do that itself (no document to merge into at this stage).
 *   2. `opts?: { forceSealed?: boolean }` — the CLI's `--sealed` flag (API.md
 *      CLI section) needs a way to force capsule mode; the fixed signature
 *      shows no second parameter. Added as an optional argument (never
 *      required, so every literal-signature call site still compiles).
 *
 * See fold.ts's module doc for the one deliberate SCOPE CUT in the
 * projection algorithm (structural folding only adds `when=` to nodes the
 * baseline already has — it does not synthesize brand-new nodes for a
 * variant-only structural difference).
 */
import type { FdnComponent, FdnLookup, FdnNode, ReportLine } from 'foundation-engine'
import type { RenderArtifact } from '../types.js'
import { parseSampleHtml } from './html.js'
import { substituteSentinels } from './sentinel.js'
import { resolveClassesInTree } from './style.js'
import { cloneTree } from './tree.js'
import { foldVariants } from './fold.js'
import { checkInteractions, pairwiseProps } from './interaction.js'
import { buildSealedComponent } from './sealed.js'

export interface ProjectOptions {
  forceSealed?: boolean
}

export interface ProjectResult {
  component: FdnComponent
  mode: 'native' | 'sealed'
  report: ReportLine[]
  extraLookups: FdnLookup[]
}

export function projectArtifact(artifact: RenderArtifact, opts?: ProjectOptions): ProjectResult {
  const report: ReportLine[] = []
  const push = (line: ReportLine): void => {
    report.push(line)
  }

  if (opts?.forceSealed) {
    const component = buildSealedComponent(artifact, artifact.classIndex, 'forced by --sealed', push)
    return { component, mode: 'sealed', report, extraLookups: [] }
  }

  const baseline = artifact.samples[0]
  if (!baseline) {
    const component = buildSealedComponent(artifact, artifact.classIndex, 'no samples in artifact', push)
    return { component, mode: 'sealed', report, extraLookups: [] }
  }

  const refTree = parseSampleHtml(baseline.html)
  substituteSentinels(refTree).forEach(push)

  let baselineUnprojectableCss = false
  resolveClassesInTree(refTree, artifact.classIndex, (line) => {
    if (line.code === 'import-unprojectable-css') baselineUnprojectableCss = true
    push(line)
  })

  if (baselineUnprojectableCss) {
    const component = buildSealedComponent(artifact, artifact.classIndex, 'baseline uses an unresolvable class', push)
    return { component, mode: 'sealed', report, extraLookups: [] }
  }

  // group non-baseline samples: single-prop variants vs pairwise probes
  const variantsByProp = new Map<string, { value: unknown; tree: FdnNode[] }[]>()
  const probes: typeof artifact.samples = []
  for (const sample of artifact.samples) {
    if (sample === baseline) continue
    if (pairwiseProps(sample)) {
      probes.push(sample)
      continue
    }
    if (!sample.varied) continue
    const tree = parseSampleHtml(sample.html)
    resolveClassesInTree(tree, artifact.classIndex, () => {
      // unsupported/unprojectable classes on a VARIANT sample only degrade
      // that one arm's fold precision (handled gracefully in fold.ts via
      // missing-output guards) — not reported a second time here to avoid
      // duplicate noise; the baseline pass above is the fidelity gate.
    })
    const list = variantsByProp.get(sample.varied) ?? []
    list.push({ value: sample.props[sample.varied], tree })
    variantsByProp.set(sample.varied, list)
  }

  const workingTree = cloneTree(refTree)
  const extraLookups: FdnLookup[] = []
  foldVariants(workingTree, refTree, baseline.props, artifact.propSchema, variantsByProp, {
    componentName: artifact.name,
    report: push,
    extraLookups,
    lookupCounter: { n: 0 },
  })

  const nativeComponent: FdnComponent = {
    name: artifact.name,
    props: artifact.propSchema,
    slots: [],
    body: workingTree,
    provenance: artifact.provenance,
  }

  const mismatches = checkInteractions(nativeComponent, extraLookups, probes, artifact.classIndex)
  if (mismatches.length > 0) {
    for (const m of mismatches) {
      push({
        code: 'import-prop-interaction',
        severity: 'warning',
        message: `props "${m.propA}" and "${m.propB}" interact — independently applying their single-prop transformations does not reproduce the pairwise sample`,
        detail: m.detail as Record<string, unknown>,
      })
    }
    const component = buildSealedComponent(artifact, artifact.classIndex, 'prop interaction detected by the pairwise probe check', push)
    return { component, mode: 'sealed', report, extraLookups: [] }
  }

  return { component: nativeComponent, mode: 'native', report, extraLookups }
}
