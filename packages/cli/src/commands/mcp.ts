/**
 * `foundation mcp` — run a stdio MCP server exposing Foundation's verbs
 * (foundation_inspect, foundation_read, foundation_validate,
 * foundation_ingest, foundation_bake, foundation_render, foundation_diff,
 * foundation_chain_log, foundation_chain_anchor, foundation_freeze,
 * foundation_new — see packages/cli/src/mcp/tools.ts) so any hive bee can
 * design against a .fdn.html document without Apiary in the loop.
 *
 * No flags: this command's only job is to hand off to the transport and
 * block until stdin/the MCP session closes, exactly like any other stdio
 * MCP server binary. Status/logging goes to stderr — stdout is reserved for
 * JSON-RPC frames the moment the transport connects.
 */
import type { CliIO } from '../io.js'
import { runMcpStdioServer } from '../mcp/server.js'

export async function runMcp(_args: string[], io: CliIO): Promise<number> {
  io.stderr('foundation mcp: stdio MCP server starting (tools: inspect, read, validate, ingest, bake, render, diff, chain_log, chain_anchor, freeze, new)')
  try {
    await runMcpStdioServer()
  } catch (err) {
    io.stderr(`mcp server error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`)
    return 1
  }
  return 0
}
