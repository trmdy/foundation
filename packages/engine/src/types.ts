/**
 * foundation-engine — core contract types.
 *
 * THE contract file: every engine module (grammar/, parse/, project/, bake/,
 * chain/, render/, diff/) implements against these types. This file is owned
 * by the integrator — implementor agents must NOT edit it; a type that doesn't
 * fit an implementation is a finding to report, not a definition to change.
 *
 * Semantics source: docs/SPEC.md (D1–D4, resolved open questions 1–2, 4, 9–12)
 * and boards/GRAMMAR-FINDINGS.md (the derived syntax).
 */

// ——— document model (template form — SPEC Q10: this IS the document) ———

export type NodeId = string
export type StateStyleKey = 'hover' | 'focus' | 'active' | 'disabled'

/** One element in the design tree. Template form: text/attrs may carry {{ … }}. */
export interface FdnNode {
  /** Stable identity (minted at ingestion, survives projection round-trips). */
  id: NodeId
  /** HTML tag or fdn-* element (fdn-use, fdn-slot, fdn-overlay). */
  tag: string
  /** Ordinary HTML attributes (id, aria-*, src, alt, data-testid, …) plus
   *  data-fdn-* bookkeeping (reserved namespace). Values may interpolate. */
  attrs: Record<string, string>
  /** Canonical longhand style declarations. Values are raw CSS values or
   *  var(--token) references — arbitrary values are legal (D1). */
  style: Record<string, string>
  /** Interaction-state style planes (resolved SPEC Q11). */
  styleStates: Partial<Record<StateStyleKey, Record<string, string>>>
  /** Named-style reference — symbolic in canonical form (SPEC Q12). */
  styleRef?: string
  /** Conditional presence expression (see EXPRESSION GRAMMAR below). */
  when?: string
  /** Iteration: "item in <dataset-or-listprop-ref>". */
  each?: string
  /** Text content (leaf). May interpolate. Mutually exclusive with children
   *  in practice; both present = children win, text is a validation issue. */
  text?: string
  children: FdnNode[]
}

export type FdnParamType =
  | 'string' | 'number' | 'boolean' | 'enum' | 'token' | 'list' | 'record'

export interface FdnParam {
  name: string
  type: FdnParamType
  /** For enum: allowed values. For list/record: item field names (v0: informal). */
  values?: string[]
  /** Bake with no state selected uses this; absent → bake empty + report line. */
  default?: unknown
  description?: string
}

export interface FdnDataSet { name: string; items: Record<string, unknown>[] }

/** Declared lookup table (resolved SPEC Q9 — the enum→value mapping primitive). */
export interface FdnLookup { name: string; entries: Record<string, string> }

export interface FdnState {
  name: string
  /** param name → value assignment */
  assignments: Record<string, unknown>
  viewport?: string
}

export interface FdnViewport { name: string; width: number; height: number }

export interface FdnNamedStyle {
  name: string
  style: Record<string, string>
  styleStates: Partial<Record<StateStyleKey, Record<string, string>>>
}

export interface FdnProp {
  name: string
  type: FdnParamType
  required?: boolean
  default?: unknown
}

export interface FdnComponent {
  name: string
  props: FdnProp[]
  /** Slot names declared via <fdn-slot name="…"> in the body. */
  slots: string[]
  /** Template body: subset nodes, may interpolate and use when/each.
   *  (Sealed capsule bodies are Q3/L1-later — not in this contract yet.) */
  body: FdnNode[]
}

/** The document — template form, one file, one hash, all states (SPEC Q10). */
export interface FdnDocument {
  specVersion: string
  title?: string
  /** :root custom properties — the token layer. */
  tokens: Record<string, string>
  params: FdnParam[]
  data: FdnDataSet[]
  lookups: FdnLookup[]
  states: FdnState[]
  viewports: FdnViewport[]
  matrix: { state: string; viewport: string }[]
  namedStyles: FdnNamedStyle[]
  components: FdnComponent[]
  /** Design content (template form — fdn-use instances are NOT resolved here). */
  body: FdnNode[]
}

