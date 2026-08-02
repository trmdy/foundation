/**
 * foundation MCP tools — the fixed tool list `foundation mcp` exposes over
 * stdio (packages/cli/src/mcp/server.ts wires these into the wire protocol).
 *
 * Each tool is a thin wrapper over `foundation-engine`'s public API and, where
 * one already exists, the corresponding CLI command's exported helper
 * (`chainPathFor`/`writeChainInit` from commands/chain.js, `skeletonDocument`
 * from commands/new.js) — the same engine calls `foundation <verb>` makes,
 * just returning structured data instead of printing lines. Every handler
 * catches its own errors and returns a structured, `isError: true` result;
 * nothing here is allowed to throw out to the server loop (a bad path or a
 * malformed document must never take the whole stdio server down mid-session
 * for every other tool call sharing it).
 *
 * Descriptions are agent-facing and teach the .fdn.html subset in miniature
 * (SUBSET_NOTE below) — the audience is a hive bee that has never seen
 * Foundation before and is deciding whether/how to call a tool, not a human
 * reading API docs.
 */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PNG } from 'pngjs'
import {
  bakeDocument,
  createChain,
  loadChain,
  parseDocument,
  projectDocument,
  validateDocument,
} from 'foundation-engine'
import type { ConformanceReport, FdnComponent, FdnDocument, FdnNode, FdnViewport, ReportLine } from 'foundation-engine'
// Deep import, not re-exported from the package root (same as commands/freeze.ts) —
// mirrored here rather than imported from commands/freeze.ts because that file
// only exports a CLI entry point (runFreeze), not these two.
import { freezeDocument, verifyFrozen } from 'foundation-engine/src/freeze/index.js'
import { chainPathFor, writeChainInit } from '../commands/chain.js'
// Bug fix (dogfood cycle 3, friction §6): the document id lives outside
// FdnDocument entirely (see docid.ts's module doc) — parseDocument/
// projectDocument never see it, so any parse->project round-trip silently
// drops data-fdn-doc-id unless the caller re-stamps it by hand.
// commands/ingest.ts (the CLI's `foundation ingest`) already does this;
// toolIngest below shares that same helper rather than re-deriving the
// re-stamp logic, so the two write paths can never drift again.
import { injectDocIdAttr, readDocIdAttr } from '../docid.js'
// foundation_import shares the harvest/project/merge/renumber plumbing with
// `foundation import` (CLI) rather than re-deriving it — same reuse pattern
// as chainPathFor/writeChainInit above. loadImporterModule() is itself the
// lazy-load boundary (a computed `import()`, see commands/import.ts's module
// doc): calling it is what pulls in esbuild/react/tailwindcss, so it must
// only happen inside toolImport's handler, never at this file's top level.
import {
  docMaxMintedId,
  formatStructuredError,
  harnessErrorCode,
  loadImporterModule,
  mergeLookups,
  mergeTokens,
  remintComponentIds,
  type ProjectResult,
  type RenderArtifact,
} from '../commands/import.js'
import { skeletonDocument, skeletonDocumentEmpty } from '../commands/new.js'
import { defaultAuthor } from '../identity.js'
import { chainLabel, documentStatus, manifestPathFor, readManifest, statusLabel } from '../project.js'

const require = createRequire(import.meta.url)

// ——— shared vocabulary note, folded into tool descriptions ———

const SUBSET_NOTE =
  '.fdn.html documents are a small HTML subset, not general HTML/JS: prefer design tokens '
  + '(var(--token), declared in the tokens block) over raw color/size values; interaction states use '
  + 'style-hover/style-focus/style-active/style-disabled attributes, never CSS :hover/:focus; '
  + 'conditional/iterated content uses when="<cond>" and each="<alias> in <source>" attributes, never '
  + 'script. Report codes (e.g. shorthand-expanded, off-token-value, excluded-element-dropped) are '
  + 'corrective, not fatal — they describe how the engine normalized or flagged input, not a failure.'

// ——— wire-format types (plain JSON Schema; no zod dependency needed to author these) ———

export interface JsonSchemaObject {
  type: 'object'
  properties?: Record<string, unknown>
  required?: string[]
  additionalProperties?: boolean
}

export interface ToolTextContent {
  type: 'text'
  text: string
}

export interface ToolResult {
  content: ToolTextContent[]
  structuredContent?: Record<string, unknown>
  isError?: boolean
}

export interface ToolDefinition {
  name: string
  description: string
  inputSchema: JsonSchemaObject
  handler: (args: Record<string, unknown>) => Promise<ToolResult>
}

// ——— small shared helpers ———

function ok(structured: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }],
    structuredContent: structured,
  }
}

function fail(message: string, code?: string): ToolResult {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
    ...(code !== undefined ? { structuredContent: { code } } : {}),
  }
}

class ToolInputError extends Error {}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new ToolInputError(`"${key}" must be a non-empty string`)
  }
  return value
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  return typeof value === 'string' ? value : undefined
}

