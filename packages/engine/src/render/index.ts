/**
 * render/index.ts — renderHtml + renderDocument (API.md "Wave 2 signatures").
 *
 * Ports spikes/render/run.ts's determinism setup verbatim: the Chromium
 * context options, the frozen-clock addInitScript, and waiting on
 * document.fonts.ready before capture (spikes/render/RESULTS.md,
 * CROSS-MACHINE.md). See docs/SPEC.md §5 (RESOLVED 2026-07-31) for the
 * contract this implements: layout identity is the hard cross-machine
 * guarantee; pixels are byte-identical per (platform, pinned browser) only,
 * with linux-x86_64 headless as the reference platform for canonical
 * pixels.
 *
 * renderDocument composes bake/index.ts's bakeDocument per matrix cell,
 * against one shared (lazily-launched) browser instance from ./browser.js.
 */

import type { Browser, BrowserContextOptions } from 'playwright'
import { bakeDocument, emitHtml } from '../bake/index.js'
import { getBrowser } from './browser.js'
import type {
  ConformanceReport,
  FdnDocument,
  FdnNode,
  FdnViewport,
  NodeId,
  ReportLine,
  StateStyleKey,
} from '../types.js'

export interface RenderConfig {
  viewport: FdnViewport
  deviceScaleFactor?: number
}

export interface LayoutEntry {
  id: string
  x: number
  y: number
  width: number
  height: number
}

// Frozen wall clock — every context's Date/performance.now() reports this
// instant, regardless of when the render actually runs. Ported verbatim
// (same epoch) from spikes/render/run.ts.
const FROZEN_EPOCH_MS = Date.parse('2026-07-31T12:00:00.000Z')

// Ported verbatim from spikes/render/run.ts's CONTEXT_OPTIONS.
const CONTEXT_OPTIONS: BrowserContextOptions = {
  deviceScaleFactor: 1,
  colorScheme: 'light',
  reducedMotion: 'reduce',
  forcedColors: 'none',
  timezoneId: 'UTC',
  locale: 'en-US',
}

// Ported verbatim from spikes/render/run.ts's captureOnce() addInitScript
// body — a Proxy over Date that freezes no-arg `new Date()`/`Date.now()` to
// FROZEN_EPOCH_MS while letting explicit-arg constructions pass through, plus
// a frozen performance.now(). Must stay a standalone function: Playwright
// serializes it into the page and re-binds `epoch` as its sole argument.
function freezeClock(epoch: number): void {
  const RealDate = Date

  const FrozenDate = new Proxy(RealDate, {
    construct(target, args: unknown[]) {
      return args.length === 0 ? new target(epoch) : Reflect.construct(target, args)
    },
    apply(target) {
      return Reflect.apply(target, undefined, [])
    },
  }) as unknown as DateConstructor
  FrozenDate.now = () => epoch

  window.Date = FrozenDate

  Object.defineProperty(window.performance, 'now', {
    value: () => 0,
    configurable: true,
  })
}

interface Capture {
  png: Uint8Array
  layout: LayoutEntry[]
}

async function captureHtml(browser: Browser, html: string, config: RenderConfig): Promise<Capture> {
  const context = await browser.newContext({
    ...CONTEXT_OPTIONS,
    deviceScaleFactor: config.deviceScaleFactor ?? 1,
    viewport: { width: config.viewport.width, height: config.viewport.height },
  })
  try {
    await context.addInitScript(freezeClock, FROZEN_EPOCH_MS)
    const page = await context.newPage()
    await page.setContent(html, { waitUntil: 'load' })
    // Wait for any embedded/declared @font-face to finish loading/laying out
    // before capture — otherwise a fallback-then-swap frame could
    // theoretically be composited first (ported from the spike).
    await page.evaluate(() => document.fonts.ready)

    const png = await page.screenshot({ type: 'png', fullPage: true })

    // Layout report: every [data-fdn-id] or [id] element, keyed by that
    // element's own id attribute (data-fdn-id preferred when both are
    // present) — never by array index, so reports compare cleanly run to
    // run and across machines.
    const layout = await page.$$eval('[data-fdn-id], [id]', (elements) =>
      elements.map((el) => {
        const r = el.getBoundingClientRect()
        return {
          id: el.getAttribute('data-fdn-id') ?? el.id,
          x: r.x,
          y: r.y,
          width: r.width,
          height: r.height,
        }
      }),
    )
    layout.sort((a, b) => a.id.localeCompare(b.id))

    return { png, layout }
  } finally {
    await context.close()
  }
}

