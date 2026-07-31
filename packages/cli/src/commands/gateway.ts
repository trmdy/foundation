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
import { existsSync } from 'node:fs'
import type { CliIO } from '../io.js'
import { parseArgs } from '../argv.js'
import {
  gatewayRegistryPath,
  gatewaySocketPath,
  pidIsLive,
  readGatewayRegistry,
  removeGatewayRegistry,
  resolveShimCommand,
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
    socketPath: gatewaySocketPath(),
    shim: { command: shim.command, args: ['mcp'] },
    env: {},
    pid: process.pid,
    startedAt: new Date().toISOString(),
    gatewayRev: 1,
  }

  writeGatewayRegistry(registryPath, entry)
  io.stdout(`wrote ${registryPath}`)
  io.stdout(JSON.stringify(entry, null, 2))
  io.stdout(
    'note: foundation mcp is stateless (spawned fresh per bee over stdio, no daemon). Honeybee\'s gateway '
    + 'registry treats liveness as `kill(pid, 0)` on this file\'s `pid`; that pid is this install command\'s own '
    + 'process, which exits as soon as this command returns. The entry above will parse fine (and appear in `hive '
    + 'gateways`) but will read as "dead" — and be excluded from honeybee\'s automatic per-bee MCP-config seeding '
    + '— the moment this process exits. Run `foundation gateway status` to see current liveness. `foundation mcp` '
    + 'itself is unaffected: point any harness\'s MCP config at the shim command/args above manually to use it '
    + 'today.',
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

  const live = pidIsLive(entry.pid)
  const shimResolves = existsSync(entry.shim.command)

  io.stdout(`registry: ${registryPath}`)
  io.stdout(JSON.stringify(entry, null, 2))
  io.stdout(`pid ${entry.pid}: ${live ? 'live' : 'dead'}`)
  if (!live) io.stdout('  (dead pid: honeybee will not auto-seed this entry into bee MCP configs while dead — see `foundation gateway install`\'s note)')
  io.stdout(`shim command resolves on disk: ${shimResolves ? 'yes' : 'no'} (${entry.shim.command})`)

  return live && shimResolves ? 0 : 1
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
