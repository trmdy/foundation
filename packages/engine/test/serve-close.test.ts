import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { serveDocument } from '../src/serve/index.js'
import { projectDocument } from '../src/project/index.js'
import type { FdnDocument, FdnNode } from '../src/types.js'

function node(partial: Partial<FdnNode> & { id: string; tag: string }): FdnNode {
  return { attrs: {}, style: {}, styleStates: {}, children: [], ...partial }
}

function makeDoc(): FdnDocument {
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
    annotations: [],
    body: [node({ id: 'n1', tag: 'div', text: 'hi' })],
  }
}

describe('serveDocument: close() tears everything down', () => {
  it('closes the http server, the file watcher, and any open SSE connections', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fdn-serve-close-'))
    const filePath = join(dir, 'fixture.fdn.html')
    writeFileSync(filePath, projectDocument(makeDoc()), 'utf8')

    const handle = await serveDocument(filePath, { port: 0 })

    // open an SSE connection and leave it dangling — close() must still resolve
    const sse = await fetch(handle.url + '/events')
    expect(sse.status).toBe(200)

    await handle.close()

    // after close, the port is no longer accepting connections
    await expect(fetch(handle.url + '/')).rejects.toBeTruthy()

    rmSync(dir, { recursive: true, force: true })
  })

  it('close() resolves even when never fetched from', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fdn-serve-close-idle-'))
    const filePath = join(dir, 'fixture.fdn.html')
    writeFileSync(filePath, projectDocument(makeDoc()), 'utf8')

    const handle = await serveDocument(filePath, { port: 0 })
    await expect(handle.close()).resolves.toBeUndefined()

    rmSync(dir, { recursive: true, force: true })
  })
})
