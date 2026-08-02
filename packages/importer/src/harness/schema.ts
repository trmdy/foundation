/**
 * Prop schema extraction — API.md Wave 4 Stage 1, item 2:
 * "best-effort from the component's TS props type (string → string,
 *  boolean → boolean, string-literal union → enum with values, optional-
 *  with-default detection where cheap (cva defaultVariants is a nice-to-
 *  have). Anything else → error telling the caller to pass props override.
 *  Overrides always win."
 *
 * No TypeScript compiler is a declared dependency of this package (see
 * API.md "Deps installed"), so this is deliberately NOT a type checker: it
 * is a small, well-tested regex + balanced-delimiter scan over a source
 * dialect this package's own fixtures are written to stay inside —
 * `export function Name(...)` / `export const Name = (...) => ...` /
 * `export default function Name(...)`, a single destructured parameter
 * annotated with a named `interface XProps { ... }` (optionally
 * `extends VariantProps<typeof xVariants>` for the ShadCN/cva pattern).
 * Anything outside that shape is a legible 'schema-unresolvable' error
 * naming what couldn't be classified, not a silent guess — matching the
 * contract's "anything else → error" rule.
 */
import type { FdnProp, FdnParamType } from 'foundation-engine'
import { HarnessError } from '../errors.js'
import {
  extractBraceBody,
  findMatchingDelimiter,
  parseObjectLiteralEntries,
  parseStringLiteralUnion,
  splitTopLevel,
  unwrapBraces,
} from './text-parse.js'

export interface DetectedComponent {
  /** Name as it exists in the source's own scope (function/const name, or a
   *  synthesized name for an anonymous default export). */
  exportedName: string
  isDefaultExport: boolean
  /** name shown in the artifact: opts.name override > detected > file-derived */
  displayName: string
  /** Raw text between the destructured param's `{` and `}`, or null if the
   *  component's parameter isn't a destructuring pattern. */
  paramDestructureBody: string | null
  /** The annotated props type name (e.g. "ButtonProps"), or null. */
  propsTypeName: string | null
}

