/**
 * `foundation serve <file> [--port N]` — call serveDocument, print URL, keep
 * alive until SIGINT (API.md CLI section). `opts.signal` is a testing seam:
 * pass an AbortSignal instead of relying on a real SIGINT so tests can stop
 * the server deterministically without touching the process's signal
 * handlers.
 */
import { serveDocument } from 'foundation-engine/src/serve/index.js'
import type { CliIO } from '../io.js'
import { flagString, parseArgs } from '../argv.js'
import { defaultAuthor } from '../identity.js'

export interface ServeRunOptions {
  signal?: AbortSignal
}

export async function runServe(args: string[], io: CliIO, opts?: ServeRunOptions): Promise<number> {
  const { positionals, flags } = parseArgs(args)
  const file = positionals[0]
  if (!file) {
    io.stderr('usage: foundation serve <file> [--port N]')
    return 2
  }

  const portFlag = flagString(flags, 'port', 'p')
  let port: number | undefined
  if (portFlag !== undefined) {
    port = Number(portFlag)
    if (Number.isNaN(port)) {
      io.stderr(`--port must be a number, got "${portFlag}"`)
      return 2
    }
  }

  let handle
  try {
    handle = await serveDocument(file, { author: defaultAuthor(), ...(port !== undefined ? { port } : {}) })
  } catch (err) {
    io.stderr(`could not start server: ${err instanceof Error ? err.message : String(err)}`)
    return 2
  }

  io.stdout(`foundation serve — ${file}`)
  io.stdout(handle.url)
  io.stdout('press Ctrl-C to stop')

  const signal = opts?.signal
  await new Promise<void>((resolve) => {
    if (signal) {
      if (signal.aborted) {
        resolve()
        return
      }
      signal.addEventListener('abort', () => resolve(), { once: true })
      return
    }
    process.once('SIGINT', () => resolve())
    process.once('SIGTERM', () => resolve())
  })

  await handle.close()
  io.stdout('foundation serve — stopped')
  return 0
}
