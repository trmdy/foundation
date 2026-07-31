/**
 * Wave 3 chain exchange (SPEC 13a-iv, API.md "chain exchange"): a
 * content-addressed change-blob directory as the chain's wire form, plus
 * two-chain merge. Filesystem I/O lives here deliberately — unlike the
 * pure wave-1/2 modules, this is explicitly a directory-shaped wire format
 * (`<mailboxDir>/<docId>/<envelope-hash>.fdnc`), so touching disk IS the
 * job. No Date.now()/Math.random() — filenames are content-addressed
 * (envelope hash, already deterministic) and directory listings are sorted
 * before use, so import order is deterministic for a given directory
 * snapshot.
 *
 * Blob format: a 4-byte little-endian length prefix, then that many bytes
 * of `JSON.stringify(EnvelopeRecord)`, then the raw Loro update bytes for
 * that one change (as returned by `FdnChain.changes()`) — the same
 * length-prefixed-header-then-payload shape `chain.ts`'s own save()/load()
 * already uses for its anchors header, just with an envelope instead.
 *
 * ——— OverlapReport heuristic (documented per the task brief's "a simple
 * heuristic is acceptable" allowance) ———
 *
 * Two rejected simpler ideas, in case they look tempting later:
 *   - Flag any property whose materialized value differs between "our doc
 *     right before importing foreign history" and "right after," IF our
 *     before-doc already had SOME value there. Over-reports massively:
 *     genesis sets every node's text/attrs/style, so almost every property
 *     "already had a value" — importing ANY change the other side made to
 *     content we never personally touched looks identical to a genuine
 *     two-sided conflict. Verified experimentally against the
 *     async-designer test below: two designers editing disjoint properties
 *     still triggered false "overlap" lines under this scheme.
 *   - Diff "before" vs. "after [merge/import]" and treat that as "what the
 *     other side changed." Under-reports: Loro resolves same-key conflicts
 *     with last-write-wins, so the side whose write ends up WINNING sees NO
 *     visible local change at all — only the losing side's before/after
 *     diff shows the conflicted key. A conflict where our own write happens
 *     to win is then invisible to us. Also verified experimentally (the
 *     "reports concurrent-overlap" tests below failed under this scheme
 *     whenever the puller's own write outranked the import).
 *
 * What's implemented instead needs a real common ancestor, and compares
 * BOTH sides against it independently of which write Loro ends up keeping:
 *   1. Find the ancestor doc — `FdnChain.docFromUpdates(updates)` replays an
 *      explicit list of raw update-bytes spans (each as produced by
 *      `changes()` / a decoded `.fdnc` blob) into a fresh empty chain and
 *      materializes the result — a pure function of the bytes. For
 *      `mergeChains`, the ancestor is the longest common PREFIX of both
 *      chains' `changes()` envelope-hash sequences replayed this way (both
 *      descend from the same createChain genesis in every case this
 *      codebase produces, so that prefix is a real shared ancestor, not a
 *      guess). For `importBlobs`, it's found by walking each incoming
 *      blob's `prevHash` chain (`findAncestorIndex`) until it lands on a
 *      hash we already have — the real fork point. NOT "changes we've
 *      already pushed to the mailbox": pushing something doesn't mean the
 *      peer we're pulling FROM has actually seen it, so that would swallow
 *      our own not-yet-reconciled edits into the ancestor and hide real
 *      conflicts (verified experimentally — the async-designer scenario's
 *      "reports concurrent-overlap" test fails under that version whenever
 *      the puller had already pushed before pulling, which is the ordinary
 *      case).
 *   2. `local = structuralDiff(ancestor, ourDoc)` — what WE changed since
 *      that shared point.
 *   3. `remote = structuralDiff(ancestor, theirClaim)` — what THEY changed
 *      since that same point, computed independently of our own edits and
 *      of whatever Loro's LWW ends up keeping in our real chain
 *      (`theirClaim` = chainB.doc() for mergeChains; ancestor +
 *      just-imported bytes, excluding our own unshared edits, for
 *      importBlobs).
 *   4. `overlaps` = ops in `remote` whose canonical (id, key) also appears
 *      in `local` — both sides wrote it since the last point they agreed,
 *      regardless of whose write the CRDT ultimately keeps.
 * Only property-level ops (set-attr/set-style/set-text/set-when/
 * set-style-ref/section-changed) participate; insert-node/remove-node/
 * move-node are structural, not "property-level", and are never reported
 * (a known scope limit — e.g. two sides independently reusing the same
 * freshly-minted node id is not detected).
 *
 * Known limitation: `findAncestorIndex` assumes every missing blob's
 * `prevHash` chain eventually reaches a hash we already know (true for any
 * document that shares real history with us, which is every case this
 * codebase produces); a mailbox containing a blob from a genuinely
 * unrelated document (different genesis entirely) can't be traced back and
 * falls back to ancestor = index 0 (empty doc), which then behaves like the
 * rejected "before had a value" scheme for that one foreign branch — a
 * corner case worth knowing about, not solved here. Documented rather than
 * chased further — see the task brief's "pragmatic ... simple heuristic is
 * acceptable".
 */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { EnvelopeRecord, FdnDocument, ReportLine, SemanticOp } from '../types.js'
