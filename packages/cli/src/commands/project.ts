/**
 * `foundation project ...` — CLI surface over `foundation.json` (SPEC
 * 13a-iii). Four verbs:
 *
 *   - `project init [dir] [--name N]`   write a fresh, empty manifest
 *   - `project add <file>`              register one document (manifest dir = cwd)
 *   - `project list [dir]`              print documents + validate status + chain head
 *   - `project scan [dir]`              discover *.fdn.html not yet registered, add them
 *
 * `add` and `scan` don't mint document ids (SPEC 13a-i keeps randomness at
 * `new`/`chain init`) — a document with neither a stamped `data-fdn-doc-id`
 * nor a chain is reported, not silently skipped or force-added.
 */
import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { basename, relative, resolve } from 'node:path'
import type { CliIO } from '../io.js'
import { flagString, parseArgs } from '../argv.js'
import {
  addDocument,
  chainLabel,
  createManifest,
  documentStatus,
  ensureDir,
  findFdnFiles,
  manifestPathFor,
  readManifest,
  statusLabel,
  writeManifest,
} from '../project.js'
import type { ProjectManifest } from '../project.js'

async function runProjectInit(positionals: string[], flags: Record<string, string | boolean>, io: CliIO): Promise<number> {
  const dir = positionals[0] ?? '.'
  const manifestPath = manifestPathFor(dir)
  if (existsSync(manifestPath)) {
    io.stderr(`refusing to init: ${manifestPath} already exists`)
    return 2
  }

  ensureDir(dir)
  const name = flagString(flags, 'name') ?? basename(resolve(dir))
  const manifest = createManifest(randomUUID(), name)
  writeManifest(dir, manifest)
  io.stdout(`wrote ${manifestPath} (id ${manifest.id}, name "${manifest.name}")`)
  return 0
}

function requireManifest(dir: string, io: CliIO): ProjectManifest | null {
  const manifest = readManifest(dir)
  if (!manifest) {
    const initHint = `foundation project init${dir === '.' ? '' : ` ${dir}`}`
    io.stderr(`no ${manifestPathFor(dir)} — run \`${initHint}\` first`)
  }
  return manifest
}

async function runProjectAdd(positionals: string[], io: CliIO): Promise<number> {
  const file = positionals[0]
  if (!file) {
    io.stderr('usage: foundation project add <file>')
    return 2
  }

  const dir = '.'
  const manifest = requireManifest(dir, io)
  if (!manifest) return 2

  const result = addDocument(dir, file, manifest)
  if (!result.ok) {
    io.stderr(result.message)
    return 1
  }
  if (result.added) {
    writeManifest(dir, manifest)
    io.stdout(`added ${result.entry.path} (docId ${result.entry.docId})`)
  } else {
    io.stdout(`already registered: ${result.entry.path} (docId ${result.entry.docId})`)
  }
  return 0
}

async function runProjectList(positionals: string[], io: CliIO): Promise<number> {
  const dir = positionals[0] ?? '.'
  const manifest = requireManifest(dir, io)
  if (!manifest) return 2

  io.stdout(`${manifestPathFor(dir)} — ${manifest.name} (${manifest.documents.length} document(s))`)
  if (manifest.documents.length === 0) {
    io.stdout(`  (no documents registered — run \`foundation project scan ${dir}\` or \`project add <file>\`)`)
    return 0
  }

  let anyBad = false
  for (const entry of manifest.documents) {
    const status = documentStatus(dir, entry)
    if (!status.exists || (status.errorCount ?? 0) > 0) anyBad = true
    io.stdout(`  ${status.path}  ${statusLabel(status)}  ${chainLabel(status)}`)
  }
  return anyBad ? 1 : 0
}

async function runProjectScan(positionals: string[], io: CliIO): Promise<number> {
  const dir = positionals[0] ?? '.'
  const manifest = requireManifest(dir, io)
  if (!manifest) return 2

  const knownPaths = new Set(manifest.documents.map((d) => d.path))
  const files = findFdnFiles(dir)
  let added = 0
  let skipped = 0

  for (const file of files) {
    const relPath = relative(resolve(dir), resolve(file))
    if (knownPaths.has(relPath)) continue

    const result = addDocument(dir, file, manifest)
    if (!result.ok) {
      io.stdout(`skipped ${relPath}: ${result.message}`)
      skipped++
      continue
    }
    if (result.added) {
      io.stdout(`added ${result.entry.path} (docId ${result.entry.docId})`)
      added++
      knownPaths.add(result.entry.path)
    }
  }

  if (added > 0) writeManifest(dir, manifest)
  io.stdout(`scan ${dir}: ${added} added, ${skipped} skipped, ${manifest.documents.length} total`)
  return 0
}

export async function runProject(args: string[], io: CliIO): Promise<number> {
  const { positionals, flags } = parseArgs(args)
  const [sub, ...rest] = positionals

  if (sub === 'init') return runProjectInit(rest, flags, io)
  if (sub === 'add') return runProjectAdd(rest, io)
  if (sub === 'list') return runProjectList(rest, io)
  if (sub === 'scan') return runProjectScan(rest, io)

  io.stderr('usage: foundation project init|add|list|scan ...')
  return 2
}
