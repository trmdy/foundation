/**
 * `foundation annotate <file> ...` / `foundation annotations <file>` — CLI
 * surface over the three annotation PatchOps (types.ts: annotate,
 * set-annotation-status, remove-annotation — SPEC D2/D4/13a, "annotations
 * are first-class chain citizens"). Mirrors `ingest --commit`'s write shape
 * (chain.apply + chain.save, then regenerate the canonical text from the
 * merged chain) rather than `chain anchor`'s read-only pattern, since
 * annotating actually changes the document (doc.annotations).
 *
 * Three usages:
 *   foundation annotate <file> --text T [--node id | --x N --y N] [--state S]
 *     mints a new annotation id, chain-commits an `annotate` op.
 *   foundation annotate <file> --resolve <id>
 *   foundation annotate <file> --wontfix <id>
 *     chain-commits a `set-annotation-status` op.
 *   foundation annotations <file>
 *     lists all annotations (open/resolved/wontfix) with their anchors.
 *
 * A missing chain is a hard requirement here (unlike `chain anchor`'s soft
 * "no chain yet" info line): there is nowhere to durably store an annotation
 * without one, so this refuses with exit 2 and a hint to run
 * `foundation chain init` first — same class of guard as `foundation_annotate`
 * (MCP) uses (see mcp/tools.ts).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { loadChain, mintAnnotationId, parseDocument } from 'foundation-engine'
import type { FdnAnnotation, FdnChain } from 'foundation-engine'
import type { CliIO } from '../io.js'
import { flagString, parseArgs } from '../argv.js'
import { defaultAuthor } from '../identity.js'
import { chainPathFor, hasUncommittedEdits, regenerateTextFromChain } from './chain.js'

function loadChainFor(chainPath: string): FdnChain {
  return loadChain(readFileSync(chainPath))
}

function requireChain(file: string, io: CliIO): FdnChain | null {
  const chainPath = chainPathFor(file)
  if (!existsSync(chainPath)) {
    io.stderr(`${file}: no chain yet (${chainPath} not found) — run \`foundation chain init ${file}\` first (annotations need somewhere durable to live)`)
    return null
  }
  try {
    return loadChainFor(chainPath)
  } catch (err) {
    io.stderr(`could not read ${chainPath}: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

/** Commits `ops`, saves `<file>.chain`, and regenerates `<file>`'s canonical
 *  text from the merged chain — UNLESS `file` already has uncommitted edits
 *  sitting in it, in which case the chain write still happens but the text
 *  is left alone (same guard `chain pull`/`chain sync` use, see chain.ts). */
function commitAndSync(
  file: string,
  chain: FdnChain,
  meta: { author: string; message: string },
  ops: Parameters<FdnChain['apply']>[1],
  io: CliIO,
): { hash: string } {
  const chainPath = chainPathFor(file)
  const wasDirty = existsSync(file) && hasUncommittedEdits(file, chain)
  const envelope = chain.apply(meta, ops)
  writeFileSync(chainPath, chain.save())
  if (wasDirty) {
    io.stdout(
      `${file}: has uncommitted edits — not regenerated from the chain (annotation still committed). ` +
        `Run \`foundation ingest ${file} --commit\` first, then re-run this to see the annotation in the text.`,
    )
  } else {
    regenerateTextFromChain(file, chain, io)
  }
  return { hash: envelope.hash }
}

function formatAnnotation(a: FdnAnnotation): string {
  const anchor = a.nodeId !== undefined ? `node=${a.nodeId}` : a.x !== undefined || a.y !== undefined ? `x=${a.x ?? 0},y=${a.y ?? 0}` : '(unanchored)'
  const state = a.state !== undefined ? ` state=${a.state}` : ''
  return `[${a.status}] ${a.id} ${anchor}${state} — ${a.text}`
}

