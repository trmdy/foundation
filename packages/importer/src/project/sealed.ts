/**
 * Sealed fallback (API.md): "baseline html as sealed.html; css = the
 * classIndex rules for the classes used, serialized (base + state
 * pseudo-classes), unscoped (bake scopes it)". Deliberately literal: the raw
 * baseline sample html is used AS-IS, including any un-substituted sentinel
 * tokens (⟦fdn:prop:x⟧) — sealing trades away prop-driven templating
 * entirely (D3: a capsule is opaque), so string-prop substitution doesn't
 * apply to it, and there is nothing to "fix" here; see project/index.ts's
 * final report for the corollary this implies for the FdnComponent contract.
 */
import type { FdnComponent, ReportLine } from 'foundation-engine'
import { collectUsedClasses, serializeSealedCss } from './style.js'
import { parseSampleHtml } from './html.js'
import type { ClassIndex, RenderArtifact } from '../types.js'

export function buildSealedComponent(
  artifact: RenderArtifact,
  classIndex: ClassIndex,
  reason: string,
  report: (line: ReportLine) => void,
): FdnComponent {
  const baseline = artifact.samples[0]
  const html = baseline?.html ?? ''
  const usedClasses = collectUsedClasses(parseSampleHtml(html))
  const css = serializeSealedCss(usedClasses, classIndex, report)

  report({
    code: 'import-sealed',
    severity: 'info',
    message: `"${artifact.name}" sealed: ${reason}`,
    detail: { reason },
  })

  return {
    name: artifact.name,
    props: artifact.propSchema,
    slots: [],
    body: [],
    sealed: { html, css },
    provenance: artifact.provenance,
  }
}
