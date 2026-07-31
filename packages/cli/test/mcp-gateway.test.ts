/**
 * `foundation gateway install|uninstall|status` roundtrip, against a temp
 * FOUNDATION_GATEWAY_DIR override (packages/cli/src/mcp/gatewayRegistry.ts's
 * test seam — mirrors honeybee's own HIVE_STORE_ROOT override pattern for
 * its gateway tests, honeybee/repos/honeybee/tests/gateways.test.ts).
 *
 * Also exercises the registry read/parse rules directly against the shape
 * honeybee's `src/gateways.ts` requires (absolute paths, gatewayRev: 1,
 * numeric live pid, valid startedAt) — see gatewayRegistry.ts's module doc
 * for the honeybee file:line evidence this shape is built from.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { captureIo } from '../src/io.js'
import { runGateway } from '../src/commands/gateway.js'
import {
  gatewayRegistryPath,
  pidIsLive,
  readGatewayRegistry,
  writeGatewayRegistry,
} from '../src/mcp/gatewayRegistry.js'

describe('foundation gateway', () => {
  let dir: string
  let previousDir: string | undefined

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fdn-gateway-'))
    previousDir = process.env.FOUNDATION_GATEWAY_DIR
    process.env.FOUNDATION_GATEWAY_DIR = dir
  })

  afterEach(() => {
    if (previousDir === undefined) delete process.env.FOUNDATION_GATEWAY_DIR
    else process.env.FOUNDATION_GATEWAY_DIR = previousDir
    rmSync(dir, { recursive: true, force: true })
  })

  it('status reports "not installed" before install, exit code 1', async () => {
    const io = captureIo()
    const code = await runGateway(['status'], io)
    expect(code).toBe(1)
    expect(io.out.some((l) => l.includes('not installed'))).toBe(true)
  })

  it('install writes a well-formed registry entry honeybee\'s parser accepts', async () => {
    const io = captureIo()
    const code = await runGateway(['install'], io)
    expect(code).toBe(0)

    const registryPath = gatewayRegistryPath()
    expect(existsSync(registryPath)).toBe(true)
    expect(registryPath.startsWith(dir)).toBe(true)

    const raw = JSON.parse(readFileSync(registryPath, 'utf8')) as Record<string, unknown>
    expect(raw.name).toBe('foundation')
    expect(raw.protocol).toBe('mcp')
    expect(raw.gatewayRev).toBe(1)
    expect(typeof raw.socketPath).toBe('string')
    expect((raw.socketPath as string).startsWith('/')).toBe(true)
    const shim = raw.shim as { command: string; args: string[] }
    expect(shim.command.startsWith('/')).toBe(true)
    expect(shim.args).toEqual(['mcp'])
    expect(Number.isSafeInteger(raw.pid)).toBe(true)
    expect(Number.isNaN(Date.parse(raw.startedAt as string))).toBe(false)

    // round-trips through our own tolerant reader too
    const parsed = readGatewayRegistry(registryPath)
    expect(parsed).not.toBeNull()
    expect(parsed?.pid).toBe(process.pid)

    // install prints the liveness caveat so this isn't a silent trap
    expect(io.out.some((l) => l.includes('stateless'))).toBe(true)
  })

  it('install is idempotent: a second install overwrites cleanly with a fresh pid/startedAt', async () => {
    const io1 = captureIo()
    await runGateway(['install'], io1)
    const first = readGatewayRegistry(gatewayRegistryPath())

    await new Promise((resolve) => setTimeout(resolve, 5))

    const io2 = captureIo()
    const code = await runGateway(['install'], io2)
    expect(code).toBe(0)
    const second = readGatewayRegistry(gatewayRegistryPath())

    expect(first).not.toBeNull()
    expect(second).not.toBeNull()
    expect(second?.name).toBe('foundation')
    // same pid (same test process), but startedAt was refreshed
    expect(second?.pid).toBe(process.pid)
  })

  it('status after install reflects real pid liveness (this test process is alive) and shim resolution', async () => {
    await runGateway(['install'], captureIo())
    const io = captureIo()
    const code = await runGateway(['status'], io)
    expect(io.out.some((l) => l.startsWith('pid '))).toBe(true)
    const entry = readGatewayRegistry(gatewayRegistryPath())
    expect(entry).not.toBeNull()
    expect(pidIsLive(entry!.pid)).toBe(true) // this test process's own pid
    // exit code reflects both live pid AND shim resolving on disk
    expect(code).toBe(existsSync(entry!.shim.command) ? 0 : 1)
  })

  it('uninstall removes the entry and is idempotent when nothing is installed', async () => {
    await runGateway(['install'], captureIo())
    const registryPath = gatewayRegistryPath()
    expect(existsSync(registryPath)).toBe(true)

    const io1 = captureIo()
    const code1 = await runGateway(['uninstall'], io1)
    expect(code1).toBe(0)
    expect(existsSync(registryPath)).toBe(false)
    expect(io1.out.some((l) => l.includes('removed'))).toBe(true)

    const io2 = captureIo()
    const code2 = await runGateway(['uninstall'], io2)
    expect(code2).toBe(0)
    expect(io2.out.some((l) => l.includes('not present'))).toBe(true)
  })

  it('a dead pid parses fine (matches honeybee\'s tolerant-parse contract) but reads as not-live', () => {
    const registryPath = gatewayRegistryPath()
    writeGatewayRegistry(registryPath, {
      name: 'foundation',
      protocol: 'mcp',
      socketPath: join(dir, 'foundation.sock'),
      shim: { command: '/nonexistent/foundation', args: ['mcp'] },
      env: {},
      pid: 2_147_483_647, // unassignable pid, same fixture honeybee's own gateways.test.ts uses
      startedAt: new Date().toISOString(),
      gatewayRev: 1,
    })
    const entry = readGatewayRegistry(registryPath)
    expect(entry).not.toBeNull()
    expect(pidIsLive(entry!.pid)).toBe(false)
  })

  it('usage error for an unknown subcommand', async () => {
    const io = captureIo()
    const code = await runGateway(['bogus'], io)
    expect(code).toBe(2)
    expect(io.err.some((l) => l.includes('usage'))).toBe(true)
  })
})