import type { FdnChain } from './chain.js'
import { loadChain } from './chain.js'
import { structuralDiff } from './model.js'

/** SPEC 13a-iv / API.md "chain exchange" — code "concurrent-overlap". Not in
 *  types.ts (Wave 3 addition, chain-module-owned like FdnChain itself). */
export interface OverlapReport {
  lines: ReportLine[]
}

const BLOB_EXT = '.fdnc'

// ——— blob framing ———

function encodeBlob(envelope: EnvelopeRecord, bytes: Uint8Array): Uint8Array {
  // Fixed key order — deterministic bytes for a logically-identical envelope
  // (mirrors util.ts's stableStringify rationale, inlined here since the
  // envelope's shape is small and fixed rather than arbitrary JSON).
  const json = JSON.stringify({
    hash: envelope.hash,
    prevHash: envelope.prevHash,
    author: envelope.author,
    message: envelope.message,
    specVersion: envelope.specVersion,
  })
  const jsonBytes = new TextEncoder().encode(json)
  const out = new Uint8Array(4 + jsonBytes.length + bytes.length)
  new DataView(out.buffer).setUint32(0, jsonBytes.length, true)
  out.set(jsonBytes, 4)
  out.set(bytes, 4 + jsonBytes.length)
  return out
}

function decodeBlob(buf: Uint8Array): { envelope: EnvelopeRecord; bytes: Uint8Array } {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const jsonLen = view.getUint32(0, true)
  const jsonBytes = buf.subarray(4, 4 + jsonLen)
  const updateBytes = buf.subarray(4 + jsonLen)
  const envelope = JSON.parse(new TextDecoder().decode(jsonBytes)) as EnvelopeRecord
  return { envelope, bytes: updateBytes }
}

async function listBlobFiles(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((f) => f.endsWith(BLOB_EXT))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
}

function requireDocId(chain: FdnChain, fn: string): string {
  const docId = chain.docId()
  if (!docId) {
    throw new Error(`${fn}: chain has no docId — pass { docId } to createChain(doc, meta, opts) at creation time first`)
  }
  return docId
}

// ——— public Wave 3 API (API.md "chain exchange") ———

export async function exportBlobs(chain: FdnChain, dir: string): Promise<{ written: number }> {
  const docId = requireDocId(chain, 'exportBlobs')
  const outDir = join(dir, docId)
  await mkdir(outDir, { recursive: true })
  const existing = new Set(await listBlobFiles(outDir))

  let written = 0
  for (const { envelope, bytes } of chain.changes()) {
    const filename = `${envelope.hash}${BLOB_EXT}`
    if (existing.has(filename)) continue
    await writeFile(join(outDir, filename), encodeBlob(envelope, bytes))
    written++
  }
  return { written }
}

/**
 * Where the incoming (missing) blobs' branch forked from OUR history: walk
 * each missing blob's `prevHash` chain (through OTHER missing blobs if it's
 * a multi-change foreign branch) until it lands on a hash we already know.
 * That hash is a REAL shared point — not a guess like "stuff I've already
 * pushed" (which is wrong: pushing something doesn't mean the peer I'm
 * pulling FROM has seen it, so treating our own freshly-pushed changes as
 * "ancestor" would swallow our own not-yet-reconciled edits into the
 * ancestor and hide real conflicts — see module doc's rejected ideas).
 * When several missing blobs trace back to different points (multi-peer
 * mailbox), the EARLIEST (most conservative — never later than any real
 * shared point) is used.
 */
function findAncestorIndex(
  missing: { envelope: EnvelopeRecord }[],
  changesBefore: { envelope: EnvelopeRecord }[],
): number {
  const knownHashes = new Set(changesBefore.map((c) => c.envelope.hash))
  const envelopeByHash = new Map<string, EnvelopeRecord>()
  for (const c of changesBefore) envelopeByHash.set(c.envelope.hash, c.envelope)
  for (const m of missing) envelopeByHash.set(m.envelope.hash, m.envelope)

  const foundHashes = new Set<string>()
  for (const m of missing) {
    const seen = new Set<string>()
    let cursor = m.envelope.prevHash
    while (cursor !== null && !seen.has(cursor)) {
      seen.add(cursor)
      if (knownHashes.has(cursor)) {
        foundHashes.add(cursor)
        break
      }
      cursor = envelopeByHash.get(cursor)?.prevHash ?? null
    }
  }
  if (foundHashes.size === 0) return 0
  const indexByHash = new Map(changesBefore.map((c, i) => [c.envelope.hash, i]))
  let minIndex = changesBefore.length - 1
  for (const h of foundHashes) {
    const idx = indexByHash.get(h)
    if (idx !== undefined) minIndex = Math.min(minIndex, idx)
  }
  return minIndex + 1
}