// ——— EXPRESSION GRAMMAR (resolved SPEC Q9; reconciled with bake v0) ———
// {{ <expr> }} where <expr> is exactly one of:
//   ref        := prefix '.' ident ('.' ident)*
//   prefix     := 'prop' | 'item' | 'param' | <active-each-binding-name>
//                 // "row in items" makes `row` a dynamically-scoped prefix
//                 // inside that each subtree; `item` is the default binding.
//   ternary    := <cond> '?' <value> ':' <value>
//   lookupref  := ident '[' ref ']'          // ident names an FdnLookup
//   value      := ref | lookupref | quoted-string-literal
//   cond       := ref | ref ('==' | '!=') (quoted-string-literal | number | boolean)
// `when` attributes accept <cond> plus '&&' / '||' / '!' composition
// (precedence: '!' > '&&' > '||').
// NOTHING else: no arithmetic, no method calls, no string operations.
// Conventions: primitive list items are addressed as <binding>.value (the bake
// wraps primitives as { value: item }); doc.tokens keys are stored WITHOUT the
// leading '--' (tokens['color-accent'], referenced as var(--color-accent)).
// The `each` SOURCE ("<alias> in <source>") is its own small grammar, not a ref:
//   source := 'data' '.' ident            // a declared FdnDataSet
//           | 'prop' '.' ident            // a list-typed component prop
//           | 'param' '.' ident           // a list-typed param
// validated against declarations, never through the {{ }} ref checker.

// ——— reports ———

export type Severity = 'error' | 'warning' | 'info'

export interface ReportLine {
  /** Stable machine code, kebab-case, e.g. "excluded-element-dropped",
   *  "shorthand-expanded", "off-token-value", "param-missing-default". */
  code: string
  severity: Severity
  message: string
  nodeId?: NodeId
  detail?: unknown
}

/** Ingestion output (D1: lossy-but-total, every transformation legible). */
export interface NormalizationReport { lines: ReportLine[] }

export interface ValidationResult { valid: boolean; issues: ReportLine[] }

/** Audit plane (D1: report, never reject): off-token values, unused tokens,
 *  missing param defaults hit during bake, undeclared lookup keys, … */
export interface ConformanceReport { lines: ReportLine[] }

// ——— chain (D2 + resolved Q1: Loro under a Foundation envelope) ———

export interface ChangeMeta {
  /** "agent:<bee>" | "user:<id>" */
  author: string
  message: string
}

export interface EnvelopeRecord {
  /** Foundation-owned SHA-256 over (prevHash + author + message + specVersion
   *  + the underlying library commit bytes). Never the library's own id. */
  hash: string
  prevHash: string | null
  author: string
  message: string
  specVersion: string
}

/** Write operations — one PatchOp[] batch = one change = one envelope (D2). */
export type PatchOp =
  | { op: 'insert-node'; parent: NodeId | null; index: number; node: FdnNode }
  | { op: 'remove-node'; id: NodeId }
  | { op: 'move-node'; id: NodeId; parent: NodeId | null; index: number }
  | { op: 'set-attr'; id: NodeId; key: string; value: string | null }
  | { op: 'set-style'; id: NodeId; prop: string; value: string | null; state?: StateStyleKey }
  | { op: 'set-style-ref'; id: NodeId; styleRef: string | null }
  | { op: 'set-text'; id: NodeId; text: string }
  | { op: 'set-when'; id: NodeId; when: string | null }
  | { op: 'set-token'; name: string; value: string | null }
  | { op: 'set-named-style'; style: FdnNamedStyle }
  | { op: 'remove-named-style'; name: string }
  | { op: 'set-component'; component: FdnComponent }
  | { op: 'remove-component'; name: string }
  | { op: 'set-param'; param: FdnParam }
  | { op: 'set-lookup'; lookup: FdnLookup }
  | { op: 'set-state'; state: FdnState }
  | { op: 'replace-document'; doc: FdnDocument }

/** Read-side structural diff, lifted to document vocabulary (SPEC §6). */
export type SemanticOp =
  | { op: 'insert-node'; id: NodeId; parent: NodeId | null; index: number; tag: string }
  | { op: 'remove-node'; id: NodeId }
  | { op: 'move-node'; id: NodeId; parent: NodeId | null; index: number }
  | { op: 'set-attr'; id: NodeId; key: string; value: string | null }
  | { op: 'set-style'; id: NodeId; prop: string; value: string | null; state?: StateStyleKey }
  | { op: 'set-text'; id: NodeId; text: string }
  | { op: 'set-style-ref'; id: NodeId; styleRef: string | null }
  | { op: 'set-when'; id: NodeId; when: string | null }
  | { op: 'section-changed'; section: 'tokens' | 'params' | 'data' | 'lookups' | 'states' | 'viewports' | 'matrix' | 'namedStyles' | 'components' | 'meta'; name: string }

export type AnchorRef = string

// ——— bake output (Q10: derived artifact, never truth) ———

export interface BakeResult {
  /** Fully resolved HTML for one state — browser-ready, engine-generated. */
  html: string
  /** The resolved node tree (interpolations applied, components instantiated,
   *  named styles inlined, when/each evaluated). */
  tree: FdnNode[]
  state: string | null
  report: ConformanceReport
}
