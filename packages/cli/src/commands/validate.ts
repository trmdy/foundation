/**
 * `foundation validate <file>` — print issues, exit 1 on errors (API.md CLI
 * section: "exit codes: 0 ok, 1 validation errors, 2 usage").
 */
import { readFileSync } from 'node:fs'
import { parseDocument, validateDocument } from 'foundation-engine'
import type { CliIO } from '../io.js'
import { parseArgs } from '../argv.js'

export async function runValidate(args: string[], io: CliIO): Promise<number> {
  const { positionals } = parseArgs(args)
  const file = positionals[0]
  if (!file) {
    io.stderr('usage: foundation validate <file>')
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
  const result = validateDocument(doc)

  if (result.issues.length === 0) {
    io.stdout(`${file}: no issues`)
    return 0
  }

  for (const issue of result.issues) {
    const where = issue.nodeId ? ` [${issue.nodeId}]` : ''
    io.stdout(`${issue.severity} ${issue.code}${where}: ${issue.message}`)
  }
  const errorCount = result.issues.filter((i) => i.severity === 'error').length
  io.stdout(`${file}: ${result.issues.length} issue(s), ${errorCount} error(s)`)

  return result.valid ? 0 : 1
}