export async function importBlobs(chain: FdnChain, dir: string): Promise<{ imported: number; overlaps: OverlapReport }> {
  const docId = requireDocId(chain, 'importBlobs')
  const inDir = join(dir, docId)
  const filesBefore = await listBlobFiles(inDir)
  const changesBefore = chain.changes()
  const knownHashes = new Set(changesBefore.map((c) => c.envelope.hash))
  // Deterministic order: sort by filename (== by envelope hash) rather than
  // directory-listing order, which readdir does not guarantee across OSes.
  const missingFiles = filesBefore.filter((f) => !knownHashes.has(f.slice(0, -BLOB_EXT.length))).sort()

  const missingDecoded: { envelope: EnvelopeRecord; bytes: Uint8Array }[] = []
  for (const filename of missingFiles) {
    const raw = await readFile(join(inDir, filename))
    missingDecoded.push(decodeBlob(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)))
  }

  const pushedPrefixLen = findAncestorIndex(missingDecoded, changesBefore)
  const ancestorUpdates = changesBefore.slice(0, pushedPrefixLen).map((c) => c.bytes)
  const ancestorDoc = chain.docFromUpdates(ancestorUpdates)
  const beforeDoc = chain.doc()

  let imported = 0
  for (const { bytes } of missingDecoded) {
    chain.importUpdate(bytes)
    imported++
  }
  // "What the incoming blobs alone claim, independent of Loro's LWW outcome
  // in our real chain" — ancestor + ONLY the just-imported bytes, excluding
  // any of our own unshared local edits (see module doc: diffing only
  // before/after import alone misses conflicts where our own write wins).
  const remoteDoc = chain.docFromUpdates([...ancestorUpdates, ...missingDecoded.map((m) => m.bytes)])
  return { imported, overlaps: computeOverlapReport(ancestorDoc, beforeDoc, remoteDoc) }
}

export function mergeChains(a: Uint8Array, b: Uint8Array): { merged: Uint8Array; overlaps: OverlapReport } {
  const chainA = loadChain(a)
  const chainB = loadChain(b)

  // Common ancestor (see module doc): the longest shared prefix of both
  // chains' envelope-hash sequences.
  const logA = chainA.changes()
  const logB = chainB.changes()
  let k = 0
  while (k < logA.length && k < logB.length && logA[k]!.envelope.hash === logB[k]!.envelope.hash) k++
  const ancestorDoc = chainA.docFromUpdates(logA.slice(0, k).map((c) => c.bytes))

  const beforeDoc = chainA.doc()
  const remoteDoc = chainB.doc() // B's own claim, independent of merge/LWW outcome
  chainA.merge(chainB)
  return { merged: chainA.save(), overlaps: computeOverlapReport(ancestorDoc, beforeDoc, remoteDoc) }
}

// ——— overlap heuristic (see module doc) ———

/** Canonical (id, key) string for a property-level SemanticOp, or null for
 *  structural ops (insert-node/remove-node/move-node — never "overlap"). */
function touchedKeyOf(op: SemanticOp): string | null {
  switch (op.op) {
    case 'set-attr':
      return `node:${op.id}:attr:${op.key}`
    case 'set-style':
      return `node:${op.id}:style${op.state ? `:${op.state}` : ''}:${op.prop}`
    case 'set-text':
      return `node:${op.id}:text`
    case 'set-when':
      return `node:${op.id}:when`
    case 'set-style-ref':
      return `node:${op.id}:styleRef`
    case 'section-changed':
      return `section:${op.section}:${op.name}`
    default:
      return null
  }
}

function overlapLineFor(op: SemanticOp, key: string): ReportLine {
  if (op.op === 'section-changed') {
    return {
      code: 'concurrent-overlap',
      severity: 'warning',
      message: `${op.section} "${op.name}" was written on both sides`,
      detail: { key },
    }
  }
  const id = 'id' in op ? op.id : undefined
  return {
    code: 'concurrent-overlap',
    severity: 'warning',
    message: `node ${id}: ${key.replace(/^node:[^:]*:/, '')} was written on both sides`,
    ...(id !== undefined ? { nodeId: id } : {}),
    detail: { key },
  }
}

/**
 * Both `local` and `remote` are diffed against the SAME `ancestor` — a key
 * is "concurrent-overlap" when BOTH sides wrote to it since that shared
 * point, regardless of which value Loro's LWW ultimately keeps (see module
 * doc: diffing only before/after the merge misses conflicts where our own
 * side happens to "win" and therefore shows no visible local change).
 */
export function computeOverlapReport(ancestor: FdnDocument, local: FdnDocument, remote: FdnDocument): OverlapReport {
  const localOps = new Map<string, SemanticOp>()
  for (const op of structuralDiff(ancestor, local)) {
    const key = touchedKeyOf(op)
    if (key) localOps.set(key, op)
  }

  const lines: ReportLine[] = []
  for (const op of structuralDiff(ancestor, remote)) {
    const key = touchedKeyOf(op)
    if (key && localOps.has(key)) lines.push(overlapLineFor(op, key))
  }
  return { lines }
}