export async function renderHtml(html: string, config: RenderConfig): Promise<{ png: Uint8Array; layout: LayoutEntry[] }> {
  const browser = await getBrowser()
  return captureHtml(browser, html, config)
}

// ——— renderDocument ———

const DEFAULT_VIEWPORT: FdnViewport = { name: 'default', width: 1440, height: 900 }

interface Cell {
  state: string | null
  viewport: FdnViewport
  /** Cell-specific issues discovered while resolving the matrix (e.g. an
   *  undeclared viewport name) — merged into the cell's report alongside
   *  the bake's own ConformanceReport. */
  preReport?: ReportLine[]
}

function resolveCells(doc: FdnDocument, opts?: { state?: string; viewport?: string }): Cell[] {
  if (doc.matrix.length > 0) {
    return doc.matrix
      .filter(
        (m) =>
          (opts?.state === undefined || m.state === opts.state) &&
          (opts?.viewport === undefined || m.viewport === opts.viewport),
      )
      .map((m): Cell => {
        const vp = doc.viewports.find((v) => v.name === m.viewport)
        if (vp) return { state: m.state, viewport: vp }
        return {
          state: m.state,
          viewport: { name: m.viewport, width: 1440, height: 900 },
          preReport: [
            {
              code: 'unknown-viewport',
              severity: 'error',
              message: `matrix references viewport "${m.viewport}", which is not declared; rendered at a 1440x900 fallback`,
            },
          ],
        }
      })
  }

  // No matrix declared: default (unnamed) state at each declared viewport,
  // or a single 1440x900 fallback viewport if none are declared either.
  const viewports = doc.viewports.length > 0 ? doc.viewports : [DEFAULT_VIEWPORT]
  const stateName = opts?.state ?? null
  return viewports
    .filter((v) => opts?.viewport === undefined || v.name === opts.viewport)
    .map((v): Cell => ({ state: stateName, viewport: v }))
}

// bake/index.ts's emitHtml does not serialize `data-fdn-id` on baked
// elements — only project/index.ts's canonical .fdn.html serializer does
// (API.md: "Stable node ids serialize as data-fdn-id" is a project-module
// rule). renderDocument needs that attribute for the layout report's key, so
// it re-serializes the already-baked tree through bake's own *unmodified*
// exported emitHtml() after injecting the attribute onto a clone — this
// composes bake's output rather than duplicating/reimplementing the
// serializer. Reported as a finding: bake's derived HTML arguably should
// carry data-fdn-id itself (useful beyond render, e.g. browser devtools on a
// bake preview), but src/bake/ is out of this module's scope to edit.
function injectFdnIds(nodes: FdnNode[]): FdnNode[] {
  return nodes.map((n) => ({
    ...n,
    attrs: { ...n.attrs, 'data-fdn-id': n.id },
    children: injectFdnIds(n.children),
  }))
}

