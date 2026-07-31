/**
 * foundation-engine — grammar schema (D1: closed by schema, not vocabulary).
 *
 * The element allowlist is EXCLUSION-driven: nearly all of HTML5 is legal, plus a
 * fixed vocabulary of `fdn-*` elements for what HTML lacks (SPEC §3). The normative,
 * reviewable list is what's EXCLUDED — scripting, embedded browsing contexts,
 * event-handler attributes, live-media behavior attributes (SPEC D1/§3) — plus the
 * subset's own style-property exclusions (float/clear; position:absolute|fixed
 * outside `fdn-overlay`).
 *
 * This module is pure data + small predicates; it consumes nothing from parse5 and
 * exports nothing library-shaped, so parse/validate/project can each depend on it
 * without leaking implementation types.
 */

// ——————————————————————————————————————————————————————————————————————————
// THE EXCLUSION LIST — single reviewable constant (D1 §3)
// ——————————————————————————————————————————————————————————————————————————

export const EXCLUSIONS = {
  /** Scripting and embedded browsing contexts (D1 §3, normative). */
  elements: [
    'script',
    'noscript',
    'iframe',
    'object',
    'embed',
    'applet',
    'frame',
    'frameset',
    'portal',
  ],

  /**
   * Live media *behavior* attributes (D1 §3: "live media behavior" is excluded,
   * the tag itself is not — `<video>`/`<audio>` remain legal presentational
   * elements, same stance as form controls).
   */
  mediaBehaviorAttrs: ['autoplay', 'loop'],

  /**
   * Event-handler attributes: the whole `on*` namespace (D1 §3: "event-handler
   * attributes"). Matched by pattern, not enumerated — HTML defines ~100 of them.
   */
  eventHandlerAttrPattern: /^on[a-z]+$/i,

  /**
   * Style properties with no closed-subset representation (D1: "no floats").
   * Each carries the corrective message the validator surfaces verbatim
   * (D1: "the error vocabulary is the teaching mechanism").
   */
  styleProperties: {
    float: 'float is not in the subset; use flex on the parent',
    clear: 'clear is not in the subset; use flex/gap on the parent instead of clearing floats',
  } as Record<string, string>,
} as const

export function isExcludedElement(tag: string): boolean {
  return (EXCLUSIONS.elements as readonly string[]).includes(tag.toLowerCase())
}

export function isExcludedAttr(name: string): boolean {
  const lower = name.toLowerCase()
  if (EXCLUSIONS.eventHandlerAttrPattern.test(lower)) return true
  return (EXCLUSIONS.mediaBehaviorAttrs as readonly string[]).includes(lower)
}

export function excludedStylePropertyMessage(prop: string): string | undefined {
  return EXCLUSIONS.styleProperties[prop.toLowerCase()]
}

// ——————————————————————————————————————————————————————————————————————————
// data-fdn-* reserved namespace
// ——————————————————————————————————————————————————————————————————————————

export const DATA_FDN_PREFIX = 'data-fdn-'

export function isReservedAttr(name: string): boolean {
  return name.toLowerCase().startsWith(DATA_FDN_PREFIX)
}

/** Sanctioned interaction-state style planes (resolved SPEC Q11). Order is canonical. */
export const STATE_STYLE_ATTRS = ['style-hover', 'style-focus', 'style-active', 'style-disabled'] as const

// ——————————————————————————————————————————————————————————————————————————
// Broad HTML5 structural/presentational allowlist (D1: "nearly the full semantic
// and presentational vocabulary"). Anything not here and not `fdn-*` is dropped
// at ingestion as an unknown element (report line "unknown-element-dropped").
// ——————————————————————————————————————————————————————————————————————————

export const HTML5_ELEMENTS = new Set<string>([
  // sectioning / structural
  'html', 'head', 'body', 'title', 'meta', 'link', 'base', 'style',
  'main', 'section', 'article', 'aside', 'nav', 'header', 'footer',
  'div', 'span', 'address',
  // headings
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hgroup',
  // text content
  'p', 'hr', 'pre', 'blockquote', 'ol', 'ul', 'li', 'dl', 'dt', 'dd', 'figure', 'figcaption',
  // inline text semantics
  'a', 'em', 'strong', 'small', 's', 'cite', 'q', 'dfn', 'abbr', 'ruby', 'rt', 'rp',
  'time', 'code', 'var', 'samp', 'kbd', 'sub', 'sup', 'i', 'b', 'u', 'mark', 'bdi', 'bdo',
  'span', 'br', 'wbr', 'data',
  // embedded content — image and vector only (no browsing-context embeds, D1)
  'img', 'picture', 'source', 'svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line',
  'polyline', 'polygon', 'defs', 'use', 'symbol', 'clippath', 'mask', 'lineargradient',
  'radialgradient', 'stop', 'text', 'tspan', 'title', 'desc',
  // table
  'table', 'caption', 'colgroup', 'col', 'tbody', 'thead', 'tfoot', 'tr', 'td', 'th',
  // forms — presentational only (D1: "rendered, not functional")
  'form', 'label', 'input', 'button', 'select', 'datalist', 'optgroup', 'option',
  'textarea', 'output', 'progress', 'meter', 'fieldset', 'legend',
  // interactive / misc presentational
  'details', 'summary', 'dialog', 'audio', 'video', 'track', 'canvas',
])

