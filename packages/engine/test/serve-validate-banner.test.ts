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

function baseDoc(overrides: Partial<FdnDocument> = {}): FdnDocument {
  return {
    specVersion: '0.0.1-draft',
    title: 'Banner Fixture',
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
    body: [],
    ...overrides,
  }
}

/** A node with both text AND a child element trips validate's
 *  text-children-conflict — the same shape composer-queue-overflow.fdn.html's
 *  7 real errors have (buttons carrying an <svg> icon plus label text). */
function invalidDoc(): FdnDocument {
  return baseDoc({
    body: [
      node({
        id: 'n1',
        tag: 'button',
        text: 'send now',
        children: [node({ id: 'n2', tag: 'svg' })],
      }),
    ],
  })
}

function validDoc(): FdnDocument {
  return baseDoc({
    body: [node({ id: 'n1', tag: 'div', text: 'all clear' })],
  })
}

async function serveTmp(doc: FdnDocument): Promise<{ handle: ServeHandle; dir: string; filePath: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'fdn-serve-banner-'))
  const filePath = join(dir, 'fixture.fdn.html')
  writeFileSync(filePath, projectDocument(doc), 'utf8')
  const handle = await serveDocument(filePath, { port: 0 })
  return { handle, dir, filePath }
}

describe('serveDocument: validation-error banner', () => {
  let handle: ServeHandle
  let dir: string

  afterEach(async () => {
    await handle.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('renders a fixed top banner with error count, first 3 messages, and the validate hint when the document has validation errors', async () => {
    ;({ handle, dir } = await serveTmp(invalidDoc()))
    const res = await fetch(handle.url + '/')
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('data-foundation-validate-banner')
    expect(body).toContain('1 validation error')
    expect(body).toContain('node has both text content and element children')
    expect(body).toContain('foundation validate')
    expect(body).toContain('for the full list')
    // still renders the baked content best-effort below the banner — bake's
    // own "children win" rule means the <svg> child renders, not the
    // conflicting text, but the node itself is never dropped/blanked out.
    expect(body).toContain('<button')
    expect(body).toContain('<svg')
  })

  it('caps the banner at the first 3 corrective messages even with more errors', async () => {
    const doc = baseDoc({
      body: [
        node({ id: 'n1', tag: 'button', text: 'a', children: [node({ id: 'n1a', tag: 'svg' })] }),
        node({ id: 'n2', tag: 'button', text: 'b', children: [node({ id: 'n2a', tag: 'svg' })] }),
        node({ id: 'n3', tag: 'button', text: 'c', children: [node({ id: 'n3a', tag: 'svg' })] }),
        node({ id: 'n4', tag: 'button', text: 'd', children: [node({ id: 'n4a', tag: 'svg' })] }),
        node({ id: 'n5', tag: 'button', text: 'e', children: [node({ id: 'n5a', tag: 'svg' })] }),
      ],
    })
    ;({ handle, dir } = await serveTmp(doc))
    const body = await (await fetch(handle.url + '/')).text()
    expect(body).toContain('5 validation errors')
    const liCount = (body.match(/<li>node has both text content/g) ?? []).length
    expect(liCount).toBe(3)
  })

  it('renders the banner in BOTH normal and ?embed=1 modes (unlike the state-switcher strip, which embed=1 suppresses)', async () => {
    ;({ handle, dir } = await serveTmp(invalidDoc()))
    const normal = await (await fetch(handle.url + '/')).text()
    const embedded = await (await fetch(handle.url + '/?embed=1')).text()
    expect(normal).toContain('data-foundation-validate-banner')
    expect(embedded).toContain('data-foundation-validate-banner')
    // sanity: embed=1 really does suppress the strip, so this isn't a no-op check
    expect(normal).toContain('<div data-foundation-serve-strip')
    expect(embedded).not.toContain('<div data-foundation-serve-strip')
  })

  it('renders no banner at all for a document with no validation errors', async () => {
    ;({ handle, dir } = await serveTmp(validDoc()))
    const normal = await (await fetch(handle.url + '/')).text()
    const embedded = await (await fetch(handle.url + '/?embed=1')).text()
    expect(normal).not.toContain('data-foundation-validate-banner')
    expect(embedded).not.toContain('data-foundation-validate-banner')
    expect(normal).toContain('all clear')
  })
})
