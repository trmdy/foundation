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
import { runImport } from './commands/import.js'
import { runBake } from './commands/bake.js'
import { runRender } from './commands/render.js'
import { runDiff } from './commands/diff.js'
import { runServe } from './commands/serve.js'
import { runChain } from './commands/chain.js'
import { runAnnotate, runAnnotations } from './commands/annotate.js'
import { runFreeze } from './commands/freeze.js'
import { runMcp } from './commands/mcp.js'
import { runGateway } from './commands/gateway.js'
import { runGitMergeDriver } from './commands/git-merge-driver.js'
import { runProject } from './commands/project.js'
import type { CliIO } from './io.js'

const COMMANDS: Record<string, (args: string[], io: CliIO) => Promise<number>> = {
  new: runNew,
  inspect: runInspect,
  validate: runValidate,
  ingest: runIngest,
  import: runImport,
  bake: runBake,
  render: runRender,
  diff: runDiff,
  serve: runServe,
  chain: runChain,
  annotate: runAnnotate,
  annotations: runAnnotations,
  freeze: runFreeze,
  mcp: runMcp,
  gateway: runGateway,
  'git-merge-driver': runGitMergeDriver,
  project: runProject,
}

const USAGE = `foundation — a design-document engine CLI

usage: foundation <command> [args]

commands:
  new <name> [--no-chain]                    write a minimal .fdn.html skeleton (chain-inits it too)
  inspect <file>                             summarize a document
  validate <file>                            print validation issues
  ingest <file> [--commit [-m msg] [--author A]]   normalize in place, print the report
  import <source.tsx> --into <file.fdn.html> [--name N] [--props <json>] [--sealed] [--author A]
                                              harvest a React component and merge it into <file>
                                              (chain-committed when a chain exists)
  bake <file> [--state S] [-o out]           bake a state to HTML
  render <file> [--state S] [--viewport V] [-o dir]   render (Wave 2)
  diff <a.html> <b.html>                     structural (+ visual, when available) diff
  serve <file> [--port N]                    live-reload dev server
  chain init <file> [--author A] [-m msg]    start a chain for <file> (mints a data-fdn-doc-id)
  chain <file> log|verify                    operate on <file>.chain
  chain anchor <file> <name>                 name the chain's current head
  chain diff <file> <anchorA> <anchorB>      show SemanticOps between two anchors
  chain push <file> <dir>                    export missing blobs to <dir>/<docId>/
  chain pull <file> <dir>                    import missing blobs from <dir>/<docId>/, then regenerate
                                              <file> from the merged chain — UNLESS <file> has
                                              uncommitted edits (differs from the chain's pre-pull head),
                                              in which case the chain still imports but the text is left
                                              alone and a warning to run 'ingest --commit' first is printed
  chain sync <file> <dir>                    pull (same text-regeneration/uncommitted-edits behavior as
                                              'chain pull', above) then push
  chain merge <file> <theirs.chain>          merge chains, regenerate <file> text, print overlap report
  annotate <file> --text T [--node id | --x N --y N] [--state S]   leave a new annotation
                                              (chain-committed; requires a chain — see chain init)
  annotate <file> --resolve <id>             mark an annotation resolved
  annotate <file> --wontfix <id>             mark an annotation wontfix
  annotations <file>                         list a document's annotations with status
  freeze <file> -o <dest> [--author A] [-m msg]   crystallize a lock-headered frozen file
  freeze --verify <frozenfile>               check a frozen file's lock header + pedigree
  project init [dir] [--name N]              write a fresh foundation.json manifest
  project add <file>                         register <file> in ./foundation.json (by docId)
  project list [dir]                         list a manifest's documents + validate/chain status
  project scan [dir]                         discover *.fdn.html under dir not yet registered, add them
  mcp                                        run a stdio MCP server exposing Foundation's verbs
  gateway install|uninstall|status           publish/withdraw the operator-gateway registry entry
  git-merge-driver <ancestor> <ours> <theirs>   git merge driver (see docs/GIT-INTEGRATION.md)
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
