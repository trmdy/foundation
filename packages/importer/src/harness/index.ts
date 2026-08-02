/**
 * harvestComponent — API.md Wave 4 Stage 1 entry point. Orchestrates:
 *   1. read + hash the source (provenance)
 *   2. detect the exported component + best-effort prop schema (schema.ts)
 *   3. esbuild-bundle a render shim around it (compile.ts)
 *   4. run the sample matrix inside the SSR sandbox (sandbox.ts, samples.ts)
 *   5. compile Tailwind against the observed class set (class-index.ts)
 * Every failure mode surfaces as a HarnessError (errors.ts) — never an
 * uncaught crash — per API.md's "structured error, not a crash".
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { FdnProp } from 'foundation-engine'
import { sha256Hex } from '../hash.js'
import type { RenderArtifact } from '../types.js'
import { detectComponent, extractPropSchema } from './schema.js'
import { compileComponent } from './compile.js'
import { createSandbox } from './sandbox.js'
import { buildSampleMatrix } from './samples.js'
import { buildClassIndex } from './class-index.js'

export interface HarvestComponentOptions {
  /** path to a .tsx/.jsx component file */
  source: string
  /** default: inferred from export/file */
  name?: string
  /** override; else best-effort from TS types (string | boolean |
   *  string-literal-union → enum; else require override) */
  props?: FdnProp[]
}

export async function harvestComponent(opts: HarvestComponentOptions): Promise<RenderArtifact> {
  const absSource = path.resolve(opts.source)
  const sourceBytes = readFileSync(absSource)
  const sourceText = sourceBytes.toString('utf8')
  const contentSha256 = sha256Hex(sourceBytes)

  const fileBaseName = path.basename(absSource).replace(/\.[jt]sx?$/, '')
  const detected = detectComponent(sourceText, fileBaseName, opts.name)
  const { propSchema, enumValues } = extractPropSchema(sourceText, detected, opts.props ?? [])

  const bundle = await compileComponent(absSource, detected.exportedName, detected.isDefaultExport)
  const sandbox = createSandbox(bundle.code)

  const samples = buildSampleMatrix({ propSchema, enumValues, render: (props) => sandbox.render(props) })
  const classIndex = await buildClassIndex(samples.map((s) => s.html))

  return {
    name: detected.displayName,
    propSchema,
    samples,
    classIndex,
    provenance: { source: absSource, contentSha256 },
  }
}
