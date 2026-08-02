/**
 * Small, dependency-free source-text helpers used by schema.ts's best-effort
 * TS prop-type extraction (see API.md "Wave 4 — component importer", item 2:
 * "best-effort from the component's TS props type"). Deliberately NOT a TS
 * parser: no typescript compiler dependency is installed for this package
 * (see API.md deps list), so extraction is regex + balanced-delimiter text
 * scanning over a source dialect this package's own fixtures are written to
 * stay within. Anything outside that dialect falls through to "require an
 * override" — by design (see harvest error 'schema-unresolvable').
 */

const OPEN = { '{': '}', '(': ')', '[': ']', '<': '>' } as const
type OpenChar = keyof typeof OPEN

/** Given `source[openIndex]` is one of `{([<`, find the index of its match,
 *  respecting nesting and skipping over string/template literals. */
export function findMatchingDelimiter(source: string, openIndex: number): number {
  const openChar = source[openIndex] as OpenChar
  const closeChar = OPEN[openChar]
  if (!closeChar) throw new Error(`findMatchingDelimiter: not an opening delimiter at ${openIndex}`)
  let depth = 0
  for (let i = openIndex; i < source.length; i++) {
    const ch = source[i]
    if (ch === '"' || ch === "'" || ch === '`') {
      i = skipStringLiteral(source, i)
      continue
    }
    if (ch === openChar) depth++
    else if (ch === closeChar) {
      depth--
      if (depth === 0) return i
    }
  }
  throw new Error(`findMatchingDelimiter: unbalanced ${openChar}...${closeChar} starting at ${openIndex}`)
}

function skipStringLiteral(source: string, startIndex: number): number {
  const quote = source[startIndex]
  for (let i = startIndex + 1; i < source.length; i++) {
    if (source[i] === '\\') {
      i++
      continue
    }
    if (source[i] === quote) return i
  }
  return source.length - 1
}

/** Extract the text strictly between the matching `{`/`}` pair that starts
 *  at `openIndex` (exclusive of the braces themselves). */
export function extractBraceBody(source: string, openIndex: number): { body: string; endIndex: number } {
  const endIndex = findMatchingDelimiter(source, openIndex)
  return { body: source.slice(openIndex + 1, endIndex), endIndex }
}

/** Split text at top-level commas only (ignores commas nested inside
 *  `{}`, `()`, `[]`, `<>`, or string/template literals). */
export function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '"' || ch === "'" || ch === '`') {
      i = skipStringLiteral(text, i)
      continue
    }
    if (ch === '{' || ch === '(' || ch === '[' || ch === '<') depth++
    else if (ch === '}' || ch === ')' || ch === ']' || ch === '>') depth--
    else if (depth === 0 && text.startsWith(separator, i)) {
      parts.push(text.slice(start, i))
      i += separator.length - 1
      start = i + 1
    }
  }
  parts.push(text.slice(start))
  return parts.map((p) => p.trim()).filter((p) => p.length > 0)
}

export interface ObjectLiteralEntry {
  key: string
  valueText: string
}

/** Parse the CONTENT of an object literal (already stripped of its outer
 *  `{`/`}`) into `key: valueText` entries, splitting only at top-level
 *  commas/colons. `key` has quotes stripped if present. */
export function parseObjectLiteralEntries(body: string): ObjectLiteralEntry[] {
  const entries: ObjectLiteralEntry[] = []
  for (const segment of splitTopLevel(body, ',')) {
    const colonIndex = findTopLevelColon(segment)
    if (colonIndex === -1) continue
    let key = segment.slice(0, colonIndex).trim()
    if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) {
      key = key.slice(1, -1)
    }
    const valueText = segment.slice(colonIndex + 1).trim()
    entries.push({ key, valueText })
  }
  return entries
}

function findTopLevelColon(segment: string): number {
  let depth = 0
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i]
    if (ch === '"' || ch === "'" || ch === '`') {
      i = skipStringLiteral(segment, i)
      continue
    }
    if (ch === '{' || ch === '(' || ch === '[' || ch === '<') depth++
    else if (ch === '}' || ch === ')' || ch === ']' || ch === '>') depth--
    else if (ch === ':' && depth === 0) return i
  }
  return -1
}

/** Strip a leading/trailing matching brace pair, if present. */
export function unwrapBraces(text: string): string {
  const trimmed = text.trim()
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed.slice(1, -1)
  return trimmed
}

/** Parse a string-literal-only union type, e.g. `'a' | 'b' | "c"`.
 *  Returns null if any member isn't a bare quoted string literal. */
export function parseStringLiteralUnion(typeText: string): string[] | null {
  const members = splitTopLevel(typeText, '|')
  if (members.length === 0) return null
  const values: string[] = []
  for (const member of members) {
    const m = member.trim()
    const isSingle = m.startsWith("'") && m.endsWith("'") && m.length >= 2
    const isDouble = m.startsWith('"') && m.endsWith('"') && m.length >= 2
    if (!isSingle && !isDouble) return null
    values.push(m.slice(1, -1))
  }
  return values
}
