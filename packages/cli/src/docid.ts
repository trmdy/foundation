/**
 * foundation-cli — the `<fdn-doc>` `data-fdn-doc-id` attribute, string-level.
 *
 * Contract finding (SPEC 13a-i, task brief's documented fallback): FdnDocument
 * (packages/engine/src/types.ts) has no field for the document id, and
 * parse/project's Wave-1-fixed signatures (`parseDocument(html)`,
 * `projectDocument(doc)`) round-trip only `data-fdn-spec-version` and
 * `data-fdn-title` on `<fdn-doc>` — there is no channel to carry a third
 * scalar through FdnDocument without editing types.ts, which is out of
 * scope. Per the brief's fallback: the document id lives ONLY in the
 * chain's own metadata (`FdnChain.docId()`, packages/engine/src/chain/
 * chain.ts) and is stamped into the `.fdn.html` TEXT directly by the CLI —
 * bypassing parseDocument/projectDocument entirely — via the two small
 * regex-based helpers below.
 *
 * This is a best-effort text transform, not a parser: it assumes the
 * canonical projector's output shape (the `<fdn-doc ...>` open tag's
 * attributes never contain a literal, unescaped `>` character — true for
 * every value projectDocument() currently emits, since escapeAttr() only
 * escapes `&`/`"`, not `>`, but HTML attribute values are never required to
 * escape `>` either, so a hand-edited document with a title containing `>`
 * could defeat the `[^>]*` scan). Acceptable for a CLI-side, non-canonical
 * bookkeeping detail; documented rather than hidden.
 */
const FDN_DOC_OPEN_RE = /<fdn-doc(\s[^>]*)?>/
const DOC_ID_ATTR_RE = /<fdn-doc[^>]*\sdata-fdn-doc-id="([^"]*)"/

function escapeAttr(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
}

/** Reads `data-fdn-doc-id` off the `<fdn-doc>` open tag, or null if absent. */
export function readDocIdAttr(html: string): string | null {
  const m = DOC_ID_ATTR_RE.exec(html)
  return m?.[1] ?? null
}

/** Stamps `data-fdn-doc-id="<docId>"` onto `<fdn-doc>` — a no-op if one is
 *  already present (never overwrites an existing id; ids are immutable). */
export function injectDocIdAttr(html: string, docId: string): string {
  if (readDocIdAttr(html) !== null) return html
  return html.replace(FDN_DOC_OPEN_RE, (match) => match.replace('<fdn-doc', `<fdn-doc data-fdn-doc-id="${escapeAttr(docId)}"`))
}
