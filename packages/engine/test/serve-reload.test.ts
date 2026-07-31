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

function makeDoc(text: string): FdnDocument {
  return {
    specVersion: '0.0.1-draft',
    tokens: {},
    params: [],
    data: [],
    lookups: [],
    states: [],
    viewports: [],
    matrix: [],
    namedStyles: [],
    components: [],
    body: [node({ id: 'n1', tag: 'div', text })],
  }
}

async function readOneSseMessage(stream: ReadableStream<Uint8Array>, timeoutMs: number): Promise<string> {
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
    // reader cancelled by the timeout above
  } finally {
    clearTimeout(timer)
    await reader.cancel().catch(() => {})
  }
  return buf
}

describe('serveDocument: live reload', () => {
  let dir: string
  let filePath: string
  let handle: ServeHandle

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'fdn-serve-reload-'))
    filePath = join(dir, 'fixture.fdn.html')
    writeFileSync(filePath, projectDocument(makeDoc('before')), 'utf8')
    handle = await serveDocument(filePath, { port: 0 })
  })

  afterEach(async () => {
    await handle.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('broadcasts a reload SSE event when the watched file changes', async () => {
    const res = await fetch(handle.url + '/events')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    expect(res.body).toBeTruthy()

    // give the SSE connection a moment to register before touching the file
    await new Promise((r) => setTimeout(r, 30))
    writeFileSync(filePath, projectDocument(makeDoc('after')), 'utf8')

    const message = await readOneSseMessage(res.body as ReadableStream<Uint8Array>, 3000)
    expect(message).toContain('data: reload')
  }, 10000)

  it('serves the updated content after the file changes', async () => {
    writeFileSync(filePath, projectDocument(makeDoc('after')), 'utf8')
    const res = await fetch(handle.url + '/')
    const body = await res.text()
    expect(body).toContain('after')
  })
})