async function runAnnotateCreate(
  file: string,
  flags: Record<string, string | boolean>,
  io: CliIO,
): Promise<number> {
  const text = flagString(flags, 'text')
  if (!text) {
    io.stderr('usage: foundation annotate <file> --text T [--node id | --x N --y N] [--state S]')
    return 2
  }
  const nodeId = flagString(flags, 'node')
  const xRaw = flagString(flags, 'x')
  const yRaw = flagString(flags, 'y')
  const state = flagString(flags, 'state')

  if (nodeId !== undefined && (xRaw !== undefined || yRaw !== undefined)) {
    io.stderr('usage: foundation annotate <file> --text T [--node id | --x N --y N] — pass --node OR --x/--y, not both')
    return 2
  }

  let x: number | undefined
  let y: number | undefined
  if (xRaw !== undefined || yRaw !== undefined) {
    if (xRaw === undefined || yRaw === undefined) {
      io.stderr('usage: foundation annotate <file> --x N --y N (both required together)')
      return 2
    }
    x = Number(xRaw)
    y = Number(yRaw)
    if (Number.isNaN(x) || Number.isNaN(y)) {
      io.stderr(`--x/--y must be numbers, got "${xRaw}"/"${yRaw}"`)
      return 2
    }
  }

  const chain = requireChain(file, io)
  if (!chain) return 2

  const id = mintAnnotationId(chain.doc().annotations)
  const annotation: FdnAnnotation = { id, text, status: 'open' }
  if (nodeId !== undefined) annotation.nodeId = nodeId
  if (x !== undefined) annotation.x = x
  if (y !== undefined) annotation.y = y
  if (state !== undefined) annotation.state = state

  const author = flagString(flags, 'author') ?? defaultAuthor()
  const message = flagString(flags, 'm', 'message') ?? `annotate: ${text}`
  const { hash } = commitAndSync(file, chain, { author, message }, [{ op: 'annotate', annotation }], io)
  io.stdout(`${chainPathFor(file)}: committed ${hash.slice(0, 12)} — annotation ${id} added`)
  return 0
}

async function runAnnotateStatus(
  file: string,
  id: string,
  status: FdnAnnotation['status'],
  flags: Record<string, string | boolean>,
  io: CliIO,
): Promise<number> {
  const chain = requireChain(file, io)
  if (!chain) return 2

  if (!chain.doc().annotations.some((a) => a.id === id)) {
    io.stderr(`${file}: no annotation "${id}" — run \`foundation annotations ${file}\` to list existing ones`)
    return 2
  }

  const author = flagString(flags, 'author') ?? defaultAuthor()
  const message = flagString(flags, 'm', 'message') ?? `annotation ${id}: mark ${status}`
  const { hash } = commitAndSync(file, chain, { author, message }, [{ op: 'set-annotation-status', id, status }], io)
  io.stdout(`${chainPathFor(file)}: committed ${hash.slice(0, 12)} — annotation ${id} marked ${status}`)
  return 0
}

export async function runAnnotate(args: string[], io: CliIO): Promise<number> {
  const { positionals, flags } = parseArgs(args)
  const file = positionals[0]
  if (!file) {
    io.stderr(
      'usage: foundation annotate <file> --text T [--node id | --x N --y N] [--state S]\n' +
        '   or: foundation annotate <file> --resolve <id>\n' +
        '   or: foundation annotate <file> --wontfix <id>',
    )
    return 2
  }

  const resolveId = flagString(flags, 'resolve')
  const wontfixId = flagString(flags, 'wontfix')
  if (resolveId !== undefined && wontfixId !== undefined) {
    io.stderr('usage: foundation annotate <file> --resolve <id> | --wontfix <id> — pass one, not both')
    return 2
  }
  if (resolveId !== undefined) return runAnnotateStatus(file, resolveId, 'resolved', flags, io)
  if (wontfixId !== undefined) return runAnnotateStatus(file, wontfixId, 'wontfix', flags, io)
  return runAnnotateCreate(file, flags, io)
}

export async function runAnnotations(args: string[], io: CliIO): Promise<number> {
  const { positionals } = parseArgs(args)
  const file = positionals[0]
  if (!file) {
    io.stderr('usage: foundation annotations <file>')
    return 2
  }

  const chainPath = chainPathFor(file)
  if (existsSync(chainPath)) {
    let chain: FdnChain
    try {
      chain = loadChainFor(chainPath)
    } catch (err) {
      io.stderr(`could not read ${chainPath}: ${err instanceof Error ? err.message : String(err)}`)
      return 2
    }
    const annotations = chain.doc().annotations
    if (annotations.length === 0) {
      io.stdout(`${file}: no annotations`)
      return 0
    }
    for (const a of annotations) io.stdout(formatAnnotation(a))
    return 0
  }

  // No chain yet: fall back to whatever's already ingested into the text
  // itself (the <fdn-annotations> block round-trips through parse even
  // without a chain — same "text is a valid input method" story as any
  // other .fdn.html content, D4).
  let source: string
  try {
    source = readFileSync(file, 'utf8')
  } catch (err) {
    io.stderr(`could not read ${file}: ${err instanceof Error ? err.message : String(err)}`)
    return 2
  }
  const { doc } = parseDocument(source)
  if (doc.annotations.length === 0) {
    io.stdout(`${file}: no annotations`)
    return 0
  }
  for (const a of doc.annotations) io.stdout(formatAnnotation(a))
  return 0
}
