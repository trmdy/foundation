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
        'foundation_bake',
        'foundation_chain_anchor',
        'foundation_chain_log',
        'foundation_diff',
        'foundation_freeze',
        'foundation_ingest',
        'foundation_inspect',
        'foundation_new',
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
})
