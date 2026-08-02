/**
 * `foundation mcp` end-to-end over real stdio: spawns the CLI as a child
 * process (same `node --import tsx <entry>` pattern honeybee's own gateway
 * tests use — honeybee/repos/honeybee/tests/gateways.test.ts) and speaks MCP
 * through the SDK's own `Client` + `StdioClientTransport`, rather than
 * calling server internals in-process — this is the one seam that proves the
 * wire protocol (initialize, tools/list, tools/call) actually works end to
 * end, not just that the handler functions do.
 */
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CLI_ROOT = join(__dirname, '..')
const MAIN_TS = join(CLI_ROOT, 'src', 'main.ts')
const BOARD = join(__dirname, '..', '..', '..', 'boards', 'system-help-center.fdn.html')

async function connectClient(env?: Record<string, string>): Promise<{ client: Client; transport: StdioClientTransport }> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', MAIN_TS, 'mcp'],
    cwd: CLI_ROOT,
    stderr: 'ignore',
    ...(env ? { env: { ...getDefaultEnvironment(), ...env } } : {}),
  })
  const client = new Client({ name: 'foundation-mcp-test-client', version: '0.0.0' })
  await client.connect(transport)
  return { client, transport }
}

describe('foundation mcp (real stdio child process)', () => {
  let client: Client
  let transport: StdioClientTransport

  beforeEach(async () => {
    const connected = await connectClient()
    client = connected.client
    transport = connected.transport
  }, 30000)

  afterEach(async () => {
    await client.close()
    await transport.close()
  })

  it('completes the MCP initialize handshake and advertises the tool capability', () => {
    const capabilities = client.getServerCapabilities()
    expect(capabilities?.tools).toBeDefined()
  })

  it('lists the fixed foundation_* tool set with non-empty descriptions and object input schemas', async () => {
    const { tools } = await client.listTools()
    const names = tools.map((t) => t.name).sort()
    expect(names).toEqual(
      [
        'foundation_annotate',
        'foundation_annotations',
        'foundation_bake',
        'foundation_chain_anchor',
        'foundation_chain_log',
        'foundation_diff',
        'foundation_freeze',
        'foundation_import',
        'foundation_ingest',
        'foundation_inspect',
        'foundation_new',
        'foundation_project',
        'foundation_read',
        'foundation_render',
        'foundation_validate',
      ].sort(),
    )
    for (const tool of tools) {
      expect(tool.description, `${tool.name} needs a description`).toBeTruthy()
      expect(tool.inputSchema.type).toBe('object')
    }
    const inspectTool = tools.find((t) => t.name === 'foundation_inspect')
    expect(inspectTool?.inputSchema.required).toContain('path')
  }, 15000)

  it('foundation_inspect returns a structured summary for boards/system-help-center.fdn.html', async () => {
    const result = await client.callTool({ name: 'foundation_inspect', arguments: { path: BOARD } })
    expect(result.isError).not.toBe(true)
    const structured = result.structuredContent as Record<string, unknown>
    expect(structured.path).toBe(BOARD)
    expect(typeof structured.title).not.toBe('undefined')
    expect(typeof structured.params).toBe('number')
    expect(typeof structured.states).toBe('number')
    expect(structured.states as number).toBeGreaterThan(0)
    expect(typeof structured.nodes).toBe('number')
    expect(structured.nodes as number).toBeGreaterThan(0)
    expect(typeof structured.valid).toBe('boolean')
    // text content mirrors structuredContent for clients that only read text
    const content = result.content as Array<{ type: string; text?: string }>
    expect(content).toHaveLength(1)
    expect(content[0]).toMatchObject({ type: 'text' })
  }, 15000)

  it('foundation_bake bakes the declared "dialog-agent-run" state with a deduplicated conformance report', async () => {
    const result = await client.callTool({
      name: 'foundation_bake',
      arguments: { path: BOARD, state: 'dialog-agent-run' },
    })
    expect(result.isError).not.toBe(true)
    const structured = result.structuredContent as Record<string, unknown>
    expect(structured.state).toBe('dialog-agent-run')
    expect(typeof structured.html).toBe('string')
    expect(structured.html as string).toContain('baked by foundation-engine')
    const conformance = structured.conformance as { count: number; lines: unknown[] }
    expect(conformance.lines.length).toBe(conformance.count)
    // dedupe check: no two lines share the same (severity, code, nodeId, message)
    const keys = (conformance.lines as Array<{ severity: string; code: string; nodeId?: string; message: string }>).map(
      (l) => `${l.severity}|${l.code}|${l.nodeId ?? ''}|${l.message}`,
    )
    expect(new Set(keys).size).toBe(keys.length)
  }, 15000)

  it('an unknown tool name returns a structured error instead of crashing the server', async () => {
    const result = await client.callTool({ name: 'foundation_does_not_exist', arguments: {} })
    expect(result.isError).toBe(true)
    // the server is still usable afterwards
    const followUp = await client.callTool({ name: 'foundation_inspect', arguments: { path: BOARD } })
    expect(followUp.isError).not.toBe(true)
  }, 15000)

  it('a missing required argument returns a structured error, not a thrown exception', async () => {
    const result = await client.callTool({ name: 'foundation_inspect', arguments: {} })
    expect(result.isError).toBe(true)
    expect((result.content as Array<{ type: string; text?: string }>)[0]?.text).toMatch(/path/)
  }, 15000)

  it('foundation_read/foundation_validate/foundation_new/foundation_chain_log round-trip against a fresh scaffold', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const dir = mkdtempSync(join(tmpdir(), 'fdn-mcp-new-'))
    const target = join(dir, 'widget')

    const created = await client.callTool({ name: 'foundation_new', arguments: { path: target } })
    expect(created.isError).not.toBe(true)
    const createdStructured = created.structuredContent as Record<string, unknown>
    const filePath = createdStructured.path as string
    expect(filePath.endsWith('.fdn.html')).toBe(true)

    const validated = await client.callTool({ name: 'foundation_validate', arguments: { path: filePath } })
    expect(validated.isError).not.toBe(true)
    expect((validated.structuredContent as Record<string, unknown>).valid).toBe(true)

    const read = await client.callTool({ name: 'foundation_read', arguments: { path: filePath } })
    expect(read.isError).not.toBe(true)
    expect(typeof (read.structuredContent as Record<string, unknown>).canonical).toBe('string')

    const log = await client.callTool({ name: 'foundation_chain_log', arguments: { path: filePath } })
    expect(log.isError).not.toBe(true)
    const logStructured = log.structuredContent as Record<string, unknown>
    expect(logStructured.exists).toBe(true)
    expect(Array.isArray(logStructured.entries)).toBe(true)
    expect((logStructured.entries as unknown[]).length).toBeGreaterThan(0)

    rmSync(dir, { recursive: true, force: true })
  }, 15000)

  it('foundation_new empty:true scaffolds only the header + tokens + empty main (friction §7)', async () => {
    const { mkdtempSync, rmSync, readFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const dir = mkdtempSync(join(tmpdir(), 'fdn-mcp-new-empty-'))
    const target = join(dir, 'blank')

    const created = await client.callTool({ name: 'foundation_new', arguments: { path: target, empty: true } })
    expect(created.isError).not.toBe(true)
    const structured = created.structuredContent as Record<string, unknown>
    expect(structured.empty).toBe(true)
    const filePath = structured.path as string
    const text = readFileSync(filePath, 'utf8')
    expect(text).not.toContain('<fdn-param ')
    expect(text).not.toContain('<fdn-component ')

    const inspected = await client.callTool({ name: 'foundation_inspect', arguments: { path: filePath } })
    const inspectedStructured = inspected.structuredContent as Record<string, unknown>
    expect(inspectedStructured.params).toBe(0)
    expect(inspectedStructured.components).toBe(0)
    expect(inspectedStructured.valid).toBe(true)

    rmSync(dir, { recursive: true, force: true })
  }, 15000)

  it('foundation_render defaults to paths + a one-line summary, no layout array, unless includeLayout is set (friction §4)', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const dir = mkdtempSync(join(tmpdir(), 'fdn-mcp-render-'))
    const target = join(dir, 'board')
    const created = await client.callTool({ name: 'foundation_new', arguments: { path: target } })
    const filePath = (created.structuredContent as Record<string, unknown>).path as string

    const defaultRender = await client.callTool({ name: 'foundation_render', arguments: { path: filePath } })
    expect(defaultRender.isError).not.toBe(true)
    const defaultStructured = defaultRender.structuredContent as Record<string, unknown>
    const defaultRenders = defaultStructured.renders as Array<Record<string, unknown>>
    expect(defaultRenders.length).toBeGreaterThan(0)
    const cell = defaultRenders[0] as Record<string, unknown>
    expect(typeof cell.pngPath).toBe('string')
    expect(typeof cell.layoutPath).toBe('string')
    expect(typeof cell.nodes).toBe('number')
    expect(cell.nodes as number).toBeGreaterThan(0)
    expect(typeof cell.errors).toBe('number')
    expect(typeof cell.warnings).toBe('number')
    expect(cell.layout).toBeUndefined()

    const withLayout = await client.callTool({
      name: 'foundation_render',
      arguments: { path: filePath, includeLayout: true },
    })
    const withLayoutCell = (withLayout.structuredContent as Record<string, unknown>).renders as Array<Record<string, unknown>>
    expect(Array.isArray(withLayoutCell[0]?.layout)).toBe(true)
    expect((withLayoutCell[0]?.layout as unknown[]).length).toBe(cell.nodes)

    rmSync(dir, { recursive: true, force: true })
  }, 20000)

  it('foundation_render node:"<id>" crops the PNG to that node\'s layout box + padding (friction §5)', async () => {
    const { mkdtempSync, rmSync, readFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { PNG } = await import('pngjs')
    const dir = mkdtempSync(join(tmpdir(), 'fdn-mcp-crop-'))
    const target = join(dir, 'board')
    const created = await client.callTool({ name: 'foundation_new', arguments: { path: target } })
    const filePath = (created.structuredContent as Record<string, unknown>).path as string

    const full = await client.callTool({ name: 'foundation_render', arguments: { path: filePath, includeLayout: true } })
    const fullCell = ((full.structuredContent as Record<string, unknown>).renders as Array<Record<string, unknown>>)[0] as Record<string, unknown>
    const fullPng = PNG.sync.read(readFileSync(fullCell.pngPath as string))
    const layout = fullCell.layout as Array<{ id: string; x: number; y: number; width: number; height: number }>
    const box = layout.find((l) => l.id === 'n1')
    expect(box).toBeDefined()

    const cropped = await client.callTool({ name: 'foundation_render', arguments: { path: filePath, node: 'n1' } })
    expect(cropped.isError).not.toBe(true)
    const croppedCell = ((cropped.structuredContent as Record<string, unknown>).renders as Array<Record<string, unknown>>)[0] as Record<string, unknown>
    expect(croppedCell.croppedFor).toBe('n1')
    expect(typeof croppedCell.fullPngPath).toBe('string')
    const croppedPng = PNG.sync.read(readFileSync(croppedCell.pngPath as string))

    // the crop is the node's box + 16px padding on each side, clamped to the
    // source image. n1 (the scaffold's <h1>) spans nearly the full page
    // width but is short, so height is the crop dimension that's strictly
    // smaller than the full page; both dimensions are at least the box size.
    expect(croppedPng.height).toBeLessThan(fullPng.height)
    expect(croppedPng.width).toBeGreaterThanOrEqual(Math.floor(box!.width))
    expect(croppedPng.height).toBeGreaterThanOrEqual(Math.floor(box!.height))

    rmSync(dir, { recursive: true, force: true })
  }, 20000)

  it('foundation_render node:"<unknown>" reports a cropError per-cell instead of failing the whole call', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const dir = mkdtempSync(join(tmpdir(), 'fdn-mcp-crop-miss-'))
    const target = join(dir, 'board')
    const created = await client.callTool({ name: 'foundation_new', arguments: { path: target } })
    const filePath = (created.structuredContent as Record<string, unknown>).path as string

    const result = await client.callTool({ name: 'foundation_render', arguments: { path: filePath, node: 'does-not-exist' } })
    expect(result.isError).not.toBe(true)
    const cell = ((result.structuredContent as Record<string, unknown>).renders as Array<Record<string, unknown>>)[0] as Record<string, unknown>
    expect(typeof cell.cropError).toBe('string')
    expect(cell.croppedFor).toBeUndefined()

    rmSync(dir, { recursive: true, force: true })
  }, 20000)

  it('foundation_annotate / foundation_annotations round-trip (create, resolve, list) and 409 without a chain', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const dir = mkdtempSync(join(tmpdir(), 'fdn-mcp-annotate-'))
    const target = join(dir, 'board')

    const created = await client.callTool({ name: 'foundation_new', arguments: { path: target, empty: true } })
    expect(created.isError).not.toBe(true)
    const filePath = (created.structuredContent as Record<string, unknown>).path as string

    // annotate requires an existing chain (foundation_new empty:true still chain-inits)
    const annotated = await client.callTool({
      name: 'foundation_annotate',
      arguments: { path: filePath, text: 'padding looks off', x: 12, y: 34, state: 'default' },
    })
    expect(annotated.isError).not.toBe(true)
    const annotatedStructured = annotated.structuredContent as Record<string, unknown>
    const annotation = annotatedStructured.annotation as Record<string, unknown>
    expect(annotation.text).toBe('padding looks off')
    expect(annotation.x).toBe(12)
    expect(annotation.y).toBe(34)
    expect(annotation.status).toBe('open')
    const id = annotation.id as string
    expect(typeof id).toBe('string')

    const listed = await client.callTool({ name: 'foundation_annotations', arguments: { path: filePath } })
    expect(listed.isError).not.toBe(true)
    const listedAnnotations = (listed.structuredContent as Record<string, unknown>).annotations as Array<Record<string, unknown>>
    expect(listedAnnotations).toHaveLength(1)
    expect(listedAnnotations[0]?.id).toBe(id)

    const resolved = await client.callTool({ name: 'foundation_annotate', arguments: { path: filePath, resolve: id } })
    expect(resolved.isError).not.toBe(true)
    expect((resolved.structuredContent as Record<string, unknown>).status).toBe('resolved')

    const listedAfter = await client.callTool({ name: 'foundation_annotations', arguments: { path: filePath } })
    const listedAfterAnnotations = (listedAfter.structuredContent as Record<string, unknown>).annotations as Array<Record<string, unknown>>
    expect(listedAfterAnnotations[0]?.status).toBe('resolved')

    // and the CLI-facing text (regenerated via the same chain path) round-trips the annotation too
    const read = await client.callTool({ name: 'foundation_read', arguments: { path: filePath } })
    expect((read.structuredContent as Record<string, unknown>).canonical as string).toContain('<fdn-annotations>')

    rmSync(dir, { recursive: true, force: true })
  }, 15000)

  it('foundation_annotate fails (isError, not a thrown exception) when the document has no chain', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const dir = mkdtempSync(join(tmpdir(), 'fdn-mcp-annotate-no-chain-'))
    const target = join(dir, 'board')

    const created = await client.callTool({ name: 'foundation_new', arguments: { path: target } })
    const filePath = (created.structuredContent as Record<string, unknown>).path as string
    const { unlinkSync } = await import('node:fs')
    unlinkSync(`${filePath}.chain`)

    const result = await client.callTool({ name: 'foundation_annotate', arguments: { path: filePath, text: 'x' } })
    expect(result.isError).toBe(true)

    const followUp = await client.callTool({ name: 'foundation_inspect', arguments: { path: filePath } })
    expect(followUp.isError).not.toBe(true)

    rmSync(dir, { recursive: true, force: true })
  }, 15000)
})

