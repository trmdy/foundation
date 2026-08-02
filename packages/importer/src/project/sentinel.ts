/**
 * Sentinel substitution (API.md projection rules): the harness renders string
 * props as `⟦fdn:prop:<name>⟧` in the baseline sample specifically so Stage 2
 * can find WHERE in the output a string prop's value lands (text content or
 * an attribute value) without guessing from a real rendered value that might
 * coincidentally equal other content. Every occurrence becomes `{{ prop.name }}`.
 */
import type { FdnNode, ReportLine } from 'foundation-engine'

const SENTINEL_RE = /⟦fdn:prop:([A-Za-z_][A-Za-z0-9_]*)⟧/g

function substituteString(value: string, seen: Set<string>): string {
  return value.replace(SENTINEL_RE, (_m, name: string) => {
    seen.add(name)
    return `{{ prop.${name} }}`
  })
}

function walk(node: FdnNode, seen: Set<string>): void {
  for (const key of Object.keys(node.attrs)) {
    const v = node.attrs[key]
    if (v !== undefined && SENTINEL_RE.test(v)) {
      SENTINEL_RE.lastIndex = 0
      node.attrs[key] = substituteString(v, seen)
    }
  }
  if (node.text !== undefined && SENTINEL_RE.test(node.text)) {
    SENTINEL_RE.lastIndex = 0
    node.text = substituteString(node.text, seen)
  }
  for (const child of node.children) walk(child, seen)
}

/** Mutates `roots` in place, replacing every sentinel occurrence. Returns the
 *  report lines (one `import-sentinel-substituted` per distinct prop found —
 *  dedup by prop name rather than by occurrence, so a prop substituted in
 *  both a text node and an attribute produces one line, not two). */
export function substituteSentinels(roots: FdnNode[]): ReportLine[] {
  const seen = new Set<string>()
  for (const node of roots) walk(node, seen)
  return [...seen].sort().map((name) => ({
    code: 'import-sentinel-substituted',
    severity: 'info',
    message: `sentinel for prop "${name}" replaced with {{ prop.${name} }}`,
    detail: { prop: name },
  }))
}
