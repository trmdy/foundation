import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { serveDocument, type ServeHandle } from '../src/serve/index.js'
import { projectDocument } from '../src/project/index.js'
import { createChain, loadChain } from '../src/chain/index.js'
import type { FdnDocument, FdnNode } from '../src/types.js'

function node(partial: Partial<FdnNode> & { id: string; tag: string }): FdnNode {
  return { attrs: {}, style: {}, styleStates: {}, children: [], ...partial }
}

function makeDoc(): FdnDocument {
  return {
    specVersion: '0.0.1-draft',
    title: 'Serve API Fixture',
    tokens: {},
    params: [],
    data: [],
    lookups: [],
    states: [{ name: 'loud', assignments: {} }],
    viewports: [],
    matrix: [],
    namedStyles: [],
    components: [],
    annotations: [],
    body: [node({ id: 'n1', tag: 'div', text: 'hello', attrs: {} })],
  }
}

async function waitForSse(stream: ReadableStream<Uint8Array>, timeoutMs: number): Promise<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  const timer = setTimeout(() => {
    reader.cancel().catch(() => {})
  }, timeoutMs)
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      if (buf.includes('data: reload')) break
    }
  } catch {
    // cancelled by the timeout above
  } finally {
    clearTimeout(timer)
    await reader.cancel().catch(() => {})
  }
  return buf
}