describe('foundation mcp: author identity (friction §6)', () => {
  // The dogfood chain log showed a hardcoded 'agent:mcp' on every commit made
  // through the MCP server, losing which bee actually made the change. Both
  // foundation_new's chain init and foundation_ingest's commit path must
  // default through the same rule the CLI uses (packages/cli/src/identity.ts):
  // agent:<HIVE_BEE> when set, else user:<name>@<host>.
  it('foundation_new chain-inits with agent:<HIVE_BEE> when the env var is set', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const dir = mkdtempSync(join(tmpdir(), 'fdn-mcp-identity-new-'))
    const target = join(dir, 'widget')

    const { client: beeClient, transport } = await connectClient({ HIVE_BEE: 'test-bee-42' })
    try {
      const created = await beeClient.callTool({ name: 'foundation_new', arguments: { path: target } })
      expect(created.isError).not.toBe(true)
      const filePath = (created.structuredContent as Record<string, unknown>).path as string

      const log = await beeClient.callTool({ name: 'foundation_chain_log', arguments: { path: filePath } })
      const entries = (log.structuredContent as Record<string, unknown>).entries as Array<{ author: string }>
      expect(entries.length).toBeGreaterThan(0)
      expect(entries[0]?.author).toBe('agent:test-bee-42')
      expect(entries.every((e) => e.author !== 'agent:mcp')).toBe(true)
    } finally {
      await beeClient.close()
      await transport.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }, 15000)

  it('foundation_ingest --commit commits with agent:<HIVE_BEE> when the env var is set', async () => {
    const { mkdtempSync, rmSync, readFileSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const dir = mkdtempSync(join(tmpdir(), 'fdn-mcp-identity-ingest-'))
    const target = join(dir, 'widget')

    const { client: beeClient, transport } = await connectClient({ HIVE_BEE: 'test-bee-77' })
    try {
      const created = await beeClient.callTool({ name: 'foundation_new', arguments: { path: target } })
      const filePath = (created.structuredContent as Record<string, unknown>).path as string

      // a real (non-no-op) edit so ingest --commit actually appends an entry
      const text = readFileSync(filePath, 'utf8')
      writeFileSync(filePath, text.replace('Hello, Foundation', 'Hello, Bees'), 'utf8')

      const ingested = await beeClient.callTool({ name: 'foundation_ingest', arguments: { path: filePath, commit: true } })
      expect(ingested.isError).not.toBe(true)
      const commitInfo = (ingested.structuredContent as Record<string, unknown>).commit as Record<string, unknown>
      expect(commitInfo.status).toBe('committed')

      const log = await beeClient.callTool({ name: 'foundation_chain_log', arguments: { path: filePath } })
      const entries = (log.structuredContent as Record<string, unknown>).entries as Array<{ author: string }>
      expect(entries.some((e) => e.author === 'agent:test-bee-77')).toBe(true)
      expect(entries.every((e) => e.author !== 'agent:mcp')).toBe(true)
    } finally {
      await beeClient.close()
      await transport.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }, 15000)

  it('foundation_freeze freezes with agent:<HIVE_BEE> when the env var is set (loose end: was hardcoded agent:mcp)', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const dir = mkdtempSync(join(tmpdir(), 'fdn-mcp-identity-freeze-'))
    const target = join(dir, 'widget')
    const dest = join(dir, 'widget.frozen.fdn.html')

    const { client: beeClient, transport } = await connectClient({ HIVE_BEE: 'test-bee-99' })
    try {
      const created = await beeClient.callTool({ name: 'foundation_new', arguments: { path: target } })
      expect(created.isError).not.toBe(true)
      const filePath = (created.structuredContent as Record<string, unknown>).path as string

      const frozen = await beeClient.callTool({ name: 'foundation_freeze', arguments: { path: filePath, out: dest } })
      expect(frozen.isError).not.toBe(true)
      const structured = frozen.structuredContent as Record<string, unknown>
      expect(structured.frozen).toBe(true)
      const header = structured.header as Record<string, unknown>
      expect(header.frozenBy).toBe('agent:test-bee-99')
      expect(header.frozenBy).not.toBe('agent:mcp')
    } finally {
      await beeClient.close()
      await transport.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }, 15000)
})

describe('foundation mcp: document identity survives new -> ingest -> project add (dogfood cycle 3, friction §6)', () => {
  // The bee's repro: foundation_new minted an id, the first MCP
  // foundation_ingest silently deleted it (parse -> project -> write with no
  // re-stamp — data-fdn-doc-id lives only in the file TEXT, outside
  // FdnDocument entirely, so a plain parse/project round-trip drops it), and
  // `foundation project add` then refused the document outright with "no
  // document id found". Bug had two parts, both fixed in mcp/tools.ts:
  // foundation_new never minted an id over MCP at all (unlike the CLI's
  // `foundation new`), and foundation_ingest dropped whatever id was already
  // there. This test drives the real stdio MCP server for both steps, then
  // calls the CLI's own `project add` in-process to prove the id it kept is
  // actually usable — the whole point of it existing.
  let client: Client
  let transport: StdioClientTransport

  beforeEach(async () => {
    const connected = await connectClient()
    client = connected.client
    transport = connected.transport
  }, 30000)

  afterEach(async () => {
    await client.close()
    await transport.close()
  })

  it('new (doc id present) -> ingest with content (doc id preserved) -> project add succeeds', async () => {
    const { mkdtempSync, rmSync, readFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { captureIo } = await import('../src/io.js')
    const { runProject } = await import('../src/commands/project.js')
    const dir = mkdtempSync(join(tmpdir(), 'fdn-mcp-docid-'))
    const target = join(dir, 'widget')
    const cwd = process.cwd()

    try {
      const created = await client.callTool({ name: 'foundation_new', arguments: { path: target } })
      expect(created.isError).not.toBe(true)
      const filePath = (created.structuredContent as Record<string, unknown>).path as string

      const beforeText = readFileSync(filePath, 'utf8')
      const originalDocId = /data-fdn-doc-id="([^"]*)"/.exec(beforeText)?.[1]
      expect(originalDocId, 'foundation_new must mint and stamp a doc id, same as the CLI').toBeTruthy()

      // "ingest with content" — a real hand/agent-edit round-trip, the exact
      // shape the friction log's repro used ("Pass content to write new/
      // edited text first, then ingest it in one call").
      const edited = beforeText.replace('Hello, Foundation', 'Hello, Bees')
      const ingested = await client.callTool({ name: 'foundation_ingest', arguments: { path: filePath, content: edited } })
      expect(ingested.isError).not.toBe(true)

      const afterText = readFileSync(filePath, 'utf8')
      const afterDocId = /data-fdn-doc-id="([^"]*)"/.exec(afterText)?.[1]
      expect(afterDocId, 'foundation_ingest must not strip data-fdn-doc-id').toBe(originalDocId)
      expect(afterText).toContain('Hello, Bees')

      // project add succeeds: the id ingest preserved is a real, addressable
      // document id, not just text that happens to still be there.
      process.chdir(dir)
      const initCode = await runProject(['init', dir], captureIo())
      expect(initCode).toBe(0)
      const io = captureIo()
      const addCode = await runProject(['add', 'widget.fdn.html'], io)
      expect(addCode).toBe(0)
      expect(io.err).toEqual([])

      const manifest = JSON.parse(readFileSync(join(dir, 'foundation.json'), 'utf8')) as {
        documents: Array<{ path: string; docId: string }>
      }
      expect(manifest.documents).toHaveLength(1)
      expect(manifest.documents[0]?.docId).toBe(originalDocId)
    } finally {
      process.chdir(cwd)
      rmSync(dir, { recursive: true, force: true })
    }
  }, 15000)
})

