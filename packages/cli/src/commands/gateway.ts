/**
 * `foundation gateway install|uninstall|status` — publish/withdraw the
 * operator-gateway registry entry that lets honeybee auto-seed `foundation
 * mcp` into every hive bee's MCP config (the mechanism designed in
 * honeybee/docs/OPERATOR_GATEWAYS_PROPOSAL.md and consumed by
 * apiary/docs/AGENT_GATEWAY_DESIGN.md). See packages/cli/src/mcp/
 * gatewayRegistry.ts for the on-disk shape and the parsing rules this must
 * satisfy, and this file's `install` for the liveness caveat that shape
 * implies for a stateless, no-daemon server like `foundation mcp`.
 *
 * Directory is `~/.hive/gateways` by default, overridable via
 * FOUNDATION_GATEWAY_DIR (test seam — matches the gatewayRegistry.ts helpers).
 */

import type { CliIO } from '../io.js'
import { parseArgs } from '../argv.js'
import {
  gatewayRegistryPath,
  readGatewayRegistry,
  removeGatewayRegistry,
  resolveShimCommand,
  shimIsSpawnable,
  writeGatewayRegistry,
  type GatewayRegistryEntry,
} from '../mcp/gatewayRegistry.js'

function runInstall(io: CliIO): number {
  const registryPath = gatewayRegistryPath()

  let shim: ReturnType<typeof resolveShimCommand>
  try {
    shim = resolveShimCommand()
  } catch (err) {
    io.stderr(err instanceof Error ? err.message : String(err))
    return 1
  }
  if (shim.warning) io.stderr(`warning: ${shim.warning}`)

  const entry: GatewayRegistryEntry = {
    name: 'foundation',
    protocol: 'mcp',
    shim: { command: shim.command, args: ['mcp'] },
    env: {},
    startedAt: new Date().toISOString(),
    gatewayRev: 1,
    stateless: true,
  }

  writeGatewayRegistry(registryPath, entry)
  io.stdout(`wrote ${registryPath}`)
  io.stdout(JSON.stringify(entry, null, 2))
  io.stdout(
    'stateless gateway registered: no daemon, no socket, no pid. Honeybee treats liveness as "the shim command '
    + 'is executable" (requires honeybee with stateless-gateway support, branch feat/stateless-gateways); with '
    + 'that in place, every freshly spawned bee gets foundation\'s MCP tools auto-seeded. Older honeybee versions '
    + 'reject this entry as malformed (fail-closed) — point a harness\'s MCP config at the shim command/args '
    + 'above manually there.',
  )
  return 0
}

function runUninstall(io: CliIO): number {
  const registryPath = gatewayRegistryPath()
  const removed = removeGatewayRegistry(registryPath)
  io.stdout(removed ? `removed ${registryPath}` : `${registryPath}: not present (nothing to remove)`)
  return 0
}

function runStatus(io: CliIO): number {
  const registryPath = gatewayRegistryPath()
  const entry = readGatewayRegistry(registryPath)
  if (!entry) {
    io.stdout(`${registryPath}: not installed (or malformed) — run \`foundation gateway install\``)
    return 1
  }

  const spawnable = shimIsSpawnable(entry.shim.command)

  io.stdout(`registry: ${registryPath}`)
  io.stdout(JSON.stringify(entry, null, 2))
  io.stdout(`stateless gateway — liveness = shim executable: ${spawnable ? 'live' : 'DEAD'} (${entry.shim.command})`)
  if (!spawnable) io.stdout('  (shim missing or not executable: honeybee will not auto-seed this entry until it is)')

  return spawnable ? 0 : 1
}

export async function runGateway(args: string[], io: CliIO): Promise<number> {
  const { positionals } = parseArgs(args)
  const sub = positionals[0]

  if (sub === 'install') return runInstall(io)
  if (sub === 'uninstall') return runUninstall(io)
  if (sub === 'status') return runStatus(io)

  io.stderr('usage: foundation gateway install|uninstall|status')
  return 2
}
