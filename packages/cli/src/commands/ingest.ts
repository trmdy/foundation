/**
 * `foundation ingest <file> [--commit [-m msg] [--author A]]` — normalize in
 * place: parse -> project, write the canonical text back over the file,
 * print the NormalizationReport lines (API.md CLI section). This is D4's
 * "text editing is an input method": any hand-edited `.fdn.html` gets
 * ingested back to canonical form.
 *
 * `--commit` extends that into the chain (D2): when `<file>.chain` exists,
 * the freshly-parsed document is appended as ONE change — v0's commit grain
 * is whole-document (`replace-document`), not a fine-grained text-diff-to-
 * PatchOp derivation; that finer grain is a recorded follow-up, not this
 * command's job. A no-op ingest (parsed doc canonically identical to the
 * chain's current doc) is detected and the commit is skipped — an empty
 * envelope would be a lie about authorship having happened.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { loadChain, parseDocument, projectDocument, validateDocument } from 'foundation-engine'
import type { NormalizationReport } from 'foundation-engine'
import type { CliIO } from '../io.js'
import { flagString, parseArgs } from '../argv.js'
import { chainPathFor } from './chain.js'

function summarizeReport(report: NormalizationReport): string {
  if (report.lines.length === 0) return 'no normalization changes'
  const counts = new Map<string, number>()
  for (const line of report.lines) counts.set(line.code, (counts.get(line.code) ?? 0) + 1)
  const parts = Array.from(counts.entries()).map(([code, n]) => (n > 1 ? `${code}×${n}` : code))
  return `${report.lines.length} normalization line(s): ${parts.join(', ')}`
}

export async function runIngest(args: string[], io: CliIO): Promise<number> {
  const { positionals, flags } = parseArgs(args)
  const file = positionals[0]
  if (!file) {
    io.stderr('usage: foundation ingest <file> [--commit [-m msg] [--author A]]')
    return 2
  }

  let source: string
  try {
    source = readFileSync(file, 'utf8')
  } catch (err) {
    io.stderr(`could not read ${file}: ${err instanceof Error ? err.message : String(err)}`)
    return 2
  }

  const { doc, report } = parseDocument(source)
  const canonical = projectDocument(doc)

  if (report.lines.length === 0) {
    io.stdout(`${file}: no normalization needed`)
  } else {
    for (const line of report.lines) {
      const where = line.nodeId ? ` [${line.nodeId}]` : ''
      io.stdout(`${line.severity} ${line.code}${where}: ${line.message}`)
    }
  }

  const changed = canonical !== source
  writeFileSync(file, canonical, 'utf8')
  io.stdout(`${file}: ${changed ? 'rewritten to canonical form' : 'already canonical, unchanged'}`)

  const result = validateDocument(doc)
  const exitCode = result.valid ? 0 : 1

  if (flags.commit) {
    const chainPath = chainPathFor(file)
    if (!existsSync(chainPath)) {
      io.stdout(`${file}: --commit requested but no chain yet — run \`foundation chain init ${file}\` to start tracking changes`)
      return exitCode
    }

    const author = flagString(flags, 'author') ?? 'user:local'
    try {
      const chain = loadChain(readFileSync(chainPath), { actor: author })
      const currentCanonical = projectDocument(chain.doc())
      if (currentCanonical === canonical) {
        io.stdout(`${chainPath}: no changes to commit (parsed document matches chain head)`)
      } else {
        const message = flagString(flags, 'm', 'message') ?? (report.lines.length === 0 ? 'ingest' : `ingest — ${summarizeReport(report)}`)
        const envelope = chain.apply({ author, message }, [{ op: 'replace-document', doc }])
        writeFileSync(chainPath, chain.save())
        io.stdout(`${chainPath}: committed ${envelope.hash.slice(0, 12)} (${message})`)
      }
    } catch (err) {
      io.stderr(`chain commit failed: ${err instanceof Error ? err.message : String(err)}`)
      return 2
    }
  }

  return exitCode
}
