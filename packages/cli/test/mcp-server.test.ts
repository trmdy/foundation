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
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CLI_ROOT = join(__dirname, '..')
const MAIN_TS = join(CLI_ROOT, 'src', 'main.ts')
const BOARD = join(__dirname, '..', '..', '..', 'boards', 'system-help-center.fdn.html')

async function connectClient(): Promise<{ client: Client; transport: StdioClientTransport }> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', MAIN_TS, 'mcp'],
    cwd: CLI_ROOT,
    stderr: 'ignore',
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
})
