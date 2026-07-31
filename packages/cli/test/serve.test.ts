import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { captureIo } from '../src/io.js'
import { runNew } from '../src/commands/new.js'
import { runServe } from '../src/commands/serve.js'

describe('foundation serve', () => {
  let dir: string
  let file: string

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'fdn-cli-serve-'))
    const target = join(dir, 'board')
    await runNew([target], captureIo())
    file = `${target}.fdn.html`
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('starts on an ephemeral port, prints the URL, and stops cleanly on abort', async () => {
    const io = captureIo()
    const controller = new AbortController()

    const runPromise = runServe([file, '--port', '0'], io, { signal: controller.signal })

    // give the server a tick to start and print its URL
    await new Promise((r) => setTimeout(r, 50))
    const urlLine = io.out.find((l) => /^http:\/\/127\.0\.0\.1:\d+$/.test(l))
    expect(urlLine).toBeDefined()

    const res = await fetch(urlLine as string)
    expect(res.status).toBe(200)

    controller.abort()
    const code = await runPromise
    expect(code).toBe(0)
    expect(io.out.some((l) => l.includes('stopped'))).toBe(true)

    // server really is down now
    await expect(fetch(urlLine as string)).rejects.toBeTruthy()
  })

  it('missing file argument is a usage error (exit 2), no server started', async () => {
    const io = captureIo()
    const code = await runServe([], io, { signal: new AbortController().signal })
    expect(code).toBe(2)
    expect(io.err.some((l) => l.includes('usage'))).toBe(true)
  })

  it('a non-numeric --port is a usage error (exit 2)', async () => {
    const io = captureIo()
    const code = await runServe([file, '--port', 'not-a-number'], io, { signal: new AbortController().signal })
    expect(code).toBe(2)
    expect(io.err.some((l) => l.includes('--port must be a number'))).toBe(true)
  })
})
