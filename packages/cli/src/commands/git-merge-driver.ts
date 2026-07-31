/**
 * `foundation git-merge-driver <ancestor> <ours> <theirs>` — a git custom
 * merge driver (gitattributes(5) `%O %A %B` convention). See
 * docs/GIT-INTEGRATION.md for the .gitattributes/`git config` wiring this
 * expects, and for an honest account of what this can and can't do.
 *
 * Contract: git always invokes drivers with THREE temp-file paths (%O the
 * common ancestor, %A "ours" — also the file the driver must overwrite with
 * the result, %B "theirs"); none of the three is guaranteed to be, or be
 * named like, the real repo path. That rules out any reliable way to derive
 * a sibling file's path from these three alone (see mergeFdnHtmlFile below).
 * Exit 0 always: this driver either resolves the merge itself (chain: real
 * CRDT merge; .fdn.html with a usable sibling chain: that chain's
 * projection) or falls back to keeping "ours" with a loud warning — the
 * task brief frames that fallback as a valid, if unsatisfying, "handled"
 * outcome (git shows no conflict markers), not a hard failure.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { loadChain, mergeChains, parseDocument, projectDocument } from 'foundation-engine'
import type { CliIO } from '../io.js'
import { injectDocIdAttr } from '../docid.js'

/** Best-effort file-type sniff: git's temp files don't reliably preserve the
 *  original extension across every git version/platform, so extension AND
 *  content are both checked. `.chain` snapshots are Loro binary (never valid
 *  UTF-8 HTML); `.fdn.html` text always contains `<fdn-doc`. */
function looksLikeChainSnapshot(path: string, bytes: Buffer): boolean {
  if (path.endsWith('.chain')) return true
  if (path.endsWith('.fdn.html') || path.endsWith('.html')) return false
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return !text.includes('<fdn-doc') && !/^\s*<!DOCTYPE/i.test(text)
  } catch {
    return true // not valid UTF-8 at all — definitely not our text format
  }
}

function mergeChainFile(oursPath: string, oursBytes: Buffer, theirsBytes: Buffer, io: CliIO): number {
  try {
    const { merged, overlaps } = mergeChains(oursBytes, theirsBytes)
    writeFileSync(oursPath, merged)
    io.stderr(`git-merge-driver: merged chain (${overlaps.lines.length} concurrent-overlap line(s))`)
    for (const line of overlaps.lines) io.stderr(`  concurrent-overlap: ${line.message}`)
  } catch (err) {
    io.stderr(
      `git-merge-driver: chain merge failed (${err instanceof Error ? err.message : String(err)}) — keeping "ours" unchanged`,
    )
  }
  return 0
}

/**
 * .fdn.html text merge. There is no real structural 3-way merge implemented
 * here — see the module doc for why "find the sibling .chain" can't be made
 * reliable from git's own invocation alone. When a sibling `<oursPath>.chain`
 * DOES happen to exist (e.g. a caller invokes this driver directly with real
 * repo paths, or a future `%P`-aware git config passes them), its projection
 * is used, since that's the actual merged truth. Otherwise: keep "ours" and
 * warn loudly — documented honestly rather than pretending a fake 3-way
 * text merge would be meaningful for a hash-linked-chain document format
 * whose real truth lives in the .chain file, not the text.
 */
function mergeFdnHtmlFile(oursPath: string, theirsPath: string, io: CliIO): number {
  const siblingChainPath = `${oursPath}.chain`
  if (existsSync(siblingChainPath)) {
    try {
      const chain = loadChain(readFileSync(siblingChainPath))
      let text = projectDocument(chain.doc())
      const docId = chain.docId()
      if (docId) text = injectDocIdAttr(text, docId)
      writeFileSync(oursPath, text, 'utf8')
      io.stderr(`git-merge-driver: used sibling merged chain ${siblingChainPath} for the projection`)
      return 0
    } catch (err) {
      io.stderr(
        `git-merge-driver: sibling chain ${siblingChainPath} unusable (${err instanceof Error ? err.message : String(err)}) — falling back`,
      )
    }
  }

  try {
    parseDocument(readFileSync(oursPath, 'utf8')) // sanity check "ours" is still a legal document; report ignored
  } catch {
    // even parsing "ours" failed — proceed anyway, there's nothing better to fall back to.
  }
  try {
    readFileSync(theirsPath, 'utf8')
  } catch {
    // "theirs" unreadable — irrelevant to the fallback, "ours" is already on disk.
  }
  io.stderr(
    `git-merge-driver: no usable sibling merged .chain for ${oursPath} — no structural 3-way text merge is ` +
      'implemented (see docs/GIT-INTEGRATION.md), falling back to "ours" unchanged. Run `foundation chain merge` ' +
      'on the .chain files first (or resolve by hand) for a real merge.',
  )
  return 0
}

export async function runGitMergeDriver(args: string[], io: CliIO): Promise<number> {
  const [ancestorPath, oursPath, theirsPath] = args
  if (!ancestorPath || !oursPath || !theirsPath) {
    io.stderr('usage: foundation git-merge-driver <ancestor> <ours> <theirs>')
    return 2
  }

  let oursBytes: Buffer
  let theirsBytes: Buffer
  try {
    oursBytes = readFileSync(oursPath)
    theirsBytes = readFileSync(theirsPath)
  } catch (err) {
    io.stderr(`git-merge-driver: ${err instanceof Error ? err.message : String(err)}`)
    return 2
  }

  if (looksLikeChainSnapshot(oursPath, oursBytes)) {
    return mergeChainFile(oursPath, oursBytes, theirsBytes, io)
  }
  return mergeFdnHtmlFile(oursPath, theirsPath, io)
}
