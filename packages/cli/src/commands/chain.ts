/**
 * `foundation chain ...` — CLI surface over `<file>.chain` (Loro-backed
 * FdnChain, engine/src/chain). Two argument shapes coexist by design:
 *
 *   - `chain <file> log|verify`         (original v0 shape, kept as-is —
 *     API.md CLI section) — file first, subcommand second.
 *   - `chain init|anchor|diff <file> ...` (new, wave "wire the chain into
 *     the authoring loop") — subcommand first, file second, matching the
 *     brief's literal usage strings and reading naturally as git-style verbs.
 *
 * `chainPathFor`/`writeChainInit` are exported so `new.ts` can init a chain
 * for a freshly-skeletoned document without re-deriving the `<file>.chain`
 * naming convention or the create+save dance.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createChain, loadChain, parseDocument } from 'foundation-engine'
import type { ChangeMeta, EnvelopeRecord, FdnChain, FdnDocument, SemanticOp } from 'foundation-engine'
import type { CliIO } from '../io.js'
import { flagString, parseArgs } from '../argv.js'

export function chainPathFor(file: string): string {
  return `${file}.chain`
}

/** Shared by `chain init` and `new` (auto-init on document birth). Prints its
 *  own error and returns null when `<file>.chain` already exists — callers
 *  decide whether that's fatal (chain init: yes) or a soft warning (new:
 *  no, the document itself was still written successfully). */
export function writeChainInit(file: string, doc: FdnDocument, meta: ChangeMeta, io: CliIO): { chainPath: string; head: EnvelopeRecord } | null {
  const chainPath = chainPathFor(file)
  if (existsSync(chainPath)) {
    io.stderr(`refusing to init: ${chainPath} already exists`)
    return null
  }
  const chain = createChain(doc, meta)
  writeFileSync(chainPath, chain.save())
  return { chainPath, head: chain.head() }
}

function loadChainFor(chainPath: string): FdnChain {
  return loadChain(readFileSync(chainPath))
}

function formatSemanticOp(op: SemanticOp): string {
  switch (op.op) {
    case 'insert-node':
      return `insert-node ${op.id} tag=${op.tag} parent=${op.parent ?? '(root)'} index=${op.index}`
    case 'remove-node':
      return `remove-node ${op.id}`
    case 'move-node':
      return `move-node ${op.id} parent=${op.parent ?? '(root)'} index=${op.index}`
    case 'set-attr':
      return `set-attr ${op.id} ${op.key}=${op.value === null ? '(removed)' : JSON.stringify(op.value)}`
    case 'set-style':
      return `set-style ${op.id}${op.state ? `:${op.state}` : ''} ${op.prop}=${op.value === null ? '(removed)' : JSON.stringify(op.value)}`
    case 'set-text':
      return `set-text ${op.id} text=${JSON.stringify(op.text)}`
    case 'set-style-ref':
      return `set-style-ref ${op.id} styleRef=${op.styleRef === null ? '(removed)' : JSON.stringify(op.styleRef)}`
    case 'set-when':
      return `set-when ${op.id} when=${op.when === null ? '(removed)' : JSON.stringify(op.when)}`
    case 'section-changed':
      return `section-changed ${op.section}.${op.name}`
  }
}

async function runChainInitCommand(positionals: string[], flags: Record<string, string | boolean>, io: CliIO): Promise<number> {
  const file = positionals[0]
  if (!file) {
    io.stderr('usage: foundation chain init <file> [--author A] [-m msg]')
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
  const author = flagString(flags, 'author') ?? 'user:local'
  const message = flagString(flags, 'm', 'message') ?? 'init'

  const result = writeChainInit(file, doc, { author, message }, io)
  if (!result) return 2

  io.stdout(`wrote ${result.chainPath} (head ${result.head.hash.slice(0, 12)})`)
  return 0
}

async function runChainAnchor(positionals: string[], io: CliIO): Promise<number> {
  const [file, name] = positionals
  if (!file || !name) {
    io.stderr('usage: foundation chain anchor <file> <name>')
    return 2
  }

  const chainPath = chainPathFor(file)
  if (!existsSync(chainPath)) {
    io.stdout(`${file}: no chain yet (${chainPath} not found) — run \`foundation chain init ${file}\` first`)
    return 0
  }

  let chain: FdnChain
  try {
    chain = loadChainFor(chainPath)
  } catch (err) {
    io.stderr(`could not read ${chainPath}: ${err instanceof Error ? err.message : String(err)}`)
    return 2
  }

  chain.anchor(name)
  writeFileSync(chainPath, chain.save())
  io.stdout(`${chainPath}: anchored '${name}' at ${chain.head().hash.slice(0, 12)}`)
  return 0
}

async function runChainDiff(positionals: string[], io: CliIO): Promise<number> {
  const [file, anchorA, anchorB] = positionals
  if (!file || !anchorA || !anchorB) {
    io.stderr('usage: foundation chain diff <file> <anchorA> <anchorB>')
    return 2
  }

  const chainPath = chainPathFor(file)
  if (!existsSync(chainPath)) {
    io.stdout(`${file}: no chain yet (${chainPath} not found) — run \`foundation chain init ${file}\` first`)
    return 0
  }

  let chain: FdnChain
  try {
    chain = loadChainFor(chainPath)
  } catch (err) {
    io.stderr(`could not read ${chainPath}: ${err instanceof Error ? err.message : String(err)}`)
    return 2
  }

  let ops: SemanticOp[]
  try {
    ops = chain.diff(anchorA, anchorB)
  } catch (err) {
    io.stderr(`chain diff: ${err instanceof Error ? err.message : String(err)}`)
    return 2
  }

  if (ops.length === 0) {
    io.stdout(`${chainPath}: no differences between '${anchorA}' and '${anchorB}'`)
    return 0
  }

  io.stdout(`${chainPath}: ${anchorA}..${anchorB} (${ops.length} op(s))`)
  for (const op of ops) io.stdout(`  ${formatSemanticOp(op)}`)
  return 0
}

async function runChainLogVerify(file: string, subcommand: string, io: CliIO): Promise<number> {
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
    // oldest first, newest last (log() already returns changes in that order).
    for (const entry of entries) {
      io.stdout(`${entry.hash.slice(0, 12)}  ${entry.author}  ${entry.message}`)
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

export async function runChain(args: string[], io: CliIO): Promise<number> {
  const { positionals, flags } = parseArgs(args)
  const [first] = positionals

  if (first === 'init') return runChainInitCommand(positionals.slice(1), flags, io)
  if (first === 'anchor') return runChainAnchor(positionals.slice(1), io)
  if (first === 'diff') return runChainDiff(positionals.slice(1), io)

  // original shape: chain <file> log|verify
  const [file, subcommand] = positionals
  if (!file || !subcommand) {
    io.stderr('usage: foundation chain <file> log|verify (or: chain init|anchor|diff ...)')
    return 2
  }
  if (subcommand !== 'log' && subcommand !== 'verify') {
    io.stderr(`usage: foundation chain <file> log|verify (got "${subcommand}")`)
    return 2
  }
  return runChainLogVerify(file, subcommand, io)
}
