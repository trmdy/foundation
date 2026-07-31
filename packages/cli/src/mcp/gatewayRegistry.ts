/**
 * foundation gateway registry — reads/writes `~/.hive/gateways/foundation.json`
 * per the shape honeybee's `src/gateways.ts` parses (verified against
 * honeybee/repos/honeybee/src/gateways.ts:47-77 and the design docs at
 * apiary/repos/apiary/docs/AGENT_GATEWAY_DESIGN.md §2.1 and
 * honeybee/repos/honeybee/docs/OPERATOR_GATEWAYS_PROPOSAL.md §3):
 *
 *   { name, protocol: 'mcp', socketPath, shim: { command, args }, env, pid,
 *     startedAt, gatewayRev: 1 }
 *
 * Directory is overridable via FOUNDATION_GATEWAY_DIR (test seam), defaulting
 * to `~/.hive/gateways` like every other operator gateway.
 *
 * IMPORTANT liveness finding (see `gateway.ts`'s install command for the full
 * explanation surfaced to the user): honeybee's `liveGateways()` — the read
 * path that feeds automatic MCP-config seeding into every bee's home — only
 * includes entries whose `pid` answers `kill(pid, 0)` as alive
 * (honeybee/repos/honeybee/src/gateways.ts:119-140). Foundation's MCP server
 * is deliberately stateless (spawned per bee via stdio, no daemon), so the
 * pid recorded here is `foundation gateway install`'s own process — which
 * exits as soon as the command returns. The file this module writes is
 * syntactically valid and shows up in `hive gateways`, but will read as
 * "dead" (and be excluded from auto-seeding) the moment the install command
 * exits. That is a real gap between honeybee's pid-liveness model and a
 * daemon-less gateway; see the final report for what a honeybee-side fix
 * would look like. We do NOT paper over it with a fake always-alive pid.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'

export interface GatewayShim {
  command: string
  args: string[]
}

export interface GatewayRegistryEntry {
  name: 'foundation'
  protocol: 'mcp'
  socketPath: string
  shim: GatewayShim
  env: Record<string, string>
  pid: number
  startedAt: string
  gatewayRev: 1
}

export function gatewayDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.FOUNDATION_GATEWAY_DIR || join(homedir(), '.hive', 'gateways')
}

export function gatewayRegistryPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(gatewayDir(env), 'foundation.json')
}

/** Never actually opened by this v0 (no daemon listens here) — see module
 *  doc. Written only because honeybee's registry schema requires an absolute
 *  socketPath string; honeybee itself never connects to it
 *  (OPERATOR_GATEWAYS_PROPOSAL.md invariant 5: "Honeybee stays protocol-blind"). */
export function gatewaySocketPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(gatewayDir(env), 'foundation.sock')
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
    if (typeof value.socketPath !== 'string' || !isAbsolute(value.socketPath)) return null
    if (!value.shim || typeof value.shim.command !== 'string' || !isAbsolute(value.shim.command)) return null
    if (!isStringArray(value.shim.args)) return null
    if (!isStringRecord(value.env)) return null
    if (typeof value.pid !== 'number' || !Number.isSafeInteger(value.pid) || value.pid <= 0) return null
    if (typeof value.startedAt !== 'string' || Number.isNaN(Date.parse(value.startedAt))) return null
    return {
      name: 'foundation',
      protocol: 'mcp',
      socketPath: value.socketPath,
      shim: { command: value.shim.command, args: [...value.shim.args] },
      env: { ...value.env },
      pid: value.pid,
      startedAt: value.startedAt,
      gatewayRev: 1,
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

/** Same liveness rule honeybee uses (kill(pid, 0); EPERM counts as live —
 *  honeybee/repos/honeybee/src/gateways.ts:119-126). */
export function pidIsLive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
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