function splitFontFamilyList(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim().replace(/^["']|["']$/g, '').toLowerCase())
    .filter((s) => s.length > 0)
}

// Heuristic scan for families bound via @font-face in the rendered HTML.
// bakeDocument/emitHtml never emit @font-face today, and parse/index.ts
// actively drops non-:root <style> rules on ingestion (Foundation has no
// font-embedding facility yet — a finding, see final report) — so this set
// is empty for every document this engine can currently produce. The scan
// works against the HTML text itself (not FdnDocument) so it keeps working
// unchanged if/when a future bake gains @font-face support.
function collectEmbeddedFontFamilies(html: string): Set<string> {
  const families = new Set<string>()
  const fontFaceRe = /@font-face\s*\{([^}]*)\}/gi
  let m: RegExpExecArray | null
  while ((m = fontFaceRe.exec(html)) !== null) {
    const block = m[1] ?? ''
    const famMatch = /font-family\s*:\s*([^;]+);?/i.exec(block)
    if (!famMatch) continue
    for (const name of splitFontFamilyList(famMatch[1] as string)) families.add(name)
  }
  return families
}

/** Resolves a `font-family` value through at most one `var(--token)` hop
 *  against doc.tokens (bake leaves var() references intact — CSS custom
 *  property resolution happens in the browser, not at bake time). Values
 *  that aren't a bare `var(--x)` reference are returned unchanged. */
function resolveFontFamilyValue(raw: string, doc: FdnDocument): string {
  const varMatch = /^var\(\s*--([A-Za-z0-9_-]+)\s*\)$/.exec(raw.trim())
  if (varMatch) {
    const tokenValue = doc.tokens[varMatch[1] as string]
    if (tokenValue !== undefined) return tokenValue
  }
  return raw
}

function collectFontFamilyDeclarations(tree: FdnNode[]): { nodeId: NodeId; value: string }[] {
  const out: { nodeId: NodeId; value: string }[] = []
  const visit = (nodes: FdnNode[]): void => {
    for (const n of nodes) {
      const own = n.style['font-family']
      if (own) out.push({ nodeId: n.id, value: own })
      for (const key of Object.keys(n.styleStates) as StateStyleKey[]) {
        const value = n.styleStates[key]?.['font-family']
        if (value) out.push({ nodeId: n.id, value })
      }
      visit(n.children)
    }
  }
  visit(tree)
  return out
}

/**
 * Render-side conformance check (SPEC §5's bundled-font boundary — not part
 * of bakeDocument's own audit, since it's a render-time property, not a
 * template one). Warns when a baked node's font-family resolves (through at
 * most one var(--token) hop) to a primary family that is not bound by an
 * @font-face declaration in the rendered HTML — i.e. it will be resolved
 * against the OS font stack, which SPEC §5/CROSS-MACHINE.md found to be the
 * sole source of cross-machine layout divergence.
 *
 * Heuristic, by design: only the *first* family in a comma-separated list is
 * checked (CSS font matching tries each family left to right, and the first
 * is what determines geometry when present), and only one var() hop is
 * resolved. Both are documented limits, not bugs — a fuller check would need
 * an actual font-embedding facility in FdnDocument, which does not exist
 * yet (finding, see final report).
 */
function detectSystemFontStackLines(doc: FdnDocument, tree: FdnNode[], html: string): ReportLine[] {
  const embedded = collectEmbeddedFontFamilies(html)
  const seen = new Set<string>()
  const lines: ReportLine[] = []
  for (const decl of collectFontFamilyDeclarations(tree)) {
    const resolved = resolveFontFamilyValue(decl.value, doc)
    const primary = splitFontFamilyList(resolved)[0]
    if (primary === undefined || embedded.has(primary)) continue
    const key = `${decl.nodeId} ${decl.value}`
    if (seen.has(key)) continue
    seen.add(key)
    lines.push({
      code: 'system-font-stack',
      severity: 'warning',
      message: `font-family "${decl.value}" resolves to primary family "${primary}", which is not bound to an embedded @font-face; render-time text will resolve through the OS font stack and is not guaranteed layout-identical across machines (SPEC §5 bundled-font boundary)`,
      nodeId: decl.nodeId,
      detail: { property: 'font-family', declaredValue: decl.value, resolvedPrimaryFamily: primary },
    })
  }
  return lines
}

export async function renderDocument(
  doc: FdnDocument,
  opts?: { state?: string; viewport?: string },
): Promise<
  Array<{ state: string | null; viewport: FdnViewport; png: Uint8Array; layout: LayoutEntry[]; report: ConformanceReport }>
> {
  const cells = resolveCells(doc, opts)
  const browser = await getBrowser()
  const results: Array<{
    state: string | null
    viewport: FdnViewport
    png: Uint8Array
    layout: LayoutEntry[]
    report: ConformanceReport
  }> = []

  // Cells render sequentially against the one shared browser instance:
  // Playwright contexts are cheap and isolated per cell, but the browser
  // process itself (browser.ts) is launched once, not per cell.
  for (const cell of cells) {
    // eslint-disable-next-line no-await-in-loop -- intentional: one shared browser, sequential contexts
    const baked = bakeDocument(doc, cell.state !== null ? { state: cell.state } : undefined)
    const html = emitHtml(doc, injectFdnIds(baked.tree))
    const fontLines = detectSystemFontStackLines(doc, baked.tree, html)
    // eslint-disable-next-line no-await-in-loop -- see above
    const capture = await captureHtml(browser, html, { viewport: cell.viewport })
    results.push({
      state: cell.state,
      viewport: cell.viewport,
      png: capture.png,
      layout: capture.layout,
      report: { lines: [...(cell.preReport ?? []), ...baked.report.lines, ...fontLines] },
    })
  }

  return results
}
