/**
 * foundation-cli — project manifest: `foundation.json` (SPEC 13a-iii,
 * resolved 2026-07-31): "a `foundation.json` in the project directory —
 * `{ schema, id, name, documents: [{ path, docId }], designSystem?: <path>,
 * viewports?: defaults }`; the filesystem stays the database, the manifest
 * is the index."
 *
 * This module holds the manifest's on-disk shape plus the read/write/status
 * logic shared by the CLI's `project` command (commands/project.ts, the
 * only place that WRITES a manifest) and the read-only `foundation_project`
 * MCP tool (mcp/tools.ts) — both need the same "list documents + per-doc
 * validate status + chain head" computation, so it lives here rather than
 * being duplicated.
 *
 * A document's `docId` (SPEC 13a-i) is never minted here — this module only
 * ever READS one that already exists, either stamped in the document's own
 * text (`data-fdn-doc-id`, via docid.ts) or recorded in its `<path>.chain`
 * (`FdnChain.docId()`). A document with neither is not addressable by the
 * manifest yet; `addDocument` reports that as a hint, not a mint — minting
 * ids is `foundation new` / `foundation chain init`'s job (see identity.ts's
 * sibling note on where randomness is allowed to live).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { loadChain, parseDocument, validateDocument } from 'foundation-engine'
import { readDocIdAttr } from './docid.js'

export interface ProjectManifestDocument {
  path: string
  docId: string
}

export interface ProjectManifest {
  schema: number
  id: string
  name: string
  documents: ProjectManifestDocument[]
  designSystem?: string
  viewports?: unknown
}

export function manifestPathFor(dir: string): string {
  return join(dir, 'foundation.json')
}

export function readManifest(dir: string): ProjectManifest | null {
  const manifestPath = manifestPathFor(dir)
  if (!existsSync(manifestPath)) return null
  return JSON.parse(readFileSync(manifestPath, 'utf8')) as ProjectManifest
}

export function writeManifest(dir: string, manifest: ProjectManifest): void {
  writeFileSync(manifestPathFor(dir), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
}

export function createManifest(id: string, name: string): ProjectManifest {
  return { schema: 1, id, name, documents: [] }
}

/** Reads a document's id off its own text first (the common case — every
 *  document `foundation new`/`chain init` touches has one stamped in), and
 *  falls back to the sibling `<path>.chain`'s own docId() when the text
 *  doesn't carry one (e.g. a chain-tracked document whose text was hand-
 *  reverted to a pre-stamp copy). Returns null when neither source has one. */
export function readDocId(filePath: string): string | null {
  let source: string
  try {
    source = readFileSync(filePath, 'utf8')
  } catch {
    return null
  }
  const stamped = readDocIdAttr(source)
  if (stamped) return stamped

  const chainPath = `${filePath}.chain`
  if (existsSync(chainPath)) {
    try {
      const id = loadChain(readFileSync(chainPath)).docId()
      if (id) return id
    } catch {
      // fall through to null — a broken chain file isn't this function's problem to report
    }
  }
  return null
}

export type AddDocumentResult =
  | { ok: true; added: boolean; entry: ProjectManifestDocument }
  | { ok: false; message: string }

/** Registers `filePath` in `manifest` (mutates `manifest.documents` in
 *  place; caller is responsible for `writeManifest` afterward — this lets
 *  `project scan` batch many adds into one write). Idempotent by docId: a
 *  second add of the same document (even from a different relative path,
 *  e.g. after a move) updates the existing entry's path instead of creating
 *  a duplicate. */
export function addDocument(dir: string, filePath: string, manifest: ProjectManifest): AddDocumentResult {
  if (!existsSync(filePath)) {
    return { ok: false, message: `could not read ${filePath}: no such file` }
  }
  const docId = readDocId(filePath)
  if (!docId) {
    return {
      ok: false,
      message:
        `${filePath}: no document id found (no data-fdn-doc-id stamped in the text and no ${filePath}.chain) — `
        + `run \`foundation new\` for a fresh document, or \`foundation chain init ${filePath}\` to mint one for an existing file`,
    }
  }

  const path = relative(resolve(dir), resolve(filePath))
  const existing = manifest.documents.find((d) => d.docId === docId)
  if (existing) {
    existing.path = path
    return { ok: true, added: false, entry: existing }
  }

  const entry: ProjectManifestDocument = { path, docId }
  manifest.documents.push(entry)
  return { ok: true, added: true, entry }
}

/** Recursively finds `*.fdn.html` files under `dir`, skipping
 *  `node_modules`/`.git`/dotfiles-dirs — the same shape `foundation project
 *  scan` and the read-only `foundation_project` status walk both need. */
export function findFdnFiles(dir: string): string[] {
  const out: string[] = []
  let entries: import('node:fs').Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...findFdnFiles(full))
    } else if (entry.isFile() && entry.name.endsWith('.fdn.html')) {
      out.push(full)
    }
  }
  return out
}

export interface DocumentStatus {
  path: string
  docId: string
  exists: boolean
  valid: boolean | null
  issueCount: number | null
  errorCount: number | null
  /** Short chain head hash, or null when the document has no `<path>.chain` yet. */
  chainHead: string | null
}

/** The per-document status `project list` and the `foundation_project`
 *  MCP tool both report: validate the document as it sits on disk right
 *  now (not cached from manifest-add time — the manifest is only an index,
 *  never a snapshot) plus its chain head, if any. */
export function documentStatus(dir: string, entry: ProjectManifestDocument): DocumentStatus {
  const filePath = join(dir, entry.path)
  if (!existsSync(filePath)) {
    return { path: entry.path, docId: entry.docId, exists: false, valid: null, issueCount: null, errorCount: null, chainHead: null }
  }

  const source = readFileSync(filePath, 'utf8')
  const { doc } = parseDocument(source)
  const result = validateDocument(doc)
  const errorCount = result.issues.filter((i) => i.severity === 'error').length

  let chainHead: string | null = null
  const chainPath = `${filePath}.chain`
  if (existsSync(chainPath)) {
    try {
      chainHead = loadChain(readFileSync(chainPath)).head().hash
    } catch {
      chainHead = null
    }
  }

  return {
    path: entry.path,
    docId: entry.docId,
    exists: true,
    valid: result.valid,
    issueCount: result.issues.length,
    errorCount,
    chainHead,
  }
}

export function statusLabel(status: DocumentStatus): string {
  if (!status.exists) return 'missing file'
  return status.issueCount === 0 ? 'ok' : `${status.issueCount} issue(s)`
}

export function chainLabel(status: DocumentStatus): string {
  return status.chainHead ? `chain ${status.chainHead.slice(0, 12)}` : 'no chain'
}

export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true })
}
