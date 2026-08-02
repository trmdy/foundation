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
 *   3. `extraTokens: Record<string, string>` (follow-up wave: "Tailwind
 *      theme vars become Foundation tokens on import") — same shape as
 *      finding 1: `FdnDocument.tokens` is document-level, this module has
 *      no document to merge into, so the CLI merges these into `doc.tokens`
 *      when committing (existing-token-with-a-different-value is a merge
 *      DECISION the CLI makes, not this module — see commands/import.ts's
 *      `mergeTokens`). Unlike extraLookups this is copied straight from
 *      `artifact.themeVars` — it is a fact about the ARTIFACT (every var()
 *      any declaration in its classIndex references), not something that
 *      depends on which projection branch (native/sealed) ends up taken, so
 *      it is computed once, up front, and included in EVERY return path
 *      below, including the early-sealed ones. A sealed capsule's css
 *      references these same var() names just as much as a native body's
 *      style attributes do (both come from the same classIndex
 *      declarations — see project/sealed.ts), so it needs the tokens too.
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
  extraTokens: Record<string, string>
}

/** Reports (and returns, ready to merge into `doc.tokens`) the artifact's
 *  already-resolved theme vars — one `import-theme-token` info line per
 *  token that will be emitted, one `import-unresolved-theme-var` warning
 *  per var() reference nothing in the design system's theme could resolve
 *  (left as a bare var() reference in the declaration, per D1: report,
 *  never reject). Called once, before the native/sealed branch below picks
 *  a return path, since which branch wins doesn't change this artifact-level
 *  fact — see finding 3 above. */
function reportThemeTokens(artifact: RenderArtifact, push: (line: ReportLine) => void): Record<string, string> {
  for (const [name, value] of Object.entries(artifact.themeVars)) {
    push({
      code: 'import-theme-token',
      severity: 'info',
      message: `theme var --${name} resolved to document token --${name} (${value})`,
      detail: { name, value },
    })
  }
  for (const name of artifact.unresolvedThemeVars) {
    push({
      code: 'import-unresolved-theme-var',
      severity: 'warning',
      message: `${name} has no resolvable theme definition — left as a var() reference in place; declare it as a token manually if the component needs it to render correctly`,
      detail: { name },
    })
  }
  return artifact.themeVars
}

export function projectArtifact(artifact: RenderArtifact, opts?: ProjectOptions): ProjectResult {
  const report: ReportLine[] = []
  const push = (line: ReportLine): void => {
    report.push(line)
  }
  const extraTokens = reportThemeTokens(artifact, push)

  if (opts?.forceSealed) {
    const component = buildSealedComponent(artifact, artifact.classIndex, 'forced by --sealed', push)
    return { component, mode: 'sealed', report, extraLookups: [], extraTokens }
  }

  const baseline = artifact.samples[0]
  if (!baseline) {
    const component = buildSealedComponent(artifact, artifact.classIndex, 'no samples in artifact', push)
    return { component, mode: 'sealed', report, extraLookups: [], extraTokens }
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
    return { component, mode: 'sealed', report, extraLookups: [], extraTokens }
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
    return { component, mode: 'sealed', report, extraLookups: [], extraTokens }
  }

  return { component: nativeComponent, mode: 'native', report, extraLookups, extraTokens }
}
