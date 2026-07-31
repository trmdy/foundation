/**
 * `foundation diff <a.html> <b.html>` — structural diff via `projectDocument`
 * (canonical-text line diff) always; visual diff via the render/diff modules
 * when they're present, degrading to structure-only otherwise (API.md CLI
 * section; render + diff are Wave 2 modules built concurrently elsewhere).
 *
 * Both module specs below are *computed* (not string literals) so TypeScript
 * never tries to resolve them at typecheck time — they may not exist on disk
 * yet in this checkout.
 */
import { readFileSync } from 'node:fs'
import { parseDocument, projectDocument } from 'foundation-engine'
import type { ConformanceReport, FdnDocument, FdnViewport } from 'foundation-engine'
import type { CliIO } from '../io.js'
import { parseArgs } from '../argv.js'

const RENDER_MODULE_SPEC = ['foundation-engine', 'src', 'render', 'index.js'].join('/')
const DIFF_MODULE_SPEC = ['foundation-engine', 'src', 'diff', 'index.js'].join('/')

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

interface VisualDiffResult {
  identical: boolean
  diffPixels: number
  width: number
  height: number
  diffPng: Uint8Array | null
}

interface DiffModule {
  visualDiff: (a: Uint8Array, b: Uint8Array) => VisualDiffResult
}

async function loadRenderModule(): Promise<RenderModule | undefined> {
  try {
    const mod = (await import(RENDER_MODULE_SPEC)) as Partial<RenderModule>
    return typeof mod.renderDocument === 'function' ? (mod as RenderModule) : undefined
  } catch {
    return undefined
  }
}

async function loadDiffModule(): Promise<DiffModule | undefined> {
  try {
    const mod = (await import(DIFF_MODULE_SPEC)) as Partial<DiffModule>
    return typeof mod.visualDiff === 'function' ? (mod as DiffModule) : undefined
  } catch {
    return undefined
  }
}

interface LineDiffSummary {
  added: number
  removed: number
  unchanged: number
  identical: boolean
}

/** Plain LCS-based line diff — no dependency, adequate for design-doc-sized files. */
function diffLines(a: string[], b: string[]): LineDiffSummary {
  const n = a.length
  const m = b.length
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const row = dp[i] as number[]
      const nextRow = dp[i + 1] as number[]
      row[j] = a[i] === b[j] ? (nextRow[j + 1] as number) + 1 : Math.max(nextRow[j] as number, row[j + 1] as number)
    }
  }
  const lcsLen = (dp[0] as number[])[0] as number
  const added = m - lcsLen
  const removed = n - lcsLen
  return { added, removed, unchanged: lcsLen, identical: added === 0 && removed === 0 }
}

function cellKey(c: RenderCell): string {
  return `${c.state ?? 'default'}::${c.viewport.name}`
}

export async function runDiff(args: string[], io: CliIO): Promise<number> {
  const { positionals } = parseArgs(args)
  const [fileA, fileB] = positionals
  if (!fileA || !fileB) {
    io.stderr('usage: foundation diff <a.html> <b.html>')
    return 2
  }

  let sourceA: string
  let sourceB: string
  try {
    sourceA = readFileSync(fileA, 'utf8')
    sourceB = readFileSync(fileB, 'utf8')
  } catch (err) {
    io.stderr(`could not read input file(s): ${err instanceof Error ? err.message : String(err)}`)
    return 2
  }

  const { doc: docA } = parseDocument(sourceA)
  const { doc: docB } = parseDocument(sourceB)
  const canonicalA = projectDocument(docA)
  const canonicalB = projectDocument(docB)

  const structural = diffLines(canonicalA.split('\n'), canonicalB.split('\n'))

  io.stdout(`structural: ${fileA} vs ${fileB}`)
  if (structural.identical) {
    io.stdout('  canonical projections are identical')
  } else {
    io.stdout(`  ${structural.added} line(s) added, ${structural.removed} line(s) removed, ${structural.unchanged} line(s) unchanged`)
  }

  const renderModule = await loadRenderModule()
  const diffModule = await loadDiffModule()

  if (!renderModule || !diffModule) {
    io.stdout('visual: not available yet (render/diff modules not present) — structure-only diff')
    return 0
  }

  let cellsA: RenderCell[]
  let cellsB: RenderCell[]
  try {
    cellsA = await renderModule.renderDocument(docA)
    cellsB = await renderModule.renderDocument(docB)
  } catch (err) {
    io.stdout(`visual: render failed (${err instanceof Error ? err.message : String(err)}) — structure-only diff`)
    return 0
  }

  const byKeyB = new Map(cellsB.map((c) => [cellKey(c), c]))
  const seen = new Set<string>()
  for (const a of cellsA) {
    const key = cellKey(a)
    seen.add(key)
    const b = byKeyB.get(key)
    if (!b) {
      io.stdout(`visual: ${key}: only in ${fileA}`)
      continue
    }
    const vd = diffModule.visualDiff(a.png, b.png)
    io.stdout(`visual: ${key}: ${vd.identical ? 'identical' : `${vd.diffPixels} pixel(s) differ (${vd.width}x${vd.height})`}`)
  }
  for (const b of cellsB) {
    const key = cellKey(b)
    if (!seen.has(key)) io.stdout(`visual: ${key}: only in ${fileB}`)
  }

  return 0
}
