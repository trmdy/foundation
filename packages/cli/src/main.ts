#!/usr/bin/env -S npx tsx
/**
 * foundation-cli — entry point (API.md "CLI (packages/cli)"). Zero-dependency
 * argv parsing; bin name `foundation`; tsx is the runtime (this file is the
 * bin target directly — fine for v0 per the task brief).
 *
 * Command dispatch only lives here; every command is a small, independently
 * testable function under ./commands/ that takes (args, io) and returns an
 * exit code — main.ts's only jobs are picking the command and calling
 * process.exit with what it returns.
 */
import { processIo } from './io.js'
import { runNew } from './commands/new.js'
import { runInspect } from './commands/inspect.js'
import { runValidate } from './commands/validate.js'
import { runIngest } from './commands/ingest.js'
import { runBake } from './commands/bake.js'
import { runRender } from './commands/render.js'
import { runDiff } from './commands/diff.js'
import { runServe } from './commands/serve.js'
import { runChain } from './commands/chain.js'
import { runFreeze } from './commands/freeze.js'
import type { CliIO } from './io.js'

const COMMANDS: Record<string, (args: string[], io: CliIO) => Promise<number>> = {
  new: runNew,
  inspect: runInspect,
  validate: runValidate,
  ingest: runIngest,
  bake: runBake,
  render: runRender,
  diff: runDiff,
  serve: runServe,
  chain: runChain,
  freeze: runFreeze,
}

const USAGE = `foundation — a design-document engine CLI

usage: foundation <command> [args]

commands:
  new <name> [--no-chain]                    write a minimal .fdn.html skeleton (chain-inits it too)
  inspect <file>                             summarize a document
  validate <file>                            print validation issues
  ingest <file> [--commit [-m msg] [--author A]]   normalize in place, print the report
  bake <file> [--state S] [-o out]           bake a state to HTML
  render <file> [--state S] [--viewport V] [-o dir]   render (Wave 2)
  diff <a.html> <b.html>                     structural (+ visual, when available) diff
  serve <file> [--port N]                    live-reload dev server
  chain init <file> [--author A] [-m msg]    start a chain for <file>
  chain <file> log|verify                    operate on <file>.chain
  chain anchor <file> <name>                 name the chain's current head
  chain diff <file> <anchorA> <anchorB>      show SemanticOps between two anchors
  freeze <file> -o <dest> [--author A] [-m msg]   crystallize a lock-headered frozen file
  freeze --verify <frozenfile>               check a frozen file's lock header + pedigree
`

export async function runCli(argv: string[], io: CliIO = processIo): Promise<number> {
  const [command, ...rest] = argv
  if (!command || command === '--help' || command === '-h') {
    io.stdout(USAGE)
    return command ? 0 : 2
  }
  const handler = COMMANDS[command]
  if (!handler) {
    io.stderr(`unknown command "${command}"`)
    io.stdout(USAGE)
    return 2
  }
  return handler(rest, io)
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`
if (isMain) {
  runCli(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      processIo.stderr(`internal error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`)
      process.exit(1)
    },
  )
}
