/**
 * `foundation render <file> [--state S] [--viewport V] [-o dir]` — dynamic-
 * imports the engine's render module (Wave 2, built concurrently by another
 * agent per API.md) and degrades gracefully if it isn't there yet:
 * "render module not available yet", exit 2.
 *
 * Deliberately a *computed* import specifier (not a string literal) so
 * TypeScript never tries to resolve `foundation-engine/src/render/index.js`
 * at typecheck time — that path may not exist on disk yet and must not be a
 * compile error here.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseDocument } from 'foundation-engine'
import type { ConformanceReport, FdnDocument, FdnViewport } from 'foundation-engine'
import type { CliIO } from '../io.js'
import { flagString, parseArgs } from '../argv.js'

interface LayoutEntry {
  id: string
  x: number
  y: number
  width: number
  height: number
}

interface RenderCell {
  state: string | null
  viewport: FdnViewport
  png: Uint8Array
  layout: LayoutEntry[]
  report: ConformanceReport
}

interface RenderModule {
  renderDocument: (doc: FdnDocument, opts?: { state?: string; viewport?: string }) => Promise<RenderCell[]>
}

const RENDER_MODULE_SPEC = ['foundation-engine', 'src', 'render', 'index.js'].join('/')

async function loadRenderModule(): Promise<RenderModule | undefined> {
  try {
    const mod = (await import(RENDER_MODULE_SPEC)) as Partial<RenderModule>
    if (typeof mod.renderDocument !== 'function') return undefined
    return mod as RenderModule
  } catch {
    return undefined
  }
}

export async function runRender(args: string[], io: CliIO): Promise<number> {
  const { positionals, flags } = parseArgs(args)
  const file = positionals[0]
  if (!file) {
    io.stderr('usage: foundation render <file> [--state S] [--viewport V] [-o dir]')
    return 2
  }

  const renderModule = await loadRenderModule()
  if (!renderModule) {
    io.stderr('render module not available yet')
    return 2
  }

  let source: string
  try {
    source = readFileSync(file, 'utf8')
  } catch (err) {
    io.stderr(`could not read ${file}: ${err instanceof Error ? err.message : String(err)}`)
    return 2
  }

  const state = flagString(flags, 'state')
  const viewport = flagString(flags, 'viewport')
  const outDir = flagString(flags, 'o', 'out', 'output')

  const { doc } = parseDocument(source)
  const cells = await renderModule.renderDocument(doc, { ...(state !== undefined ? { state } : {}), ...(viewport !== undefined ? { viewport } : {}) })

  if (outDir) mkdirSync(outDir, { recursive: true })

  for (const cell of cells) {
    const label = `${cell.state ?? 'default'}--${cell.viewport.name}`
    if (outDir) {
      writeFileSync(join(outDir, `${label}.png`), cell.png)
      writeFileSync(join(outDir, `${label}.layout.json`), JSON.stringify(cell.layout, null, 2))
      io.stdout(`wrote ${join(outDir, `${label}.png`)}`)
    } else {
      io.stdout(`${label}: ${cell.png.byteLength} bytes, ${cell.layout.length} layout entries`)
    }
  }

  return 0
}
