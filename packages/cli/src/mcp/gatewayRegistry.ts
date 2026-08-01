/**
 * foundation gateway registry — reads/writes `~/.hive/gateways/foundation.json`
 * as a STATELESS gateway per honeybee's `src/gateways.ts` (branch
 * feat/stateless-gateways): a `stateless: true` entry needs no socketPath and
 * no pid — the shim IS the gateway, spawned per consumer over stdio — and its
 * liveness is "the shim command is executable", not kill(pid, 0):
 *
 *   { name, protocol: 'mcp', shim: { command, args }, env, startedAt,
 *     gatewayRev: 1, stateless: true }
 *
 * Directory is overridable via FOUNDATION_GATEWAY_DIR (test seam), defaulting
 * to `~/.hive/gateways` like every other operator gateway. Honeybee versions
 * without stateless support reject the entry as malformed (treated as absent)
 * rather than misreading it — fail-closed by their strict parser.
 */
import { accessSync, chmodSync, constants as fsConstants, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'

export interface GatewayShim {
  command: string
  args: string[]
}

export interface GatewayRegistryEntry {
  name: 'foundation'
  protocol: 'mcp'
  shim: GatewayShim
  env: Record<string, string>
  startedAt: string
  gatewayRev: 1
  stateless: true
}

export function gatewayDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.FOUNDATION_GATEWAY_DIR || join(homedir(), '.hive', 'gateways')
}

export function gatewayRegistryPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(gatewayDir(env), 'foundation.json')
}

export function writeGatewayRegistry(path: string, entry: GatewayRegistryEntry): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(entry, null, 2)}\n`, { mode: 0o600 })
  chmodSync(tmp, 0o600)
  renameSync(tmp, path)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string')
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.values(value as Record<string, unknown>).every((v) => typeof v === 'string')
}

/** Tolerant parse mirroring honeybee's own validation rules — malformed or
 *  foreign files (wrong name/protocol/rev, relative paths, non-string env)
 *  are simply not "our" entry, never thrown. */
export function readGatewayRegistry(path: string): GatewayRegistryEntry | null {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return null
  }
  try {
    const value = JSON.parse(raw) as Partial<GatewayRegistryEntry> & { shim?: Partial<GatewayShim> }
    if (value.name !== 'foundation' || value.protocol !== 'mcp' || value.gatewayRev !== 1) return null
    if (value.stateless !== true) return null
    if (!value.shim || typeof value.shim.command !== 'string' || !isAbsolute(value.shim.command)) return null
    if (!isStringArray(value.shim.args)) return null
    if (!isStringRecord(value.env)) return null
    if (typeof value.startedAt !== 'string' || Number.isNaN(Date.parse(value.startedAt))) return null
    return {
      name: 'foundation',
      protocol: 'mcp',
      shim: { command: value.shim.command, args: [...value.shim.args] },
      env: { ...value.env },
      startedAt: value.startedAt,
      gatewayRev: 1,
      stateless: true,
    }
  } catch {
    return null
  }
}

/** Idempotent: returns false when there was nothing to remove. */
export function removeGatewayRegistry(path: string): boolean {
  if (!existsSync(path)) return false
  try {
    unlinkSync(path)
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw err
  }
}

/** Same liveness rule honeybee applies to stateless gateways: the shim
 *  command exists and is executable (access X_OK). */
export function shimIsSpawnable(command: string): boolean {
  try {
    accessSync(command, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

export interface ResolvedShim {
  command: string
  source: 'local-bin' | 'fallback'
  warning?: string
}

/** Resolve an absolute path to the `foundation` CLI entry point, preferring
 *  the globally-installed wrapper at `~/.local/bin/foundation` (the
 *  no-PATH-dependency contract every gateway shim needs — AGENT_GATEWAY_
 *  DESIGN.md §2.2). Falls back to this process's own entry point (useful in
 *  dev/test where the global wrapper may not exist), with a warning telling
 *  the user how to get the portable form. */
export function resolveShimCommand(env: NodeJS.ProcessEnv = process.env): ResolvedShim {
  const localBin = join(env.HOME || homedir(), '.local', 'bin', 'foundation')
  if (existsSync(localBin)) {
    return { command: realpathSync(localBin), source: 'local-bin' }
  }
  const argv1 = process.argv[1]
  if (argv1 && existsSync(argv1)) {
    return {
      command: realpathSync(argv1),
      source: 'fallback',
      warning: `~/.local/bin/foundation not found; using ${realpathSync(argv1)} as the shim command instead. `
        + 'This works on this machine but is not portable — install a wrapper at ~/.local/bin/foundation '
        + '(see repos/foundation packaging) so other harnesses/hosts can find it without PATH.',
    }
  }
  throw new Error(
    'could not resolve an absolute path to the foundation CLI (no ~/.local/bin/foundation and no resolvable '
    + 'process.argv[1]) — install the foundation CLI as a global wrapper at ~/.local/bin/foundation first',
  )
}
