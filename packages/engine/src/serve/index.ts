/**
 * foundation-engine — serve: live-reload dev server with bake (API.md Wave 2).
 *
 * node:http only, zero new deps. Serves the *baked* (derived) view of a
 * `.fdn.html` file — SPEC D4/Q10: the chain/projection is truth, bake output
 * is a derived artifact, and serve exists to look at that artifact live. It
 * intentionally does not depend on portless (PRD Phase A) — it just binds a
 * port and prints the URL; the caller (CLI, or a human) can point portless at
 * it if they want a stable name.
 *
 * HTML routes (untouched by the annotations JSON API below):
 *   GET /        baked HTML for ?state=<name> (or defaults), wrapped with an
 *                SSE live-reload client + a floating state-switcher strip +
 *                the annotation-mode overlay script (see wrapPage/pageScript).
 *   GET /events  SSE stream; broadcasts a `reload` event on file OR chain change.
 *   GET /source  the canonical file, verbatim, text/plain.
 *   GET /report  the bake ConformanceReport (for the same ?state=) as JSON.
 *
 * JSON API (the future Apiary pane's data source — SPEC D2/D4/13a):
 *   GET  /api/doc                     title/specVersion/states/viewports/
 *                                      validate status/chain head.
 *   GET  /api/annotations             the document's annotations (chain is
 *                                      truth when `<file>.chain` exists,
 *                                      else the text's own <fdn-annotations>).
 *   POST /api/annotate                { text, nodeId?|x?,y?, state? } — mints
 *                                      an id, chain-commits an `annotate` op.
 *                                      409 (with a hint) when no chain exists.
 *   POST /api/annotations/<id>/status { status } — chain-commits
 *                                      `set-annotation-status`. 409 when no
 *                                      chain; 404 when the id is unknown.
 *   GET  /api/chain/log               the chain's envelope log, oldest first
 *                                      (`{ exists: false, entries: [] }` when
 *                                      no chain exists yet).
 *
 * Annotation writes go straight through the chain (SPEC D2: the chain is
 * truth) and deliberately do NOT regenerate the `.fdn.html` TEXT — unlike the
 * CLI's `foundation annotate` — so a serve session can never clobber an
 * in-progress hand-edit sitting in the file. GET /api/doc and
 * GET /api/annotations therefore read the live chain doc (not the file)
 * whenever a chain exists; bake (the HTML routes) always reads the file, and
 * bake NEVER renders annotations into design output (they're chain/API-only
 * metadata) — the overlay script below draws them as an independent pin
 * layer positioned over the baked page, never inside it.
 *
 * Bake/parse errors never crash the server or the process — they render as a
 * 500 error page carrying whatever report lines are available.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { existsSync, readFileSync, watch, writeFileSync, type FSWatcher } from 'node:fs'
import { basename } from 'node:path'
import { parseDocument } from '../parse/index.js'
import { bakeDocument } from '../bake/index.js'
import { loadChain, mintAnnotationId } from '../chain/index.js'
import type { FdnChain } from '../chain/index.js'
import { validateDocument } from '../validate/index.js'
import type { ConformanceReport, FdnAnnotation, FdnDocument } from '../types.js'

export interface ServeOptions {
  port?: number
  /** Chain envelope author for annotations written through the JSON API
   *  (SPEC 13a-ii identity rules live in packages/cli, not the engine — the
   *  CLI's `foundation serve` passes its own `defaultAuthor()` through here;
   *  direct engine callers/tests get this generic placeholder instead). */
  author?: string
}

const DEFAULT_SERVE_AUTHOR = 'user:serve'

function chainPathFor(filePath: string): string {
  return `${filePath}.chain`
}

export interface ServeHandle {
  url: string
  close: () => Promise<void>
}

const RELOAD_DEBOUNCE_MS = 80

function htmlEscape(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function readSource(filePath: string): string {
  return readFileSync(filePath, 'utf8')
}

function loadAndBake(filePath: string, state: string | null): {
  source: string
  doc: FdnDocument
  html: string
  report: ConformanceReport
} {
  const source = readSource(filePath)
  const { doc } = parseDocument(source)
  const baked = bakeDocument(doc, state !== null ? { state } : undefined)
  return { source, doc, html: baked.html, report: baked.report }
}

/** Chain is truth when `<file>.chain` exists (SPEC D4) — GET /api/doc and
 *  GET /api/annotations read through it rather than the file, so an
 *  annotation written via POST /api/annotate (which never touches the text)
 *  shows up immediately. Falls back to parsing the file itself otherwise. */
function currentDocState(filePath: string): { doc: FdnDocument; chain: FdnChain | null } {
  const chainPath = chainPathFor(filePath)
  if (existsSync(chainPath)) {
    const chain = loadChain(readFileSync(chainPath))
    return { doc: chain.doc(), chain }
  }
  const { doc } = parseDocument(readSource(filePath))
  return { doc, chain: null }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body, null, 2))
}

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk: Buffer) => {
      data += chunk.toString('utf8')
    })
    req.on('end', () => {
      if (!data.trim()) {
        resolve({})
        return
      }
      try {
        const parsed: unknown = JSON.parse(data)
        resolve(parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {})
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
    req.on('error', reject)
  })
}

