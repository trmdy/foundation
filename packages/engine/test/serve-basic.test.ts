import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { serveDocument, type ServeHandle } from '../src/serve/index.js'
import { projectDocument } from '../src/project/index.js'
import type { FdnDocument, FdnNode } from '../src/types.js'

function node(partial: Partial<FdnNode> & { id: string; tag: string }): FdnNode {
  return { attrs: {}, style: {}, styleStates: {}, children: [], ...partial }
}

function makeDoc(): FdnDocument {
  return {
    specVersion: '0.0.1-draft',
    title: 'Serve Fixture',
    tokens: { 'color-accent': '#9C6A1C' },
    params: [{ name: 'greeting', type: 'string', default: 'Hello, serve' }],
    data: [],
    lookups: [],
    states: [{ name: 'loud', assignments: { greeting: 'HELLO, SERVE' } }],
    viewports: [],
    matrix: [],
    namedStyles: [],
    components: [],
    body: [
      node({
        id: 'n1',
        tag: 'div',
        text: '{{ param.greeting }}',
        style: { color: 'var(--color-accent)' },
      }),
    ],
  }
}

describe('serveDocument', () => {
  let dir: string
  let filePath: string
  let handle: ServeHandle

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'fdn-serve-'))
    filePath = join(dir, 'fixture.fdn.html')
    writeFileSync(filePath, projectDocument(makeDoc()), 'utf8')
    handle = await serveDocument(filePath, { port: 0 })
  })

  afterEach(async () => {
    await handle.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('binds to an ephemeral port and reports a usable URL', () => {
    expect(handle.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
  })

  it('GET / serves the baked default state plus the live-reload script and state strip', async () => {
    const res = await fetch(handle.url + '/')
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('Hello, serve')
    expect(body).toContain('foundation serve — derived view, source: fixture.fdn.html')
    expect(body).toContain('new EventSource(\'/events\')')
    expect(body).toContain('/?state=loud')
  })

  it('GET /?state=<name> bakes the named state', async () => {
    const res = await fetch(handle.url + '/?state=loud')
    const body = await res.text()
    expect(body).toContain('HELLO, SERVE')
  })

  it('GET /report returns the bake ConformanceReport as JSON', async () => {
    const res = await fetch(handle.url + '/report')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/json')
    const json = await res.json()
    expect(json).toHaveProperty('lines')
    expect(Array.isArray(json.lines)).toBe(true)
  })

  it('GET /source returns the canonical file verbatim as text/plain', async () => {
    const res = await fetch(handle.url + '/source')
    expect(res.headers.get('content-type')).toContain('text/plain')
    const body = await res.text()
    expect(body).toBe(projectDocument(makeDoc()))
  })

  it('unknown route 404s', async () => {
    const res = await fetch(handle.url + '/nope')
    expect(res.status).toBe(404)
  })
})
