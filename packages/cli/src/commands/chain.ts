/**
 * `foundation chain <file> log|verify` — operates on `<file>.chain` beside
 * the document when present; a friendly message when it isn't (API.md CLI
 * section — chains are opt-in, most documents will just be text).
 */
import { readFileSync, existsSync } from 'node:fs'
import { loadChain } from 'foundation-engine'
import type { CliIO } from '../io.js'
import { parseArgs } from '../argv.js'

function chainPathFor(file: string): string {
  return `${file}.chain`
}

export async function runChain(args: string[], io: CliIO): Promise<number> {
  const { positionals } = parseArgs(args)
  const [file, subcommand] = positionals
  if (!file || !subcommand) {
    io.stderr('usage: foundation chain <file> log|verify')
    return 2
  }
  if (subcommand !== 'log' && subcommand !== 'verify') {
    io.stderr(`usage: foundation chain <file> log|verify (got "${subcommand}")`)
    return 2
  }

  const chainPath = chainPathFor(file)
  if (!existsSync(chainPath)) {
    io.stdout(`${file}: no chain yet (${chainPath} not found) — this document is plain text so far`)
    return 0
  }

  let bytes: Uint8Array
  try {
    bytes = readFileSync(chainPath)
  } catch (err) {
    io.stderr(`could not read ${chainPath}: ${err instanceof Error ? err.message : String(err)}`)
    return 2
  }

  const chain = loadChain(bytes)

  if (subcommand === 'log') {
    const entries = chain.log()
    if (entries.length === 0) {
      io.stdout(`${chainPath}: empty chain`)
      return 0
    }
    for (const entry of entries) {
      io.stdout(`${entry.hash}  ${entry.author}  ${entry.message}`)
    }
    return 0
  }

  // subcommand === 'verify'
  const result = chain.verify()
  if (result.ok) {
    io.stdout(`${chainPath}: envelope hash chain OK`)
    return 0
  }
  io.stdout(`${chainPath}: envelope hash chain BROKEN${result.brokenAt ? ` at ${result.brokenAt}` : ''}`)
  return 1
}