const DEFAULT_FN_RE = /export\s+default\s+function\s+([A-Za-z_$][\w$]*)\s*\(/
const NAMED_FN_RE = /export\s+function\s+([A-Za-z_$][\w$]*)\s*\(/
const NAMED_CONST_ARROW_RE = /export\s+const\s+([A-Za-z_$][\w$]*)\s*=\s*\(/
const BARE_DEFAULT_RE = /export\s+default\s+([A-Za-z_$][\w$]*)\s*;?\s*$/m

export function detectComponent(source: string, fileBaseName: string, nameOverride?: string): DetectedComponent {
  let match: RegExpExecArray | null
  let exportedName: string
  let isDefaultExport = false

  if ((match = DEFAULT_FN_RE.exec(source))) {
    exportedName = match[1] as string
    isDefaultExport = true
  } else if ((match = NAMED_FN_RE.exec(source))) {
    exportedName = match[1] as string
  } else if ((match = NAMED_CONST_ARROW_RE.exec(source))) {
    exportedName = match[1] as string
  } else if ((match = BARE_DEFAULT_RE.exec(source))) {
    exportedName = match[1] as string
    isDefaultExport = true
  } else {
    throw new HarnessError(
      'schema-unresolvable',
      'could not locate an exported component function (supported: "export function Name(...)", ' +
        '"export const Name = (...) =>", "export default function Name(...)"); pass opts.name and restructure the export.',
    )
  }

  const parenIndex = match.index + match[0].length - 1
  const closeParenIndex = findMatchingDelimiter(source, parenIndex)
  const paramsText = source.slice(parenIndex + 1, closeParenIndex).trim()

  let paramDestructureBody: string | null = null
  let propsTypeName: string | null = null

  if (paramsText.startsWith('{')) {
    const { body, endIndex } = extractBraceBody(paramsText, 0)
    paramDestructureBody = body
    const remainder = paramsText.slice(endIndex + 1).trim()
    if (remainder.startsWith(':')) {
      const typeAndDefault = remainder.slice(1).trim()
      const eqIndex = topLevelIndexOf(typeAndDefault, '=')
      propsTypeName = (eqIndex === -1 ? typeAndDefault : typeAndDefault.slice(0, eqIndex)).trim()
    }
  } else if (paramsText.length > 0) {
    const simple = /^[A-Za-z_$][\w$]*\s*:\s*([A-Za-z_$][\w$.]*)/.exec(paramsText)
    if (simple) propsTypeName = simple[1] as string
  }

  const displayName = nameOverride ?? exportedName ?? fileBaseName
  return { exportedName, isDefaultExport, displayName, paramDestructureBody, propsTypeName }
}

function topLevelIndexOf(text: string, ch: string): number {
  let depth = 0
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '{' || c === '(' || c === '[' || c === '<') depth++
    else if (c === '}' || c === ')' || c === ']' || c === '>') depth--
    else if (c === ch && depth === 0) return i
  }
  return -1
}

// ——— interface body extraction ———

interface InterfaceInfo {
  body: string
  cvaVarNames: string[]
}

function findInterfaceDeclaration(source: string, typeName: string): InterfaceInfo | null {
  const re = new RegExp(`\\binterface\\s+${escapeRe(typeName)}\\b`)
  const match = re.exec(source)
  if (!match) return null
  const afterName = match.index + match[0].length
  const braceIndex = source.indexOf('{', afterName)
  if (braceIndex === -1) return null
  const between = source.slice(afterName, braceIndex)
  const cvaVarNames = [...between.matchAll(/VariantProps\s*<\s*typeof\s+([A-Za-z_$][\w$]*)\s*>/g)].map(
    (m) => m[1] as string,
  )
  const { body } = extractBraceBody(source, braceIndex)
  return { body, cvaVarNames }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

interface RawField {
  name: string
  optional: boolean
  typeText: string
}

/** Split an interface body into top-level field entries (`;` or newline
 *  separated at brace/paren/angle depth 0). */
function parseInterfaceFields(body: string): RawField[] {
  const segments = splitTopLevel(body.replace(/\/\/.*$/gm, ''), ';')
    .flatMap((seg) => splitTopLevel(seg, '\n'))
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  const fields: RawField[] = []
  for (const seg of segments) {
    const m = /^([A-Za-z_$][\w$]*)(\?)?\s*:\s*(.+)$/.exec(seg)
    if (!m) continue
    fields.push({ name: m[1] as string, optional: m[2] === '?', typeText: (m[3] as string).trim() })
  }
  return fields
}

// ——— cva(...) variant-group + defaultVariants extraction ———

interface CvaInfo {
  /** propName -> ordered enum values */
  groups: Map<string, string[]>
  /** propName -> default value (from defaultVariants) */
  defaults: Map<string, string>
}

function extractCvaInfo(source: string, cvaVarName: string): CvaInfo | null {
  const re = new RegExp(`\\bconst\\s+${escapeRe(cvaVarName)}\\s*=\\s*cva\\s*\\(`)
  const match = re.exec(source)
  if (!match) return null
  const openParenIndex = match.index + match[0].length - 1
  const closeParenIndex = findMatchingDelimiter(source, openParenIndex)
  const argsText = source.slice(openParenIndex + 1, closeParenIndex)

  // The config object is the last top-level object-literal argument.
  const topArgs = splitTopLevel(argsText, ',')
  const groups = new Map<string, string[]>()
  const defaults = new Map<string, string>()
  const configArg = [...topArgs].reverse().find((a) => a.trim().startsWith('{'))
  if (!configArg) return { groups, defaults }

  const configEntries = parseObjectLiteralEntries(unwrapBraces(configArg.trim()))
  const variantsEntry = configEntries.find((e) => e.key === 'variants')
  const defaultsEntry = configEntries.find((e) => e.key === 'defaultVariants')

  if (variantsEntry) {
    const groupEntries = parseObjectLiteralEntries(unwrapBraces(variantsEntry.valueText))
    for (const g of groupEntries) {
      const keyEntries = parseObjectLiteralEntries(unwrapBraces(g.valueText))
      groups.set(
        g.key,
        keyEntries.map((k) => k.key),
      )
    }
  }
  if (defaultsEntry) {
    const defaultEntries = parseObjectLiteralEntries(unwrapBraces(defaultsEntry.valueText))
    for (const d of defaultEntries) {
      const v = stripQuotes(d.valueText)
      if (v !== null) defaults.set(d.key, v)
    }
  }
  return { groups, defaults }
}

function stripQuotes(text: string): string | null {
  const t = text.trim()
  if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'))) return t.slice(1, -1)
  return null
}

// ——— destructure default extraction ———

/** propName -> literal default value, for `{ a = 'x', b = true }` shaped
 *  destructure bodies. Non-literal defaults (expressions) are ignored. */
function parseDestructureDefaults(body: string): Map<string, unknown> {
  const out = new Map<string, unknown>()
  for (const seg of splitTopLevel(body, ',')) {
    const m = /^(?:\.\.\.)?([A-Za-z_$][\w$]*)\s*=\s*(.+)$/s.exec(seg)
    if (!m) continue
    const name = m[1] as string
    const raw = (m[2] as string).trim()
    const strVal = stripQuotes(raw)
    if (strVal !== null) {
      out.set(name, strVal)
    } else if (raw === 'true' || raw === 'false') {
      out.set(name, raw === 'true')
    } else if (/^-?\d+(\.\d+)?$/.test(raw)) {
      out.set(name, Number(raw))
    }
  }
  return out
}

// ——— public entry point ———

export interface SchemaExtractionResult {
  propSchema: FdnProp[]
  /** enum values by prop name — not carried in FdnProp (see finding in
   *  README/report: FdnProp has no `values` field, unlike FdnParam), needed
   *  internally to drive the sample matrix (harness/samples.ts). */
  enumValues: Map<string, string[]>
}

export function extractPropSchema(
  source: string,
  detected: DetectedComponent,
  overrides: FdnProp[] = [],
): SchemaExtractionResult {
  const overrideNames = new Set(overrides.map((o) => o.name))
  const enumValues = new Map<string, string[]>()
  const props = new Map<string, FdnProp>()
  const unclassified: string[] = []

  if (detected.propsTypeName) {
    const iface = findInterfaceDeclaration(source, detected.propsTypeName)
    if (iface) {
      for (const cvaVar of iface.cvaVarNames) {
        const cva = extractCvaInfo(source, cvaVar)
        if (!cva) continue
        for (const [propName, values] of cva.groups) {
          enumValues.set(propName, values)
          props.set(propName, {
            name: propName,
            type: 'enum',
            required: false,
            default: cva.defaults.get(propName),
          })
        }
      }
      for (const field of parseInterfaceFields(iface.body)) {
        const type = classifyFieldType(field.typeText, enumValues, field.name)
        if (type === null) {
          if (!overrideNames.has(field.name)) unclassified.push(field.name)
          continue
        }
        props.set(field.name, { name: field.name, type, required: !field.optional })
      }
    } else {
      unclassified.push(`(props type "${detected.propsTypeName}" not found as an "interface ${detected.propsTypeName} { ... }" declaration)`)
    }
  }

  if (detected.paramDestructureBody) {
    const defaults = parseDestructureDefaults(detected.paramDestructureBody)
    for (const [name, value] of defaults) {
      const existing = props.get(name)
      if (existing) existing.default = value
    }
  }

  const remainingUnclassified = unclassified.filter((name) => !overrideNames.has(name))
  if (remainingUnclassified.length > 0) {
    throw new HarnessError(
      'schema-unresolvable',
      `could not classify prop(s) [${remainingUnclassified.join(', ')}] from the TS type as string | boolean | ` +
        `string-literal-union — pass an override in opts.props for each.`,
      { detail: { props: remainingUnclassified } },
    )
  }

  for (const override of overrides) {
    props.set(override.name, override)
  }

  return { propSchema: [...props.values()], enumValues }
}

function classifyFieldType(typeText: string, enumValues: Map<string, string[]>, fieldName: string): FdnParamType | null {
  const t = typeText.trim()
  if (t === 'string') return 'string'
  if (t === 'boolean') return 'boolean'
  const union = parseStringLiteralUnion(t)
  if (union) {
    enumValues.set(fieldName, union)
    return 'enum'
  }
  return null
}
