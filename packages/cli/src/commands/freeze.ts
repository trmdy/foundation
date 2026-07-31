/**
 * `foundation freeze <file> -o <dest> [--author A] [-m msg]` — crystallize a
 * document into a lock-headered frozen text file (SPEC D4, PRD §4 "Freeze /
 * crystallization"). Refuses to freeze an invalid document (exit 1): frozen
 * files are reviewable artifacts sitting beside real components in a PR,
 * they must be clean, not a snapshot of whatever the author was mid-editing.
 *
 * `foundation freeze --verify <frozenfile>` — parse the lock header, print
 * its fields, recompute the body's sha256, and report ok/broken (exit 0/1).
 *
 * `foundation-engine`'s freeze module (`src/freeze/`) is not re-exported from
 * the package's root `src/index.ts` (out of scope for this command — see its
 * own header), so it's imported here from its module path directly, same as
 * any other engine module would be from inside the engine package.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { loadChain, parseDocument, validateDocument } from 'foundation-engine'
import { freezeDocument, verifyFrozen } from 'foundation-engine/src/freeze/index.js'
import type { CliIO } from '../io.js'
import { flagString, parseArgs } from '../argv.js'

const require = createRequire(import.meta.url)

function engineVersion(): string {
  const pkg = require('foundation-engine/package.json') as { version?: string }
  return pkg.version ?? '0.0.0'
}

function chainPathFor(file: string): string {
  return `${file}.chain`
}

function readChainHead(file: string, io: CliIO): { ok: true; hash: string | null } | { ok: false } {
  const chainPath = chainPathFor(file)
  if (!existsSync(chainPath)) return { ok: true, hash: null }
  try {
    const bytes = readFileSync(chainPath)
    const chain = loadChain(bytes)
    return { ok: true, hash: chain.head().hash }
  } catch (err) {
    io.stderr(`could not read chain ${chainPath}: ${err instanceof Error ? err.message : String(err)}`)
    return { ok: false }
  }
}

function runVerify(target: string, io: CliIO): number {
  let text: string
  try {
    text = readFileSync(target, 'utf8')
  } catch (err) {
    io.stderr(`could not read ${target}: ${err instanceof Error ? err.message : String(err)}`)
    return 2
  }

  const result = verifyFrozen(text)
  if (result.header) {
    io.stdout(`spec=${result.header.spec}`)
    io.stdout(`engine=${result.header.engine}`)
    io.stdout(`doc-sha256=${result.header.docSha256}`)
    io.stdout(`chain-head=${result.header.chainHead}`)
    io.stdout(`frozen-by=${result.header.frozenBy}`)
    io.stdout(`message=${result.header.message}`)
  }

  if (result.ok) {
    io.stdout(`${target}: OK`)
    return 0
  }
  io.stdout(`${target}: BROKEN${result.reason ? ` — ${result.reason}` : ''}`)
  return 1
}

export async function runFreeze(args: string[], io: CliIO): Promise<number> {
  const { positionals, flags } = parseArgs(args)

  const verifyFlag = flagString(flags, 'verify')
  if (verifyFlag !== undefined) return runVerify(verifyFlag, io)
  if (flags.verify === true) {
    const target = positionals[0]
    if (!target) {
      io.stderr('usage: foundation freeze --verify <frozenfile>')
      return 2
    }
    return runVerify(target, io)
  }

  const file = positionals[0]
  const dest = flagString(flags, 'o', 'out', 'output')
  if (!file || !dest) {
    io.stderr('usage: foundation freeze <file> -o <dest> [--author A] [-m msg]')
    return 2
  }

  let source: string
  try {
    source = readFileSync(file, 'utf8')
  } catch (err) {
    io.stderr(`could not read ${file}: ${err instanceof Error ? err.message : String(err)}`)
    return 2
  }

  const { doc } = parseDocument(source)
  const validation = validateDocument(doc)
  if (!validation.valid) {
    io.stderr(`${file}: refusing to freeze an invalid document`)
    for (const issue of validation.issues) {
      if (issue.severity === 'error') io.stderr(`  error ${issue.code}: ${issue.message}`)
    }
    return 1
  }

  const chainHead = readChainHead(file, io)
  if (!chainHead.ok) return 2

  const author = flagString(flags, 'author') ?? 'unknown'
  const message = flagString(flags, 'm', 'message')

  const frozen = freezeDocument(doc, {
    author,
    ...(message !== undefined ? { message } : {}),
    chainHead: chainHead.hash,
    engineVersion: engineVersion(),
  })

  writeFileSync(dest, frozen, 'utf8')
  io.stdout(`wrote ${dest}`)
  return 0
}