// ——————————————————————————————————————————————————————————————————————————
// fdn-* vocabulary (SPEC §3, boards/GRAMMAR-FINDINGS.md)
// ——————————————————————————————————————————————————————————————————————————

export interface FdnElementRule {
  /** Document-metadata elements are browser-inert (`hidden`) in projection and
   *  never appear as FdnNode instances — they parse into typed structures. */
  metadata: boolean
  /** Attribute names this element recognizes structurally (informational —
   *  the validator uses this for "unexpected attribute" diagnostics on
   *  metadata elements; ordinary content elements fall through to the
   *  general ordinary-attr / reserved-attr rules). */
  knownAttrs?: string[]
  requiredAttrs?: string[]
  allowsChildren: boolean
}

export const FDN_ELEMENTS: Record<string, FdnElementRule> = {
  // header block
  'fdn-doc': { metadata: true, knownAttrs: ['data-fdn-spec-version', 'data-fdn-title'], allowsChildren: true },
  'fdn-params': { metadata: true, allowsChildren: true },
  'fdn-param': {
    metadata: true,
    knownAttrs: ['name', 'type', 'values', 'default', 'description'],
    requiredAttrs: ['name', 'type'],
    allowsChildren: false,
  },
  'fdn-data': { metadata: true, knownAttrs: ['name'], requiredAttrs: ['name'], allowsChildren: true },
  'fdn-item': { metadata: true, requiredAttrs: ['id'], allowsChildren: false },
  'fdn-lookups': { metadata: true, allowsChildren: true },
  'fdn-lookup': { metadata: true, knownAttrs: ['name'], requiredAttrs: ['name'], allowsChildren: true },
  'fdn-entry': { metadata: true, knownAttrs: ['key', 'value'], requiredAttrs: ['key', 'value'], allowsChildren: false },
  'fdn-states': { metadata: true, allowsChildren: true },
  'fdn-state': { metadata: true, knownAttrs: ['name', 'viewport'], requiredAttrs: ['name'], allowsChildren: false },
  'fdn-matrix': { metadata: true, allowsChildren: true },
  'fdn-viewport': {
    metadata: true,
    knownAttrs: ['name', 'width', 'height'],
    requiredAttrs: ['name', 'width', 'height'],
    allowsChildren: false,
  },
  'fdn-cell': {
    metadata: true,
    knownAttrs: ['state', 'viewport'],
    requiredAttrs: ['state', 'viewport'],
    allowsChildren: false,
  },

  // named styles
  'fdn-styles': { metadata: true, allowsChildren: true },
  'fdn-style': { metadata: true, knownAttrs: ['name'], requiredAttrs: ['name'], allowsChildren: false },

  // components
  'fdn-component': { metadata: true, knownAttrs: ['name'], requiredAttrs: ['name'], allowsChildren: true },
  'fdn-props': { metadata: true, allowsChildren: true },
  'fdn-prop': {
    metadata: true,
    knownAttrs: ['name', 'type', 'required', 'default', 'description'],
    requiredAttrs: ['name', 'type'],
    allowsChildren: false,
  },
  'fdn-slot': { metadata: false, knownAttrs: ['name'], requiredAttrs: ['name'], allowsChildren: true },
  'fdn-use': { metadata: false, knownAttrs: ['component'], requiredAttrs: ['component'], allowsChildren: true },
  'fdn-fill': { metadata: false, knownAttrs: ['slot'], requiredAttrs: ['slot'], allowsChildren: true },

  // overlay (resolved SPEC open question 2)
  'fdn-overlay': {
    metadata: false,
    knownAttrs: [
      'data-fdn-role', 'data-fdn-dismiss', 'data-fdn-anchor', 'data-fdn-anchor-ref',
      'data-fdn-anchor-preferred-edge', 'data-fdn-anchor-edge', 'data-fdn-anchor-flip',
      'data-fdn-anchor-offset', 'data-fdn-trigger',
    ],
    allowsChildren: true,
  },
}

export function isFdnElement(tag: string): boolean {
  return Object.prototype.hasOwnProperty.call(FDN_ELEMENTS, tag.toLowerCase())
}

export function isMetadataElement(tag: string): boolean {
  return FDN_ELEMENTS[tag.toLowerCase()]?.metadata === true
}

/** Elements whose ONLY legal `position` values are `absolute`/`fixed` when inside
 *  (or being) an `fdn-overlay` subtree (D1: "one sanctioned overlay context"). */
export const OVERLAY_ELEMENT = 'fdn-overlay'
export const OVERLAY_ONLY_POSITION_VALUES = ['absolute', 'fixed']

export function isKnownTag(tag: string): boolean {
  const lower = tag.toLowerCase()
  return isFdnElement(lower) || HTML5_ELEMENTS.has(lower)
}

// ——————————————————————————————————————————————————————————————————————————
// Shorthand style properties normalization v0 covers (parse/style.ts implements
// the expansion; this table is the reviewable list of *which* properties expand).
// ——————————————————————————————————————————————————————————————————————————

export const SHORTHAND_PROPERTIES = ['padding', 'margin', 'inset', 'border-radius', 'gap', 'font'] as const