function optionalBoolean(args: Record<string, unknown>, key: string): boolean {
  return args[key] === true
}

function readSource(path: string): { ok: true; source: string } | { ok: false; result: ToolResult } {
  try {
    return { ok: true, source: readFileSync(path, 'utf8') }
  } catch (err) {
    return { ok: false, result: fail(`could not read ${path}: ${err instanceof Error ? err.message : String(err)}`) }
  }
}

/** Dedupe identical report lines (same severity+code+nodeId+message) — bake
 *  in particular can repeat a line once per instantiation of a component, and
 *  an agent reading the report cares about the distinct findings, not the
 *  repeat count. */
function dedupeLines(lines: ReportLine[]): ReportLine[] {
  const seen = new Set<string>()
  const out: ReportLine[] = []
  for (const line of lines) {
    const key = `${line.severity}|${line.code}|${line.nodeId ?? ''}|${line.message}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(line)
  }
  return out
}

function reportPayload(lines: ReportLine[]): { count: number; lines: ReportLine[] } {
  const deduped = dedupeLines(lines)
  return { count: deduped.length, lines: deduped }
}

/**
 * friction §5: crop a rendered PNG to a node's layout box + padding, using
 * pngjs (already a dependency — see packages/engine/src/diff/index.ts's
 * visualDiff — no new dep needed). The box is clamped to the source image's
 * bounds so an edge-flush node's padding doesn't read outside the canvas.
 */
function cropPngToBox(pngBytes: Uint8Array, box: { x: number; y: number; width: number; height: number }, padding: number): Uint8Array {
  const src = PNG.sync.read(Buffer.from(pngBytes))
  const x0 = Math.max(0, Math.floor(box.x - padding))
  const y0 = Math.max(0, Math.floor(box.y - padding))
  const x1 = Math.min(src.width, Math.ceil(box.x + box.width + padding))
  const y1 = Math.min(src.height, Math.ceil(box.y + box.height + padding))
  const width = Math.max(1, x1 - x0)
  const height = Math.max(1, y1 - y0)
  const dst = new PNG({ width, height })
  PNG.bitblt(src, dst, x0, y0, width, height, 0, 0)
  return PNG.sync.write(dst)
}

function countNodes(nodes: FdnNode[]): number {
  let n = 0
  for (const node of nodes) n += 1 + countNodes(node.children)
  return n
}

function engineVersion(): string {
  const pkg = require('foundation-engine/package.json') as { version?: string }
  return pkg.version ?? '0.0.0'
}

function titleFromPath(path: string): string {
  const base = (path.split('/').pop() ?? path).replace(/\.fdn\.html$/, '')
  return base
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w[0]?.toUpperCase() + w.slice(1))
    .join(' ')
}

// ——— simple LCS line diff, same algorithm as commands/diff.ts's private helper
//      (not exported there, so mirrored here rather than reaching into an
//      out-of-scope file) ———

interface LineDiffSummary {
  added: number
  removed: number
  unchanged: number
  identical: boolean
}

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

// ——— lazy Wave 2 module loaders (computed specifiers so tsc never resolves
//      them at typecheck time if absent — same trick as commands/render.ts /
//      commands/diff.ts) ———

interface LayoutEntry { id: string; x: number; y: number; width: number; height: number }
interface RenderCell { state: string | null; viewport: FdnViewport; png: Uint8Array; layout: LayoutEntry[]; report: ConformanceReport }
interface RenderModule {
  renderDocument: (doc: FdnDocument, opts?: { state?: string; viewport?: string }) => Promise<RenderCell[]>
}
interface VisualDiffResult { identical: boolean; diffPixels: number; width: number; height: number; diffPng: Uint8Array | null }
interface DiffModule { visualDiff: (a: Uint8Array, b: Uint8Array) => VisualDiffResult }

const RENDER_MODULE_SPEC = ['foundation-engine', 'src', 'render', 'index.js'].join('/')
const DIFF_MODULE_SPEC = ['foundation-engine', 'src', 'diff', 'index.js'].join('/')

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

// ——— tool handlers ———

async function toolInspect(args: Record<string, unknown>): Promise<ToolResult> {
  const path = requireString(args, 'path')
  const read = readSource(path)
  if (!read.ok) return read.result
  const { doc } = parseDocument(read.source)
  const result = validateDocument(doc)
  const nodeCount = countNodes(doc.body) + doc.components.reduce((sum, c) => sum + countNodes(c.body), 0)
  return ok({
    path,
    title: doc.title ?? null,
    params: doc.params.length,
    states: doc.states.length,
    components: doc.components.length,
    nodes: nodeCount,
    valid: result.valid,
    issues: reportPayload(result.issues),
  })
}

async function toolRead(args: Record<string, unknown>): Promise<ToolResult> {
  const path = requireString(args, 'path')
  const read = readSource(path)
  if (!read.ok) return read.result
  const { doc } = parseDocument(read.source)
  const canonical = projectDocument(doc)
  return ok({ path, canonical, changedFromDisk: canonical !== read.source })
}

async function toolValidate(args: Record<string, unknown>): Promise<ToolResult> {
  const path = requireString(args, 'path')
  const read = readSource(path)
  if (!read.ok) return read.result
  const { doc } = parseDocument(read.source)
  const result = validateDocument(doc)
  return ok({ path, valid: result.valid, issues: reportPayload(result.issues) })
}

async function toolIngest(args: Record<string, unknown>): Promise<ToolResult> {
  const path = requireString(args, 'path')
  const content = optionalString(args, 'content')
  const commit = optionalBoolean(args, 'commit')
  const message = optionalString(args, 'message')

  if (content !== undefined) {
    try {
      writeFileSync(path, content, 'utf8')
    } catch (err) {
      return fail(`could not write ${path}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const read = readSource(path)
  if (!read.ok) return read.result

  const { doc, report } = parseDocument(read.source)
  const canonical = projectDocument(doc)
  // Bug fix (friction §6): re-stamp data-fdn-doc-id off the ORIGINAL source
  // onto the freshly-projected text, exactly as commands/ingest.ts's CLI
  // path does — parse(project(doc)) is a fixpoint for FdnDocument, but
  // data-fdn-doc-id isn't part of FdnDocument, so without this every MCP
  // ingest silently deleted the document's identity.
  const docId = readDocIdAttr(read.source)
  const canonicalWithDocId = docId ? injectDocIdAttr(canonical, docId) : canonical
  const rewritten = canonicalWithDocId !== read.source
  try {
    writeFileSync(path, canonicalWithDocId, 'utf8')
  } catch (err) {
    return fail(`could not write ${path}: ${err instanceof Error ? err.message : String(err)}`)
  }
  const validation = validateDocument(doc)

  let commitInfo: Record<string, unknown> | null = null
  if (commit) {
    const chainPath = chainPathFor(path)
    if (!existsSync(chainPath)) {
      commitInfo = { status: 'skipped', reason: `no chain yet — call foundation_new or chain init to start tracking ${path}` }
    } else {
      try {
        // friction §6: same identity rules the CLI uses (agent:<HIVE_BEE> when
        // set, else user:<name>@<host>) — a hardcoded 'agent:mcp' loses which
        // bee actually made the change in the chain log.
        const author = defaultAuthor()
        const chain = loadChain(readFileSync(chainPath), { actor: author })
        const currentCanonical = projectDocument(chain.doc())
        if (currentCanonical === canonical) {
          commitInfo = { status: 'no-op', reason: 'parsed document matches chain head; nothing to commit' }
        } else {
          const commitMessage = message ?? (report.lines.length === 0 ? 'ingest' : `ingest — ${report.lines.length} normalization line(s)`)
          const envelope = chain.apply({ author, message: commitMessage }, [{ op: 'replace-document', doc }])
          writeFileSync(chainPath, chain.save())
          commitInfo = { status: 'committed', hash: envelope.hash, message: commitMessage, chainPath }
        }
      } catch (err) {
        return fail(`chain commit failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  return ok({
    path,
    rewritten,
    normalization: reportPayload(report.lines),
    valid: validation.valid,
    issues: reportPayload(validation.issues),
    commit: commitInfo,
  })
}

async function toolBake(args: Record<string, unknown>): Promise<ToolResult> {
  const path = requireString(args, 'path')
  const state = optionalString(args, 'state')
  const read = readSource(path)
  if (!read.ok) return read.result
  const { doc } = parseDocument(read.source)
  const baked = bakeDocument(doc, state !== undefined ? { state } : undefined)
  return ok({
    path,
    state: baked.state,
    html: baked.html,
    conformance: reportPayload(baked.report.lines),
  })
}

async function toolRender(args: Record<string, unknown>): Promise<ToolResult> {
  const path = requireString(args, 'path')
  const state = optionalString(args, 'state')
  const viewport = optionalString(args, 'viewport')
  const outDirArg = optionalString(args, 'outDir')
  const includeLayout = optionalBoolean(args, 'includeLayout')
  const nodeId = optionalString(args, 'node')

  const renderModule = await loadRenderModule()
  if (!renderModule) return fail('render module not available yet (foundation-engine/src/render is Wave 2)')

  const read = readSource(path)
  if (!read.ok) return read.result
  const { doc } = parseDocument(read.source)

  const outDir = outDirArg ?? mkdtempSync(join(tmpdir(), 'foundation-mcp-render-'))
  mkdirSync(outDir, { recursive: true })

  let cells: RenderCell[]
  try {
    cells = await renderModule.renderDocument(doc, {
      ...(state !== undefined ? { state } : {}),
      ...(viewport !== undefined ? { viewport } : {}),
    })
  } catch (err) {
    return fail(`render failed: ${err instanceof Error ? err.message : String(err)}`)
  }

  // friction §4: a 314-node board's full layout array is ~170KB of JSON —
  // enough to blow the tool-result limit and get spilled to a file, burying
  // the one thing actually needed (the PNG path). Default to paths + a
  // one-line-per-cell summary; the full layout array is opt-in
  // (`includeLayout: true`); it's written to disk either way (like the CLI
  // render command already does with an outDir), so it's always reachable.
  const renders = cells.map((cell) => {
    const label = `${cell.state ?? 'default'}--${cell.viewport.name}`
    const fullPngPath = join(outDir, `${label}.png`)
    writeFileSync(fullPngPath, cell.png)
    const layoutPath = join(outDir, `${label}.layout.json`)
    writeFileSync(layoutPath, JSON.stringify(cell.layout, null, 2))

    const conformance = reportPayload(cell.report.lines)
    const errorCount = conformance.lines.filter((l) => l.severity === 'error').length
    const warningCount = conformance.lines.filter((l) => l.severity === 'warning').length

    const entry: Record<string, unknown> = {
      state: cell.state,
      viewport: cell.viewport,
      pngPath: fullPngPath,
      bytes: cell.png.byteLength,
      nodes: cell.layout.length,
      errors: errorCount,
      warnings: warningCount,
      layoutPath,
    }

    // friction §5: an optional node-scoped crop, so an agent checking
    // fine-grained detail (is this dot 7px, does this ring read as hollow)
    // doesn't need a shell round-trip through `sips` to get a legible image.
    if (nodeId) {
      const box = cell.layout.find((l) => l.id === nodeId)
      if (!box) {
        entry.cropError = `node "${nodeId}" not found in this cell's layout (it may be when-gated out of this state/viewport)`
      } else {
        const cropPath = join(outDir, `${label}.${nodeId}.crop.png`)
        writeFileSync(cropPath, cropPngToBox(cell.png, box, 16))
        entry.pngPath = cropPath
        entry.croppedFor = nodeId
        entry.croppedBox = box
        entry.fullPngPath = fullPngPath
      }
    }

    if (includeLayout) entry.layout = cell.layout
    return entry
  })

  return ok({ path, outDir, renders })
}

async function toolDiff(args: Record<string, unknown>): Promise<ToolResult> {
  const pathA = requireString(args, 'pathA')
  const pathB = requireString(args, 'pathB')
  const visual = optionalBoolean(args, 'visual')

  const readA = readSource(pathA)
  if (!readA.ok) return readA.result
  const readB = readSource(pathB)
  if (!readB.ok) return readB.result

  const { doc: docA } = parseDocument(readA.source)
  const { doc: docB } = parseDocument(readB.source)
  const canonicalA = projectDocument(docA)
  const canonicalB = projectDocument(docB)
  const structural = diffLines(canonicalA.split('\n'), canonicalB.split('\n'))

  const result: Record<string, unknown> = { pathA, pathB, structural }

  if (!visual) return ok(result)

  const renderModule = await loadRenderModule()
  const diffModule = await loadDiffModule()
  if (!renderModule || !diffModule) {
    result.visual = { available: false, reason: 'render/diff modules not available yet (Wave 2)' }
    return ok(result)
  }

  try {
    const cellsA = await renderModule.renderDocument(docA)
    const cellsB = await renderModule.renderDocument(docB)
    const byKeyB = new Map(cellsB.map((c) => [`${c.state ?? 'default'}::${c.viewport.name}`, c]))
    const seen = new Set<string>()
    const cells: Array<Record<string, unknown>> = []
    for (const a of cellsA) {
      const key = `${a.state ?? 'default'}::${a.viewport.name}`
      seen.add(key)
      const b = byKeyB.get(key)
      if (!b) {
        cells.push({ key, onlyIn: pathA })
        continue
      }
      const vd = diffModule.visualDiff(a.png, b.png)
      cells.push({ key, identical: vd.identical, diffPixels: vd.diffPixels, width: vd.width, height: vd.height })
    }
    for (const b of cellsB) {
      const key = `${b.state ?? 'default'}::${b.viewport.name}`
      if (!seen.has(key)) cells.push({ key, onlyIn: pathB })
    }
    result.visual = { available: true, cells }
  } catch (err) {
    result.visual = { available: false, reason: `render failed: ${err instanceof Error ? err.message : String(err)}` }
  }

  return ok(result)
}

async function toolChainLog(args: Record<string, unknown>): Promise<ToolResult> {
  const path = requireString(args, 'path')
  const chainPath = chainPathFor(path)
  if (!existsSync(chainPath)) {
    return ok({ path, chainPath, exists: false, entries: [] })
  }
  try {
    const chain = loadChain(readFileSync(chainPath))
    const entries = chain.log()
    return ok({ path, chainPath, exists: true, entries })
  } catch (err) {
    return fail(`could not read ${chainPath}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function toolChainAnchor(args: Record<string, unknown>): Promise<ToolResult> {
  const path = requireString(args, 'path')
  const name = requireString(args, 'name')
  const chainPath = chainPathFor(path)
  if (!existsSync(chainPath)) {
    return fail(`${path}: no chain yet (${chainPath} not found) — call foundation_new or ingest with commit:true first`)
  }
  try {
    const chain = loadChain(readFileSync(chainPath))
    chain.anchor(name)
    writeFileSync(chainPath, chain.save())
    return ok({ path, chainPath, anchor: name, head: chain.head() })
  } catch (err) {
    return fail(`chain anchor failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function toolFreeze(args: Record<string, unknown>): Promise<ToolResult> {
  const path = requireString(args, 'path')
  const out = requireString(args, 'out')
  const message = optionalString(args, 'message')

  const read = readSource(path)
  if (!read.ok) return read.result
  const { doc } = parseDocument(read.source)
  const validation = validateDocument(doc)
  if (!validation.valid) {
    return ok({ path, frozen: false, refused: true, reason: 'refusing to freeze an invalid document', issues: reportPayload(validation.issues) })
  }

  const chainPath = chainPathFor(path)
  let chainHead: string | null = null
  if (existsSync(chainPath)) {
    try {
      chainHead = loadChain(readFileSync(chainPath)).head().hash
    } catch (err) {
      return fail(`could not read chain ${chainPath}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // friction §6 / loose end: same identity rules the CLI uses (agent:<HIVE_BEE>
  // when set, else user:<name>@<host>) — a hardcoded 'agent:mcp' loses which
  // bee actually froze the document, same class of bug foundation_new's chain
  // init and foundation_ingest's commit path were already fixed for above.
  const frozen = freezeDocument(doc, {
    author: defaultAuthor(),
    ...(message !== undefined ? { message } : {}),
    chainHead,
    engineVersion: engineVersion(),
  })
  try {
    writeFileSync(out, frozen, 'utf8')
  } catch (err) {
    return fail(`could not write ${out}: ${err instanceof Error ? err.message : String(err)}`)
  }
  const verification = verifyFrozen(frozen)
  return ok({ path, out, frozen: true, refused: false, header: verification.header ?? null })
}

async function toolNew(args: Record<string, unknown>): Promise<ToolResult> {
  const path = requireString(args, 'path')
  const title = optionalString(args, 'title') ?? titleFromPath(path)
  const empty = optionalBoolean(args, 'empty')
  const filePath = path.endsWith('.fdn.html') ? path : `${path}.fdn.html`

  if (existsSync(filePath)) {
    return fail(`refusing to overwrite existing file: ${filePath}`)
  }

  const doc = empty ? skeletonDocumentEmpty(title) : skeletonDocument(title)
  const check = validateDocument(doc)
  if (!check.valid) {
    return fail(`internal error: generated skeleton failed validation: ${JSON.stringify(check.issues)}`)
  }
  // Bug fix (dogfood cycle 3, friction §6): SPEC 13a-i requires the CLI/
  // surface layer (never the randomness-free engine) to mint the document
  // id and stamp it into the text — exactly what commands/new.ts's
  // `foundation new` does. This MCP handler used to skip that step
  // entirely, so an MCP-created document had no data-fdn-doc-id in its
  // text AND no docId recorded in its chain (writeChainInit below was
  // never given one either) — `foundation project add` then refused it
  // outright with "no document id found". Mint + stamp here via the same
  // docid.ts helper the CLI uses, and thread the same id into the chain's
  // own init commit, matching `foundation new` exactly.
  const docId = randomUUID()
  const text = injectDocIdAttr(projectDocument(doc), docId)
  try {
    writeFileSync(filePath, text, 'utf8')
  } catch (err) {
    return fail(`could not write ${filePath}: ${err instanceof Error ? err.message : String(err)}`)
  }

  // friction §6: same identity rules the CLI uses, not a hardcoded 'agent:mcp'.
  let chain: { chainPath: string; head: { hash: string } } | null = null
  const result = writeChainInit(
    filePath,
    doc,
    { author: defaultAuthor(), message: 'init' },
    { stdout: () => {}, stderr: () => {} },
    { docId },
  )
  if (result) chain = { chainPath: result.chainPath, head: { hash: result.head.hash } }

  return ok({ path: filePath, title, empty, chain, docId })
}

/**
 * `foundation_import` — Wave 4 Stage 3: the agent-facing twin of `foundation
 * import` (commands/import.ts owns the shared harvest/project/merge/renumber
 * logic; this handler is I/O glue only — JSON result instead of stdout
 * lines, `into` as the target-document arg name mirroring the CLI's --into).
 *
 * Description below is deliberately explicit about WHEN a component comes
 * back sealed vs native (friction §7's lesson: an oversold tool description
 * costs the calling agent a wasted retry/investigation cycle the first time
 * reality doesn't match the blurb) — sealed is not a failure mode, it is
 * the importer honestly reporting "this component's behavior depends on
 * more than one prop at once (or its Tailwind couldn't be resolved
 * statically), so it's vendored as opaque markup+css instead of a template
 * we'd have to lie about."
 */
async function toolImport(args: Record<string, unknown>): Promise<ToolResult> {
  const source = requireString(args, 'source')
  const into = requireString(args, 'into')
  const name = optionalString(args, 'name')
  const sealed = optionalBoolean(args, 'sealed')
  const propsArg = args['props']

  let propsOverride: FdnComponent['props'] | undefined
  if (propsArg !== undefined) {
    if (!Array.isArray(propsArg)) return fail('foundation_import: "props" must be an array of FdnProp objects')
    propsOverride = propsArg as FdnComponent['props']
  }

  const read = readSource(into)
  if (!read.ok) return read.result

  const importer = await loadImporterModule()

  let artifact: RenderArtifact
  try {
    artifact = await importer.harvestComponent({
      source,
      ...(name !== undefined ? { name } : {}),
      ...(propsOverride !== undefined ? { props: propsOverride } : {}),
    })
  } catch (err) {
    return fail(`foundation_import: ${formatStructuredError('harvest', err)}`, harnessErrorCode(err))
  }

  let projected: ProjectResult
  try {
    projected = importer.projectArtifact(artifact, sealed ? { forceSealed: true } : undefined)
  } catch (err) {
    return fail(`foundation_import: ${formatStructuredError('project', err)}`, harnessErrorCode(err))
  }

  const { doc } = parseDocument(read.source)

  const targetName = projected.component.name
  const existingIndex = doc.components.findIndex((c) => c.name === targetName)
  const maxId = docMaxMintedId(doc, targetName)
  const component: FdnComponent = {
    ...projected.component,
    body: remintComponentIds(projected.component.body, { n: maxId }),
  }

  const lookupResult = mergeLookups(doc.lookups, projected.extraLookups)
  if ('error' in lookupResult) return fail(`foundation_import: ${lookupResult.error}`)

  const tokenResult = mergeTokens(doc.tokens, projected.extraTokens)

  const components =
    existingIndex === -1 ? [...doc.components, component] : doc.components.map((c, i) => (i === existingIndex ? component : c))

  const nextDoc: FdnDocument = { ...doc, components, lookups: lookupResult.lookups, tokens: tokenResult.tokens }

  // Same class of bug as foundation_ingest (friction §6): commands/import.ts's
  // CLI path re-stamps data-fdn-doc-id off the ORIGINAL target source before
  // writing (its own "ordinary project -> re-stamp-doc-id -> write dance, see
  // ingest.ts" comment) — this MCP handler must do the same, via the same
  // docid.ts helpers, or every foundation_import through MCP silently strips
  // the target document's identity too.
  const canonical = projectDocument(nextDoc)
  const targetDocId = readDocIdAttr(read.source)
  const canonicalWithDocId = targetDocId ? injectDocIdAttr(canonical, targetDocId) : canonical
  try {
    writeFileSync(into, canonicalWithDocId, 'utf8')
  } catch (err) {
    return fail(`could not write ${into}: ${err instanceof Error ? err.message : String(err)}`)
  }

  let commitInfo: Record<string, unknown> | null = null
  const chainPath = chainPathFor(into)
  if (existsSync(chainPath)) {
    const author = defaultAuthor()
    try {
      const chain = loadChain(readFileSync(chainPath), { actor: author })
      const currentCanonical = projectDocument(chain.doc())
      if (currentCanonical === canonical) {
        commitInfo = { status: 'no-op', reason: 'parsed document matches chain head; nothing to commit' }
      } else {
        const message = `import ${component.name} from ${source} (${projected.mode})`
        const envelope = chain.apply({ author, message }, [{ op: 'replace-document', doc: nextDoc }])
        writeFileSync(chainPath, chain.save())
        commitInfo = { status: 'committed', hash: envelope.hash, message, chainPath }
      }
    } catch (err) {
      return fail(`chain commit failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return ok({
    source,
    into,
    component: component.name,
    action: existingIndex === -1 ? 'added' : 'replaced',
    mode: projected.mode,
    provenance: artifact.provenance,
    report: reportPayload([...projected.report, ...tokenResult.conflicts] as ReportLine[]),
    commit: commitInfo,
  })
}

/**
 * `foundation_project` — read a `foundation.json` manifest (SPEC 13a-iii)
 * and report per-document status. Read-only in MCP for v0 (only `action:
 * "list"` is accepted): writing a manifest (init/add/scan) stays CLI-only
 * (`foundation project init|add|list|scan`) until there's a concrete need
 * for an agent to mutate the project index over the wire.
 */
async function toolProject(args: Record<string, unknown>): Promise<ToolResult> {
  const dir = optionalString(args, 'dir') ?? '.'
  const action = optionalString(args, 'action') ?? 'list'
  if (action !== 'list') {
    return fail(`foundation_project: unsupported action "${action}" — only "list" is available in v0 (read-only; use the CLI's \`foundation project\` verbs to write a manifest)`)
  }

  const manifest = readManifest(dir)
  if (!manifest) {
    return fail(`no ${manifestPathFor(dir)} — run \`foundation project init ${dir}\` first (CLI-only for v0)`)
  }

  const documents = manifest.documents.map((entry) => {
    const status = documentStatus(dir, entry)
    return { ...status, status: statusLabel(status), chain: chainLabel(status) }
  })

  return ok({
    dir,
    manifestPath: manifestPathFor(dir),
    manifest: { schema: manifest.schema, id: manifest.id, name: manifest.name },
    documents,
  })
}

// ——— tool registry ———

export const TOOLS: ToolDefinition[] = [
  {
    name: 'foundation_inspect',
    description: `Summarize a .fdn.html document: title, param/state/component/node counts, and validation status. ${SUBSET_NOTE} Use this first when exploring an unfamiliar document.`,
    inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Path to a .fdn.html file' } }, required: ['path'] },
    handler: toolInspect,
  },
  {
    name: 'foundation_read',
    description: `Read a .fdn.html document's canonical text (the engine's normalized projection, not necessarily byte-identical to what is on disk). ${SUBSET_NOTE}`,
    inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Path to a .fdn.html file' } }, required: ['path'] },
    handler: toolRead,
  },
  {
    name: 'foundation_validate',
    description: `Validate a .fdn.html document and list issues (errors/warnings/info). ${SUBSET_NOTE}`,
    inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Path to a .fdn.html file' } }, required: ['path'] },
    handler: toolValidate,
  },
  {
    name: 'foundation_ingest',
    description:
      'THE write path for agents editing Foundation documents. Normalizes a .fdn.html file to canonical form '
      + '(parse -> project) and writes it back. Pass `content` to write new/edited text first, then ingest it in '
      + 'one call. Pass `commit: true` (with an optional `message`) to also append the result to the document\'s '
      + `chain, when one already exists (see foundation_new / foundation_chain_log). ${SUBSET_NOTE}`,
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to a .fdn.html file (created if `content` is given and it does not exist)' },
        content: { type: 'string', description: 'New file content to write before ingesting (optional — omit to just re-normalize the file already on disk)' },
        commit: { type: 'boolean', description: 'Also append this change to <path>.chain, if it exists' },
        message: { type: 'string', description: 'Commit message, used only when commit is true' },
      },
      required: ['path'],
    },
    handler: toolIngest,
  },
  {
    name: 'foundation_bake',
    description: `Bake a document state to fully-resolved, browser-ready HTML, plus a deduplicated conformance report (off-token values, unresolved refs, etc). ${SUBSET_NOTE}`,
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to a .fdn.html file' },
        state: { type: 'string', description: 'Named state to bake (see the document\'s states list via foundation_inspect); omitted = default/empty state' },
      },
      required: ['path'],
    },
    handler: toolBake,
  },
  {
    name: 'foundation_render',
    description:
      'Render a document to PNG(s) via a real browser (one per state x viewport in the document\'s matrix, or the '
      + 'requested state/viewport). Returns PNG paths plus a one-line-per-cell summary (state, viewport, bytes, '
      + 'node count, error/warning counts) — never image bytes and never the full layout array inline (a big board '
      + 'is enough JSON to blow the tool-result limit). Layout is always written to `<label>.layout.json` next to '
      + 'the PNG; pass `includeLayout: true` to also get it inline. Pass `node: "<data-fdn-id>"` to additionally get '
      + 'a PNG cropped to that node\'s layout box + 16px padding — much more legible than a full-page screenshot '
      + 'for judging small details (dot size, ring hollowness, sprite readability).',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to a .fdn.html file' },
        state: { type: 'string', description: 'Named state to render' },
        viewport: { type: 'string', description: 'Named viewport to render' },
        outDir: { type: 'string', description: 'Directory to write PNGs and layout JSON into; a tmp dir is used if omitted' },
        includeLayout: { type: 'boolean', description: 'Include the full per-node layout array inline in the result (default: paths only)' },
        node: { type: 'string', description: 'A data-fdn-id — crop the returned PNG to that node\'s layout box + 16px padding' },
      },
      required: ['path'],
    },
    handler: toolRender,
  },
  {
    name: 'foundation_diff',
    description:
      'Structurally diff two .fdn.html documents (line diff of their canonical projections). Pass `visual: true` '
      + 'to additionally render both and pixel-diff matching state/viewport cells (falls back to structure-only, '
      + 'reported in the result, when the render module is unavailable).',
    inputSchema: {
      type: 'object',
      properties: {
        pathA: { type: 'string', description: 'Path to the first .fdn.html file' },
        pathB: { type: 'string', description: 'Path to the second .fdn.html file' },
        visual: { type: 'boolean', description: 'Also compute a pixel-level visual diff' },
      },
      required: ['pathA', 'pathB'],
    },
    handler: toolDiff,
  },
  {
    name: 'foundation_chain_log',
    description: 'List the change history (envelope log) of a document\'s <path>.chain, oldest first. Returns an empty list if no chain exists yet.',
    inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Path to a .fdn.html file' } }, required: ['path'] },
    handler: toolChainLog,
  },
  {
    name: 'foundation_chain_anchor',
    description: 'Name the current head of a document\'s chain (e.g. "reviewed", "shipped") so foundation_diff-style chain comparisons can refer to it later.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to a .fdn.html file' },
        name: { type: 'string', description: 'Anchor name' },
      },
      required: ['path', 'name'],
    },
    handler: toolChainAnchor,
  },
  {
    name: 'foundation_freeze',
    description:
      'Crystallize a document into a lock-headered frozen text file at `out`, reviewable beside real components in '
      + 'a PR. Refuses (does not throw) and returns the validation issues instead if the document is invalid — '
      + 'fix them first (see foundation_validate).',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to a .fdn.html file' },
        out: { type: 'string', description: 'Destination path for the frozen file' },
        message: { type: 'string', description: 'Freeform message recorded in the frozen file\'s lock header' },
      },
      required: ['path', 'out'],
    },
    handler: toolFreeze,
  },
  {
    name: 'foundation_new',
    description:
      'Scaffold a new, minimal, valid .fdn.html document and start its chain. Default scaffold has one param, one '
      + 'state, one demo Card component, and a tokens block with a placeholder warm accent token (real projects '
      + `replace it) — you will delete the demo content on your first real edit. Pass \`empty: true\` for just the `
      + `header (doc id) + tokens block + empty <main> — no demo content to delete. ${SUBSET_NOTE}`,
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path (with or without the .fdn.html suffix) for the new document' },
        title: { type: 'string', description: 'Document title; derived from the path if omitted' },
        empty: { type: 'boolean', description: 'Emit only the fdn-doc header + tokens block + empty main — no demo param/state/component content' },
      },
      required: ['path'],
    },
    handler: toolNew,
  },
  {
    name: 'foundation_import',
    description:
      'Harvest a real React/TSX component (a .tsx/.jsx file — ShadCN-style, cva-variant, or plain) into an '
      + 'FdnComponent and merge it into a Foundation document (added if new, replaced if a component with that '
      + 'name already exists there), chain-committed when the target already has a chain. Two outcomes, both '
      + 'legitimate — check `mode` in the result, do not assume "native": '
      + '"native" means the component became an ordinary, editable Foundation component (template body, when= '
      + 'branches, {{ prop.x }} interpolation) you can inspect/edit exactly like a hand-written one afterward. '
      + '"sealed" means the source component\'s behavior could not be safely expressed that way (its Tailwind '
      + 'output could not be resolved statically, or two-or-more props interact in ways independent single-prop '
      + 'folding cannot reproduce — see the `report` entries for which) — the ENTIRE rendered markup+css was '
      + 'vendored verbatim as an opaque capsule instead. A sealed component still works correctly at bake time '
      + '(same props in, same html out) but its body is not editable Foundation content; expect and accept this '
      + 'for genuinely complex source components rather than treating it as an import failure. Pass `sealed: '
      + 'true` to force capsule mode even when native projection would have succeeded (e.g. you want the vendored '
      + 'source preserved byte-for-byte). Pass `props` (an array of `{name, type, values?, required?, default?}`) '
      + 'to override auto-detected prop types, or to supply one for a prop the auto-detector could not classify '
      + '(e.g. a `children: ReactNode` field — pass `{name: "children", type: "string"}`); overrides always win. '
      + `${SUBSET_NOTE}`,
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'Path to the .tsx/.jsx component file to harvest' },
        into: { type: 'string', description: 'Path to the target .fdn.html document (must already exist)' },
        name: { type: 'string', description: 'Component name override; default is the detected export name (or the file name)' },
        props: { type: 'array', description: 'FdnProp overrides — always win over auto-detected props; required for props the auto-detector cannot classify' },
        sealed: { type: 'boolean', description: 'Force sealed (opaque capsule) mode even if native projection would succeed' },
      },
      required: ['source', 'into'],
    },
    handler: toolImport,
  },
  {
    name: 'foundation_project',
    description:
      'Read a project\'s foundation.json manifest (SPEC 13a-iii: the document index for a directory — the '
      + 'filesystem stays the database, the manifest is the index). Returns the manifest plus, per document, its '
      + 'validate status ("ok" or "N issue(s)") and chain head (or "no chain"). Read-only in MCP for v0 — only '
      + '`action: "list"` is supported; writing a manifest (init/add/scan) is CLI-only: '
      + '`foundation project init|add|list|scan`.',
    inputSchema: {
      type: 'object',
      properties: {
        dir: { type: 'string', description: 'Directory containing foundation.json (default: current working directory)' },
        action: { type: 'string', description: 'Only "list" is supported in v0' },
      },
    },
    handler: toolProject,
  },
]

const TOOLS_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]))

export async function callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const tool = TOOLS_BY_NAME.get(name)
  if (!tool) return fail(`unknown tool "${name}"`)
  try {
    return await tool.handler(args)
  } catch (err) {
    if (err instanceof ToolInputError) return fail(`${name}: ${err.message}`)
    return fail(`${name}: internal error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`)
  }
}
