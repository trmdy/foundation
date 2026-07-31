/**
 * Small HTML emitter: resolved FdnNode tree → readable HTML string.
 * Pure, deterministic (sorted attrs/tokens/declarations) — required for the
 * "same doc+state twice → byte-identical html" contract.
 *
 * Derived output only: body content, the token :root block, and the title.
 * No fdn-doc header, no component definitions — those are template-form
 * concerns, not bake output.
 */

import type { FdnDocument, FdnNode } from '../types.js'

const VOID_ELEMENTS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
])

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function renderNode(node: FdnNode, depth: number): string {
  const indent = '  '.repeat(depth)
  const attrParts: string[] = []
  for (const key of Object.keys(node.attrs).sort()) {
    attrParts.push(`${key}="${escapeAttr(node.attrs[key] as string)}"`)
  }
  const styleKeys = Object.keys(node.style).sort()
  if (styleKeys.length > 0) {
    const styleStr = styleKeys.map((k) => `${k}:${node.style[k]}`).join(';')
    attrParts.push(`style="${escapeAttr(styleStr)}"`)
  }
  const openTag = `<${node.tag}${attrParts.length > 0 ? ' ' + attrParts.join(' ') : ''}>`

  if (VOID_ELEMENTS.has(node.tag)) return `${indent}${openTag}`

  const closeTag = `</${node.tag}>`
  const hasChildren = node.children.length > 0
  const hasText = node.text !== undefined && node.text.length > 0

  if (!hasChildren && !hasText) return `${indent}${openTag}${closeTag}`

  if (hasChildren) {
    const inner = node.children.map((c) => renderNode(c, depth + 1)).join('\n')
    return `${indent}${openTag}\n${inner}\n${indent}${closeTag}`
  }

  return `${indent}${openTag}${escapeText(node.text as string)}${closeTag}`
}

export function emitHtml(doc: FdnDocument, tree: FdnNode[]): string {
  const lines: string[] = []
  lines.push('<!-- baked by foundation-engine — derived artifact, do not edit -->')

  const tokenNames = Object.keys(doc.tokens).sort()
  if (tokenNames.length > 0) {
    lines.push('<style>')
    lines.push(':root {')
    for (const name of tokenNames) {
      lines.push(`  --${name}: ${doc.tokens[name]};`)
    }
    lines.push('}')
    lines.push('</style>')
  }

  if (doc.title) {
    lines.push(`<title>${escapeText(doc.title)}</title>`)
  }

  for (const node of tree) {
    lines.push(renderNode(node, 0))
  }

  return lines.join('\n') + '\n'
}
