import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
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
    tokens: {},
    params: [{ name: 'greeting', type: 'string', default: 'hi' }],
    data: [],
    lookups: [],
    states: [{ name: 'a', assignments: {} }],
    viewports: [],
    matrix: [],
    namedStyles: [],
    components: [],
    body: [node({ id: 'n1', tag: 'div', text: '{{ param.greeting }}' })],
  }
}

describe('serveDocument: error handling never crashes the server', () => {
  let dir: string
  let filePath: string
  let handle: ServeHandle

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'fdn-serve-err-'))
    filePath = join(dir, 'fixture.fdn.html')
    writeFileSync(filePath, projectDocument(makeDoc()), 'utf8')
    handle = await serveDocument(filePath, { port: 0 })
  })

  afterEach(async () => {
    await handle.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('an unknown ?state= bakes with defaults and reports unknown-state rather than failing', async () => {
    const res = await fetch(handle.url + '/?state=does-not-exist')
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('hi')

    const report = await (await fetch(handle.url + '/report?state=does-not-exist')).json()
    expect(report.lines.some((l: { code: string }) => l.code === 'unknown-state')).toBe(true)
  })

  it('a missing source file renders a 500 error page instead of crashing', async () => {
    unlinkSync(filePath)
    const res = await fetch(handle.url + '/')
    expect(res.status).toBe(500)
    const body = await res.text()
    expect(body).toContain('foundation serve — bake failed')

    // the server process is still alive and answers other requests fine
    const source = await fetch(handle.url + '/source')
    expect(source.status).toBe(500)
  })
})
