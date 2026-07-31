/**
 * foundation MCP server — wires `./tools.ts`'s tool registry into the MCP
 * wire protocol over stdio.
 *
 * Deliberately uses the SDK's low-level `Server` (not the high-level
 * `McpServer`) so tool input/output schemas can be authored as plain JSON
 * Schema objects instead of zod schemas: `McpServer.registerTool` requires
 * actual zod schema instances for its `inputSchema`/`outputSchema` (see
 * `@modelcontextprotocol/sdk`'s `zod-compat.d.ts` — `ZodRawShapeCompat`/
 * `AnySchema` are zod types, not raw JSON Schema), which would need `zod` as
 * a direct dependency of this package. The wire format tools/list already
 * advertises is plain JSON Schema either way (`ToolSchema.inputSchema` in
 * the SDK's own `types.ts`), so handling `ListToolsRequestSchema`/
 * `CallToolRequestSchema` ourselves gets the same protocol surface with only
 * `@modelcontextprotocol/sdk` added to package.json, per this task's brief.
 *
 * Import-light by construction: this module and `./tools.ts` only import
 * `foundation-engine`'s root (parse/validate/project/bake/chain) plus the
 * freeze submodule eagerly; `foundation-engine/src/render` and `.../diff`
 * (which pull in playwright) are loaded lazily, inside `foundation_render`/
 * `foundation_diff`, on first use — never at server boot.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { ServerResult } from '@modelcontextprotocol/sdk/types.js'
import { callTool, TOOLS } from './tools.js'

export function createFoundationMcpServer(): Server {
  const server = new Server(
    { name: 'foundation', version: '0.1.0' },
    { capabilities: { tools: {} } },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  }))

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params
    const result = await callTool(name, (args ?? {}) as Record<string, unknown>)
    // The SDK's low-level `Server.setRequestHandler` types its return as the
    // full `ServerResult` union across every request kind it could ever
    // route (including task-based variants with unrelated required fields)
    // rather than narrowing per-schema — our plain `{ content, structuredContent?,
    // isError? }` result is a valid `CallToolResult` on the wire, just not a
    // literal match for every union member TS considers here. See this
    // file's header for why we're on the low-level API at all.
    return result as unknown as ServerResult
  })

  return server
}

/** Runs the server over stdio until the transport closes (client disconnects
 *  / stdin closes) — the shape `foundation mcp` needs as a long-lived,
 *  per-invocation process. */
export async function runMcpStdioServer(): Promise<void> {
  const server = createFoundationMcpServer()
  const transport = new StdioServerTransport()
  await server.connect(transport)
  await new Promise<void>((resolve) => {
    transport.onclose = () => resolve()
  })
}
