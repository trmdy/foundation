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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  bakeDocument,
  createChain,
  loadChain,
  parseDocument,
  projectDocument,
  validateDocument,
} from 'foundation-engine'
import type { ConformanceReport, FdnDocument, FdnNode, FdnViewport, ReportLine } from 'foundation-engine'
// Deep import, not re-exported from the package root (same as commands/freeze.ts) —
// mirrored here rather than imported from commands/freeze.ts because that file
// only exports a CLI entry point (runFreeze), not these two.
import { freezeDocument, verifyFrozen } from 'foundation-engine/src/freeze/index.js'
import { chainPathFor, writeChainInit } from '../commands/chain.js'
import { skeletonDocument } from '../commands/new.js'

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

function fail(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true }
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
  const rewritten = canonical !== read.source
  try {
    writeFileSync(path, canonical, 'utf8')
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
        const author = 'agent:mcp'
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

  const renders = cells.map((cell) => {
    const label = `${cell.state ?? 'default'}--${cell.viewport.name}`
    const pngPath = join(outDir, `${label}.png`)
    writeFileSync(pngPath, cell.png)
    return {
      state: cell.state,
      viewport: cell.viewport,
      pngPath,
      layout: cell.layout,
      conformance: reportPayload(cell.report.lines),
    }
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

  const frozen = freezeDocument(doc, {
    author: 'agent:mcp',
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
  const filePath = path.endsWith('.fdn.html') ? path : `${path}.fdn.html`

  if (existsSync(filePath)) {
    return fail(`refusing to overwrite existing file: ${filePath}`)
  }

  const doc = skeletonDocument(title)
  const check = validateDocument(doc)
  if (!check.valid) {
    return fail(`internal error: generated skeleton failed validation: ${JSON.stringify(check.issues)}`)
  }
  try {
    writeFileSync(filePath, projectDocument(doc), 'utf8')
  } catch (err) {
    return fail(`could not write ${filePath}: ${err instanceof Error ? err.message : String(err)}`)
  }

  let chain: { chainPath: string; head: { hash: string } } | null = null
  const result = writeChainInit(filePath, doc, { author: 'agent:mcp', message: 'init' }, {
    stdout: () => {},
    stderr: () => {},
  })
  if (result) chain = { chainPath: result.chainPath, head: { hash: result.head.hash } }

  return ok({ path: filePath, title, chain })
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
      + 'requested state/viewport). Returns file paths and layout boxes, never image bytes inline — write to '
      + '`outDir` (or an auto-created tmp dir) and inspect the PNG at the returned path.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to a .fdn.html file' },
        state: { type: 'string', description: 'Named state to render' },
        viewport: { type: 'string', description: 'Named viewport to render' },
        outDir: { type: 'string', description: 'Directory to write PNGs and layout JSON into; a tmp dir is used if omitted' },
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
    description: `Scaffold a new, minimal, valid .fdn.html document (one param, one state, one component, a tokens block) and start its chain. ${SUBSET_NOTE}`,
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path (with or without the .fdn.html suffix) for the new document' },
        title: { type: 'string', description: 'Document title; derived from the path if omitted' },
      },
      required: ['path'],
    },
    handler: toolNew,
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