describe('foundation_project (read-only manifest listing)', () => {
  let client: Client
  let transport: StdioClientTransport

  beforeEach(async () => {
    const connected = await connectClient()
    client = connected.client
    transport = connected.transport
  }, 30000)

  afterEach(async () => {
    await client.close()
    await transport.close()
  })

  it('lists a manifest\'s documents with validate status and chain head', async () => {
    const { mkdtempSync, rmSync, writeFileSync, readFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const dir = mkdtempSync(join(tmpdir(), 'fdn-mcp-project-'))
    const target = join(dir, 'widget')

    const created = await client.callTool({ name: 'foundation_new', arguments: { path: target } })
    const filePath = (created.structuredContent as Record<string, unknown>).path as string
    const relPath = filePath.split('/').pop() as string

    const manifest = {
      schema: 1,
      id: 'manifest-under-test',
      name: 'mcp-project-test',
      documents: [{ path: relPath, docId: readFileSync(filePath, 'utf8').match(/data-fdn-doc-id="([^"]*)"/)?.[1] }],
    }
    writeFileSync(join(dir, 'foundation.json'), JSON.stringify(manifest, null, 2), 'utf8')

    const result = await client.callTool({ name: 'foundation_project', arguments: { dir, action: 'list' } })
    expect(result.isError).not.toBe(true)
    const structured = result.structuredContent as Record<string, unknown>
    expect((structured.manifest as Record<string, unknown>).name).toBe('mcp-project-test')
    const documents = structured.documents as Array<Record<string, unknown>>
    expect(documents).toHaveLength(1)
    expect(documents[0]?.path).toBe(relPath)
    expect(documents[0]?.status).toBe('ok')
    expect(documents[0]?.chain).toBe('chain ' + (documents[0]?.chainHead as string).slice(0, 12))

    rmSync(dir, { recursive: true, force: true })
  }, 15000)

  it('returns a structured error when no manifest exists at dir (does not throw)', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const dir = mkdtempSync(join(tmpdir(), 'fdn-mcp-project-missing-'))

    const result = await client.callTool({ name: 'foundation_project', arguments: { dir } })
    expect(result.isError).toBe(true)

    rmSync(dir, { recursive: true, force: true })
  }, 15000)

  it('rejects any action other than "list" (read-only in MCP for v0)', async () => {
    const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const dir = mkdtempSync(join(tmpdir(), 'fdn-mcp-project-writeonly-'))
    writeFileSync(join(dir, 'foundation.json'), JSON.stringify({ schema: 1, id: 'x', name: 'x', documents: [] }), 'utf8')

    const result = await client.callTool({ name: 'foundation_project', arguments: { dir, action: 'add' } })
    expect(result.isError).toBe(true)

    rmSync(dir, { recursive: true, force: true })
  }, 15000)
})
