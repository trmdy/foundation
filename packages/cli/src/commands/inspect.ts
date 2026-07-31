/**
 * `foundation inspect <file>` — summary: title, counts of params/states/
 * components/nodes, validation status (API.md CLI section).
 */
import { readFileSync } from 'node:fs'
import { parseDocument, validateDocument } from 'foundation-engine'
import type { FdnNode } from 'foundation-engine'
import type { CliIO } from '../io.js'
import { parseArgs } from '../argv.js'

function countNodes(nodes: FdnNode[]): number {
  let n = 0
  for (const node of nodes) n += 1 + countNodes(node.children)
  return n
}

export async function runInspect(args: string[], io: CliIO): Promise<number> {
  const { positionals } = parseArgs(args)
  const file = positionals[0]
  if (!file) {
    io.stderr('usage: foundation inspect <file>')
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
  const errorCount = result.issues.filter((i) => i.severity === 'error').length
  const warningCount = result.issues.filter((i) => i.severity === 'warning').length
  const infoCount = result.issues.filter((i) => i.severity === 'info').length
  const nodeCount = countNodes(doc.body) + doc.components.reduce((sum, c) => sum + countNodes(c.body), 0)

  io.stdout(`title: ${doc.title ?? '(untitled)'}`)
  io.stdout(`params: ${doc.params.length}`)
  io.stdout(`states: ${doc.states.length}`)
  io.stdout(`components: ${doc.components.length}`)
  io.stdout(`nodes: ${nodeCount}`)
  io.stdout(`valid: ${result.valid}`)
  io.stdout(`issues: ${result.issues.length} (${errorCount} error, ${warningCount} warning, ${infoCount} info)`)

  return result.valid ? 0 : 1
}
