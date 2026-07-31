/**
 * `foundation ingest <file>` — normalize in place: parse -> project, write
 * the canonical text back over the file, print the NormalizationReport lines
 * (API.md CLI section). This is D4's "text editing is an input method": any
 * hand-edited `.fdn.html` gets ingested back to canonical form.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { parseDocument, projectDocument, validateDocument } from 'foundation-engine'
import type { CliIO } from '../io.js'
import { parseArgs } from '../argv.js'

export async function runIngest(args: string[], io: CliIO): Promise<number> {
  const { positionals } = parseArgs(args)
  const file = positionals[0]
  if (!file) {
    io.stderr('usage: foundation ingest <file>')
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
  return result.valid ? 0 : 1
}
