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
 * Routes:
 *   GET /        baked HTML for ?state=<name> (or defaults), wrapped with an
 *                SSE live-reload client + a floating state-switcher strip.
 *   GET /events  SSE stream; broadcasts a `reload` event on file change.
 *   GET /source  the canonical file, verbatim, text/plain.
 *   GET /report  the bake ConformanceReport (for the same ?state=) as JSON.
 *
 * Bake/parse errors never crash the server or the process — they render as a
 * 500 error page carrying whatever report lines are available.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { readFileSync, watch, type FSWatcher } from 'node:fs'
import { basename } from 'node:path'
import { parseDocument } from '../parse/index.js'
import { bakeDocument } from '../bake/index.js'
import type { ConformanceReport, FdnDocument } from '../types.js'

export interface ServeOptions {
  port?: number
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

function wrapPage(filePath: string, doc: FdnDocument, bakedHtml: string, report: ConformanceReport, activeState: string | null): string {
  const name = basename(filePath)
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${doc.title ? htmlEscape(doc.title) : htmlEscape(name)} — foundation serve</title>
</head>
<body>
${bakedHtml}
<div data-foundation-serve-strip style="position:fixed;bottom:12px;left:12px;right:12px;z-index:2147483647;display:flex;flex-wrap:wrap;gap:10px;align-items:center;padding:8px 12px;background:#1e1e1e;color:#f2f2f2;font:12px/1.4 -apple-system,BlinkMacSystemFont,sans-serif;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.35);">
  <span class="fdn-serve-badge" style="opacity:.75;white-space:nowrap;">foundation serve — derived view, source: ${htmlEscape(name)}</span>
  <span style="display:flex;flex-wrap:wrap;gap:8px;">
      ${stateLinks(doc, activeState)}
  </span>
  <a href="/report" style="color:#9ecbff;">report</a>
  <a href="/source" style="color:#9ecbff;">source</a>
  ${reportBadge(report)}
</div>
<style>
  [data-foundation-serve-strip] a.fdn-serve-link { color:#c9c9c9; text-decoration:none; padding:2px 6px; border-radius:4px; }
  [data-foundation-serve-strip] a.fdn-serve-link.is-active { color:#1e1e1e; background:#f2f2f2; }
  [data-foundation-serve-strip] a.fdn-serve-errors { color:#ff8a8a; margin-left:auto; }
</style>
<script>
(function () {
  try {
    var es = new EventSource('/events');
    es.onmessage = function (ev) {
      if (ev.data === 'reload') location.reload();
    };
  } catch (err) {
    console.warn('foundation serve: live-reload unavailable', err);
  }
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

  function handleGetRoot(req: IncomingMessage, res: ServerResponse, state: string | null): void {
    try {
      const { doc, html, report } = loadAndBake(filePath, state)
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(wrapPage(filePath, doc, html, report, state))
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

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const state = url.searchParams.get('state')

    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'text/plain' })
      res.end('method not allowed')
      return
    }

    if (url.pathname === '/') {
      handleGetRoot(req, res, state)
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

    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('not found')
  })

  try {
    watcher = watch(filePath, { persistent: false }, () => scheduleReload())
  } catch {
    // watch failures (e.g. filesystem that doesn't support it) degrade to
    // "serve without live-reload" rather than crashing the server.
    watcher = undefined
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