describe('serveDocument: JSON API (SPEC D2/D4/13a)', () => {
  let dir: string
  let filePath: string
  let chainPath: string
  let handle: ServeHandle

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'fdn-serve-api-'))
    filePath = join(dir, 'fixture.fdn.html')
    chainPath = `${filePath}.chain`
    writeFileSync(filePath, projectDocument(makeDoc()), 'utf8')
    handle = await serveDocument(filePath, { port: 0, author: 'user:test' })
  })

  afterEach(async () => {
    await handle.close()
    rmSync(dir, { recursive: true, force: true })
  })

  describe('GET /api/doc', () => {
    it('reports title, states, viewports, validate status, and chain:{exists:false} when there is no chain yet', async () => {
      const res = await fetch(handle.url + '/api/doc')
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.title).toBe('Serve API Fixture')
      expect(body.states).toEqual(['loud'])
      expect(Array.isArray(body.viewports)).toBe(true)
      expect(body.validate.valid).toBe(true)
      expect(body.chain).toEqual({ exists: false })
    })

    it('reports the chain head once a chain exists', async () => {
      const chain = createChain(makeDoc(), { author: 'user:test', message: 'init' })
      writeFileSync(chainPath, chain.save())
      const res = await fetch(handle.url + '/api/doc')
      const body = await res.json()
      expect(body.chain.exists).toBe(true)
      expect(body.chain.head.hash).toBe(chain.head().hash)
    })
  })

  describe('GET /api/annotations', () => {
    it('is empty for a fresh document with no chain', async () => {
      const res = await fetch(handle.url + '/api/annotations')
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.annotations).toEqual([])
    })
  })

  describe('GET /api/chain/log', () => {
    it('reports {exists:false, entries:[]} with no chain', async () => {
      const res = await fetch(handle.url + '/api/chain/log')
      const body = await res.json()
      expect(body).toEqual({ exists: false, entries: [] })
    })

    it('reports the envelope log once a chain exists', async () => {
      const chain = createChain(makeDoc(), { author: 'user:test', message: 'init' })
      writeFileSync(chainPath, chain.save())
      const res = await fetch(handle.url + '/api/chain/log')
      const body = await res.json()
      expect(body.exists).toBe(true)
      expect(body.entries).toHaveLength(1)
      expect(body.entries[0].message).toBe('init')
    })
  })

  describe('POST /api/annotate', () => {
    it('returns 409 with a hint when no chain exists yet', async () => {
      const res = await fetch(handle.url + '/api/annotate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'fix this' }),
      })
      expect(res.status).toBe(409)
      const body = await res.json()
      expect(body.error).toBeTruthy()
      expect(body.hint).toContain('chain init')
    })

    it('mints an id and chain-commits when a chain exists, writing <file>.chain but NOT the .fdn.html text', async () => {
      const chain = createChain(makeDoc(), { author: 'user:test', message: 'init' })
      writeFileSync(chainPath, chain.save())
      const sourceBefore = readFileSync(filePath, 'utf8')

      const res = await fetch(handle.url + '/api/annotate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'padding looks off', nodeId: 'n1', state: 'loud' }),
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.annotation).toMatchObject({ text: 'padding looks off', nodeId: 'n1', state: 'loud', status: 'open' })
      expect(typeof body.annotation.id).toBe('string')

      // text file is untouched (chain is truth; serve never regenerates it)
      expect(readFileSync(filePath, 'utf8')).toBe(sourceBefore)

      // but the chain file now has the annotation, and GET /api/annotations sees it
      const reloaded = loadChain(readFileSync(chainPath))
      expect(reloaded.doc().annotations).toHaveLength(1)

      const annotationsRes = await fetch(handle.url + '/api/annotations')
      const annotationsBody = await annotationsRes.json()
      expect(annotationsBody.annotations).toHaveLength(1)
      expect(annotationsBody.annotations[0].text).toBe('padding looks off')
    })

    it('rejects a request missing "text" with 400', async () => {
      const chain = createChain(makeDoc(), { author: 'user:test', message: 'init' })
      writeFileSync(chainPath, chain.save())
      const res = await fetch(handle.url + '/api/annotate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nodeId: 'n1' }),
      })
      expect(res.status).toBe(400)
    })

    it('rejects both nodeId and x/y at once with 400', async () => {
      const chain = createChain(makeDoc(), { author: 'user:test', message: 'init' })
      writeFileSync(chainPath, chain.save())
      const res = await fetch(handle.url + '/api/annotate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'x', nodeId: 'n1', x: 1, y: 2 }),
      })
      expect(res.status).toBe(400)
    })

    it('broadcasts an SSE reload event on a successful annotate (chain changes reload too)', async () => {
      const chain = createChain(makeDoc(), { author: 'user:test', message: 'init' })
      writeFileSync(chainPath, chain.save())

      const sse = await fetch(handle.url + '/events')
      await new Promise((r) => setTimeout(r, 30))

      const post = fetch(handle.url + '/api/annotate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'trigger reload', x: 1, y: 2 }),
      })
      const message = await waitForSse(sse.body as ReadableStream<Uint8Array>, 3000)
      await post
      expect(message).toContain('data: reload')
    }, 10000)
  })

  describe('POST /api/annotations/<id>/status', () => {
    it('returns 409 with no chain', async () => {
      const res = await fetch(handle.url + '/api/annotations/a1/status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'resolved' }),
      })
      expect(res.status).toBe(409)
    })

    it('returns 404 for an unknown annotation id once a chain exists', async () => {
      const chain = createChain(makeDoc(), { author: 'user:test', message: 'init' })
      writeFileSync(chainPath, chain.save())
      const res = await fetch(handle.url + '/api/annotations/does-not-exist/status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'resolved' }),
      })
      expect(res.status).toBe(404)
    })

    it('marks an existing annotation resolved and it is reflected in GET /api/annotations', async () => {
      const chain = createChain(makeDoc(), { author: 'user:test', message: 'init' })
      chain.apply({ author: 'user:test', message: 'annotate' }, [
        { op: 'annotate', annotation: { id: 'a1', text: 'fix this', nodeId: 'n1', status: 'open' } },
      ])
      writeFileSync(chainPath, chain.save())

      const res = await fetch(handle.url + '/api/annotations/a1/status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'resolved' }),
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toEqual({ id: 'a1', status: 'resolved' })

      const annotationsRes = await fetch(handle.url + '/api/annotations')
      const annotationsBody = await annotationsRes.json()
      expect(annotationsBody.annotations[0].status).toBe('resolved')
    })

    it('rejects an invalid status value with 400', async () => {
      const chain = createChain(makeDoc(), { author: 'user:test', message: 'init' })
      chain.apply({ author: 'user:test', message: 'annotate' }, [
        { op: 'annotate', annotation: { id: 'a1', text: 'fix this', status: 'open' } },
      ])
      writeFileSync(chainPath, chain.save())
      const res = await fetch(handle.url + '/api/annotations/a1/status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'not-a-real-status' }),
      })
      expect(res.status).toBe(400)
    })
  })

  describe('the served page', () => {
    it('GET / still serves the plain HTML routes untouched, now with an Annotate toggle button', async () => {
      const res = await fetch(handle.url + '/')
      const body = await res.text()
      expect(body).toContain('data-fdn-annotate-toggle')
      expect(body).toContain("fetch('/api/annotations')")
    })
  })
})

describe('serveDocument: chain file existence sanity', () => {
  it('chainPath convention is <file>.chain, matching the CLI', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fdn-serve-api-chainpath-'))
    const filePath = join(dir, 'fixture.fdn.html')
    writeFileSync(filePath, projectDocument(makeDoc()), 'utf8')
    const handle = await serveDocument(filePath, { port: 0 })
    try {
      const chain = createChain(makeDoc(), { author: 'user:x', message: 'init' })
      writeFileSync(`${filePath}.chain`, chain.save())
      expect(existsSync(`${filePath}.chain`)).toBe(true)
      const res = await fetch(handle.url + '/api/doc')
      const body = await res.json()
      expect(body.chain.exists).toBe(true)
    } finally {
      await handle.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
