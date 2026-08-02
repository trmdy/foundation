/**
 * Turn a render sample's raw html string into an FdnNode[] tree by REUSING
 * foundation-engine's own `parseDocument` rather than pulling in a second
 * HTML parser (parse5 isn't even resolvable from this package — pnpm's
 * strict node_modules only exposes it to foundation-engine's own source
 * files; deep-importing it here would need a new dependency this task is
 * explicitly told not to add).
 *
 * This is more than a workaround: parseDocument already does exactly the
 * normalization the projection rules ask for — style="" longhand expansion
 * (D1, same rules `expandShorthand` implements), whitespace collapsing, and
 * deterministic `data-fdn-id="n<counter>"` minting in tree order — for free.
 * A render sample's html has no <main>/<body> wrapper, but parseDocument's
 * fallback path (no <main> found under <body>) walks the parsed body's
 * direct children exactly as if they were the document body, which is
 * exactly a bare component fragment.
 */
import { parseDocument } from 'foundation-engine'
import type { FdnNode } from 'foundation-engine'

/** Parse one sample's raw html into its FdnNode[] roots. Report lines from
 *  this incidental parse (spec-version-defaulted, etc.) are discarded —
 *  meaningless outside a real .fdn.html document. */
export function parseSampleHtml(html: string): FdnNode[] {
  const { doc } = parseDocument(html)
  return doc.body
}