function stateLinks(doc: FdnDocument, activeState: string | null): string {
  const items: string[] = []
  const defaultCls = activeState === null ? 'is-active' : ''
  items.push(`<a href="/" class="fdn-serve-link ${defaultCls}">default</a>`)
  for (const s of doc.states) {
    const cls = activeState === s.name ? 'is-active' : ''
    items.push(`<a href="/?state=${encodeURIComponent(s.name)}" class="fdn-serve-link ${cls}">${htmlEscape(s.name)}</a>`)
  }
  return items.join('\n      ')
}

function reportBadge(report: ConformanceReport): string {
  const errors = report.lines.filter((l) => l.severity === 'error').length
  if (errors === 0) return ''
  return `<a href="/report" class="fdn-serve-errors">${errors} error${errors === 1 ? '' : 's'}</a>`
}

function wrapPage(
  filePath: string,
  doc: FdnDocument,
  bakedHtml: string,
  report: ConformanceReport,
  activeState: string | null,
  embed: boolean,
): string {
  const name = basename(filePath)
  // `?embed=1` (apiary-surface-epic.md C3): the Foundation board pane already
  // renders its own state tabs, validate badge, and chain/annotation rail —
  // when it loads this page in its native WebContentsView it does not want a
  // SECOND floating strip duplicating that chrome underneath its own. The
  // strip (and its annotate-mode toggle button) is the only thing suppressed;
  // live-reload and the pin overlay stay live either way, since the pane has
  // no substitute for either yet.
  const strip = embed
    ? ''
    : `<div data-foundation-serve-strip style="position:fixed;bottom:12px;left:12px;right:12px;z-index:2147483647;display:flex;flex-wrap:wrap;gap:10px;align-items:center;padding:8px 12px;background:#1e1e1e;color:#f2f2f2;font:12px/1.4 -apple-system,BlinkMacSystemFont,sans-serif;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.35);">
  <span class="fdn-serve-badge" style="opacity:.75;white-space:nowrap;">foundation serve — derived view, source: ${htmlEscape(name)}</span>
  <span style="display:flex;flex-wrap:wrap;gap:8px;">
      ${stateLinks(doc, activeState)}
  </span>
  <a href="/report" style="color:#9ecbff;">report</a>
  <a href="/source" style="color:#9ecbff;">source</a>
  <button type="button" data-fdn-annotate-toggle aria-pressed="false" style="border:1px solid #555;background:transparent;color:#f2f2f2;border-radius:4px;padding:2px 8px;font:inherit;cursor:pointer;">Annotate</button>
  ${reportBadge(report)}
</div>`
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${doc.title ? htmlEscape(doc.title) : htmlEscape(name)} — foundation serve</title>
</head>
<body>
${bakedHtml}
${strip}
<style>
  [data-foundation-serve-strip] a.fdn-serve-link { color:#c9c9c9; text-decoration:none; padding:2px 6px; border-radius:4px; }
  [data-foundation-serve-strip] a.fdn-serve-link.is-active { color:#1e1e1e; background:#f2f2f2; }
  [data-foundation-serve-strip] a.fdn-serve-errors { color:#ff8a8a; margin-left:auto; }
  [data-foundation-serve-strip] [data-fdn-annotate-toggle][aria-pressed="true"] { background:#e8a23d; color:#1e1e1e; border-color:#e8a23d; }
  [data-fdn-pin] { position:absolute; z-index:2147483646; min-width:18px; height:18px; padding:0 4px; border-radius:9px; background:#e8a23d; color:#1e1e1e; font:11px/18px -apple-system,BlinkMacSystemFont,sans-serif; font-weight:600; text-align:center; box-shadow:0 1px 4px rgba(0,0,0,.4); cursor:default; }
</style>
<script>
(function () {
  try {
    var es = new EventSource('/events');
    es.onmessage = function (ev) {
      // Chain writes (e.g. annotate) broadcast a reload too (see serve/index.ts's
      // chain-file watcher + explicit scheduleReload() after each API write) — a
      // full reload is simplest/correct here since renderPins() below always
      // re-fetches on load, and annotation writes never touch the baked HTML.
      if (ev.data === 'reload') location.reload();
    };
  } catch (err) {
    console.warn('foundation serve: live-reload unavailable', err);
  }

  // ——— annotation mode: toggle + click-to-annotate + numbered pin overlay
  //     (deliberately minimal/no framework — see task brief) ———
  var CURRENT_STATE = new URLSearchParams(location.search).get('state');
  var annotateMode = false;
  var toggleBtn = document.querySelector('[data-fdn-annotate-toggle]');

  function setAnnotateMode(on) {
    annotateMode = on;
    if (toggleBtn) {
      toggleBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
      toggleBtn.textContent = on ? 'Annotating… (click an element, Esc to cancel)' : 'Annotate';
    }
    document.body.style.cursor = on ? 'crosshair' : '';
  }

  if (toggleBtn) {
    toggleBtn.addEventListener('click', function () { setAnnotateMode(!annotateMode); });
  }
  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape' && annotateMode) setAnnotateMode(false);
  });

  document.addEventListener('click', function (ev) {
    if (!annotateMode) return;
    var el = ev.target && ev.target.closest ? ev.target.closest('[data-fdn-id]') : null;
    if (!el) return;
    ev.preventDefault();
    ev.stopPropagation();
    var text = window.prompt('Annotation text:');
    setAnnotateMode(false);
    if (!text) return;
    var payload = { text: text, nodeId: el.getAttribute('data-fdn-id') };
    if (CURRENT_STATE) payload.state = CURRENT_STATE;
    fetch('/api/annotate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).then(function (res) {
      if (res.ok) return; // the server's own chain-write broadcasts a reload
      return res.json().then(function (body) {
        window.alert('annotate failed: ' + (body && body.error ? body.error : res.status));
      });
    }).catch(function (err) {
      window.alert('annotate failed: ' + err);
    });
  }, true);

  function renderPins() {
    document.querySelectorAll('[data-fdn-pin]').forEach(function (p) { p.remove(); });
    fetch('/api/annotations').then(function (r) { return r.json(); }).then(function (body) {
      var open = (body.annotations || []).filter(function (a) { return a.status === 'open'; });
      open.sort(function (a, b) { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; });
      open.forEach(function (a, i) {
        var x, y;
        if (a.nodeId) {
          var target = document.querySelector('[data-fdn-id="' + a.nodeId + '"]');
          if (!target) return; // node not present in this state/viewport bake
          var rect = target.getBoundingClientRect();
          x = rect.left + window.scrollX - 8;
          y = rect.top + window.scrollY - 8;
        } else {
          x = (typeof a.x === 'number' ? a.x : 0) - 8;
          y = (typeof a.y === 'number' ? a.y : 0) - 8;
        }
        var pin = document.createElement('div');
        pin.setAttribute('data-fdn-pin', a.id);
        pin.title = a.text;
        pin.textContent = String(i + 1);
        pin.style.left = x + 'px';
        pin.style.top = y + 'px';
        document.body.appendChild(pin);
      });
    }).catch(function (err) {
      console.warn('foundation serve: could not load annotations', err);
    });
  }
  renderPins();
})();
</script>
</body>
</html>
`
}

function errorPage(message: string, report?: ConformanceReport): string {
  const lines = report
    ? report.lines
        .map((l) => `<li><code>${htmlEscape(l.severity)}</code> <code>${htmlEscape(l.code)}</code> — ${htmlEscape(l.message)}</li>`)
        .join('\n')
    : ''
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>foundation serve — error</title></head>
<body style="font:14px/1.5 -apple-system,BlinkMacSystemFont,sans-serif;padding:2rem;max-width:60rem;margin:0 auto;">
  <h1 style="color:#b02a2a;">foundation serve — bake failed</h1>
  <pre style="white-space:pre-wrap;background:#f5f4f1;padding:1rem;border-radius:6px;">${htmlEscape(message)}</pre>
  ${lines ? `<h2>Report</h2><ul>${lines}</ul>` : ''}
</body>
</html>
`
}

export async function serveDocument(filePath: string, opts?: ServeOptions): Promise<ServeHandle> {
  const clients = new Set<ServerResponse>()
  let watcher: FSWatcher | undefined
  let debounceTimer: NodeJS.Timeout | undefined

  function broadcastReload(): void {
    for (const res of clients) {
      try {
        res.write('data: reload\n\n')
      } catch {
        // client already gone; it will be cleaned up by its own 'close' handler
      }
    }
  }

  function scheduleReload(): void {
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(broadcastReload, RELOAD_DEBOUNCE_MS)
  }

  function handleGetRoot(req: IncomingMessage, res: ServerResponse, state: string | null, embed: boolean): void {
    try {
      const { doc, html, report } = loadAndBake(filePath, state)
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(wrapPage(filePath, doc, html, report, state, embed))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(errorPage(err instanceof Error ? (err.stack ?? err.message) : String(err)))
    }
  }

  function handleGetReport(req: IncomingMessage, res: ServerResponse, state: string | null): void {
    try {
      const { report } = loadAndBake(filePath, state)
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(report, null, 2))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }, null, 2))
    }
  }

  function handleGetSource(req: IncomingMessage, res: ServerResponse): void {
    try {
      const source = readSource(filePath)
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end(source)
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end(`could not read ${filePath}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  function handleEvents(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    })
    res.write(': connected\n\n')
    clients.add(res)
    req.on('close', () => {
      clients.delete(res)
    })
  }

  // ——— JSON API (the future Apiary pane's data source) ———

  function handleApiDoc(req: IncomingMessage, res: ServerResponse): void {
    try {
      const { doc, chain } = currentDocState(filePath)
      const validation = validateDocument(doc)
      sendJson(res, 200, {
        path: filePath,
        title: doc.title ?? null,
        specVersion: doc.specVersion,
        states: doc.states.map((s) => s.name),
        viewports: doc.viewports.map((v) => ({ name: v.name, width: v.width, height: v.height })),
        validate: { valid: validation.valid, issueCount: validation.issues.length },
        chain: chain ? { exists: true, head: chain.head() } : { exists: false },
      })
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
    }
  }

  function handleApiAnnotations(req: IncomingMessage, res: ServerResponse): void {
    try {
      const { doc } = currentDocState(filePath)
      sendJson(res, 200, { annotations: doc.annotations })
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
    }
  }

  function handleApiChainLog(req: IncomingMessage, res: ServerResponse): void {
    const chainPath = chainPathFor(filePath)
    if (!existsSync(chainPath)) {
      sendJson(res, 200, { exists: false, entries: [] })
      return
    }
    try {
      const chain = loadChain(readFileSync(chainPath))
      sendJson(res, 200, { exists: true, entries: chain.log() })
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
    }
  }

  /** Loads the chain, requiring it to exist first — the shared 409 guard for
   *  both annotation write routes (SPEC D2: nowhere durable to write an
   *  annotation without a chain). Returns null (having already responded)
   *  when there is no chain. */
  function requireChainOr409(res: ServerResponse): FdnChain | null {
    const chainPath = chainPathFor(filePath)
    if (!existsSync(chainPath)) {
      sendJson(res, 409, {
        error: 'no chain yet',
        hint: `run \`foundation chain init ${filePath}\` first — annotations need somewhere durable to live`,
      })
      return null
    }
    return loadChain(readFileSync(chainPath), { actor: opts?.author ?? DEFAULT_SERVE_AUTHOR })
  }

  function saveChainAndBroadcast(chain: FdnChain): void {
    writeFileSync(chainPathFor(filePath), chain.save())
    // Chain writes never touch the .fdn.html text (see module doc), so the
    // plain file watcher below would never fire for these — broadcast
    // directly (SPEC-required: "SSE reload also fires on chain changes").
    scheduleReload()
  }

  async function handleApiAnnotatePost(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: Record<string, unknown>
    try {
      body = await readJsonBody(req)
    } catch {
      sendJson(res, 400, { error: 'invalid JSON body' })
      return
    }
    const text = typeof body.text === 'string' ? body.text : undefined
    if (!text) {
      sendJson(res, 400, { error: '"text" is required' })
      return
    }
    const nodeId = typeof body.nodeId === 'string' ? body.nodeId : undefined
    const x = typeof body.x === 'number' ? body.x : undefined
    const y = typeof body.y === 'number' ? body.y : undefined
    const state = typeof body.state === 'string' ? body.state : undefined
    if (nodeId !== undefined && (x !== undefined || y !== undefined)) {
      sendJson(res, 400, { error: 'pass "nodeId" OR "x"/"y", not both' })
      return
    }

    try {
      const chain = requireChainOr409(res)
      if (!chain) return
      const id = mintAnnotationId(chain.doc().annotations)
      const annotation: FdnAnnotation = { id, text, status: 'open' }
      if (nodeId !== undefined) annotation.nodeId = nodeId
      if (x !== undefined) annotation.x = x
      if (y !== undefined) annotation.y = y
      if (state !== undefined) annotation.state = state
      chain.apply({ author: opts?.author ?? DEFAULT_SERVE_AUTHOR, message: `annotate: ${text}` }, [{ op: 'annotate', annotation }])
      saveChainAndBroadcast(chain)
      sendJson(res, 200, { annotation })
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
    }
  }

  async function handleApiAnnotationStatusPost(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
    let body: Record<string, unknown>
    try {
      body = await readJsonBody(req)
    } catch {
      sendJson(res, 400, { error: 'invalid JSON body' })
      return
    }
    const status = body.status
    if (status !== 'open' && status !== 'resolved' && status !== 'wontfix') {
      sendJson(res, 400, { error: '"status" must be one of "open", "resolved", "wontfix"' })
      return
    }

    try {
      const chain = requireChainOr409(res)
      if (!chain) return
      if (!chain.doc().annotations.some((a) => a.id === id)) {
        sendJson(res, 404, { error: `no annotation "${id}"` })
        return
      }
      chain.apply({ author: opts?.author ?? DEFAULT_SERVE_AUTHOR, message: `annotation ${id}: mark ${status}` }, [
        { op: 'set-annotation-status', id, status },
      ])
      saveChainAndBroadcast(chain)
      sendJson(res, 200, { id, status })
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
    }
  }

  const ANNOTATION_STATUS_ROUTE = /^\/api\/annotations\/([^/]+)\/status$/

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const state = url.searchParams.get('state')

    if (req.method === 'GET') {
      if (url.pathname === '/') {
        handleGetRoot(req, res, state, url.searchParams.get('embed') === '1')
        return
      }
      if (url.pathname === '/events') {
        handleEvents(req, res)
        return
      }
      if (url.pathname === '/source') {
        handleGetSource(req, res)
        return
      }
      if (url.pathname === '/report') {
        handleGetReport(req, res, state)
        return
      }
      if (url.pathname === '/api/doc') {
        handleApiDoc(req, res)
        return
      }
      if (url.pathname === '/api/annotations') {
        handleApiAnnotations(req, res)
        return
      }
      if (url.pathname === '/api/chain/log') {
        handleApiChainLog(req, res)
        return
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('not found')
      return
    }

    if (req.method === 'POST') {
      if (url.pathname === '/api/annotate') {
        void handleApiAnnotatePost(req, res)
        return
      }
      const statusMatch = ANNOTATION_STATUS_ROUTE.exec(url.pathname)
      if (statusMatch) {
        void handleApiAnnotationStatusPost(req, res, decodeURIComponent(statusMatch[1] as string))
        return
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('not found')
      return
    }

    res.writeHead(405, { 'Content-Type': 'text/plain' })
    res.end('method not allowed')
  })

  try {
    watcher = watch(filePath, { persistent: false }, () => scheduleReload())
  } catch {
    // watch failures (e.g. filesystem that doesn't support it) degrade to
    // "serve without live-reload" rather than crashing the server.
    watcher = undefined
  }

  // Best-effort: also reload connected clients when the CHAIN changes out
  // from under this process (e.g. `foundation annotate`/`chain merge` run in
  // a separate terminal while serve is running) — only attached if the chain
  // already exists at boot; a chain created later while serving is a
  // recorded gap, not fixed here (annotate writes made THROUGH this server's
  // own API already call scheduleReload() directly regardless, see
  // saveChainAndBroadcast, so the common "annotate via the served page" path
  // never depends on this watcher at all).
  let chainWatcher: FSWatcher | undefined
  const chainPath = chainPathFor(filePath)
  if (existsSync(chainPath)) {
    try {
      chainWatcher = watch(chainPath, { persistent: false }, () => scheduleReload())
    } catch {
      chainWatcher = undefined
    }
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(opts?.port ?? 0, '127.0.0.1', () => resolve())
  })

  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : (opts?.port ?? 0)
  const url = `http://127.0.0.1:${port}`

  async function close(): Promise<void> {
    if (debounceTimer) clearTimeout(debounceTimer)
    watcher?.close()
    chainWatcher?.close()
    for (const res of clients) {
      try {
        res.end()
      } catch {
        // ignore — tearing down anyway
      }
    }
    clients.clear()
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()))
    })
  }

  return { url, close }
}
