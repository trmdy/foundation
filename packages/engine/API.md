# foundation-engine — module contract (L1 wave 1)

Owned by the integrator. Module boundaries and public signatures below are fixed;
implementations live one module per directory. A signature that can't be implemented
as written is a **finding to report**, not a contract to edit. All modules build
against `src/types.ts` only — no cross-module imports in wave 1 except as listed.

## Modules and owners

| Module | Directory | Wave | Implements |
|---|---|---|---|
| Grammar | `src/grammar/` | 1 | element/attribute schema, exclusion list, style-property rules |
| Parse | `src/parse/` | 1 | `.fdn.html` text → `FdnDocument` + `NormalizationReport` |
| Validate | `src/validate/` | 1 | `FdnDocument` → `ValidationResult` |
| Project | `src/project/` | 1 | `FdnDocument` → canonical text (deterministic) |
| Chain | `src/chain/` | 1 | Loro store + envelope + anchors + semantic diff |
| Bake | `src/bake/` | 1 | template + state → `BakeResult` |
| Render | `src/render/` | 2 | pinned-Chromium render + layout report |
| Diff | `src/diff/` | 2 | structural + visual + conformance diff |
| Serve | `src/serve/` | 2 | live-reload server with bake |
| Index | `src/index.ts` | 2 | public API wiring (integrator writes) |

## Fixed signatures

```ts
// parse
parseDocument(html: string): { doc: FdnDocument; report: NormalizationReport }

// validate
validateDocument(doc: FdnDocument): ValidationResult

// project — MUST be a fixpoint with parse: parse(project(doc)) deep-equals doc.
projectDocument(doc: FdnDocument): string

// bake
bakeDocument(doc: FdnDocument, opts?: { state?: string }): BakeResult

// chain
createChain(doc: FdnDocument, meta: ChangeMeta, opts?: { actor?: string }): FdnChain
loadChain(bytes: Uint8Array): FdnChain
interface FdnChain {
  doc(): FdnDocument
  apply(meta: ChangeMeta, ops: PatchOp[]): EnvelopeRecord   // one call = one change
  anchor(name: string): AnchorRef
  checkout(ref: AnchorRef): FdnDocument                      // non-destructive read
  diff(a: AnchorRef, b: AnchorRef): SemanticOp[]
  undo(meta: ChangeMeta): EnvelopeRecord                     // inverse-append
  head(): EnvelopeRecord
  log(): EnvelopeRecord[]
  fork(actor: string): FdnChain
  merge(other: FdnChain): void
  save(): Uint8Array
  verify(): { ok: boolean; brokenAt?: string }               // envelope hash chain
}
```

## Canonical text rules (project)

- 2-space indent; one attribute order everywhere: `id`-attr? no — order is:
  `data-fdn-id`, `class`, ordinary attrs sorted alphabetically, `when`, `each`,
  `data-fdn-style` (styleRef), `style` (declarations sorted alphabetically),
  `style-hover|focus|active|disabled` (in that order, declarations sorted).
- Document sections in fixed order: `<fdn-doc>` header (params, data, lookups,
  states, matrix) → `<fdn-styles>` → `<fdn-component>` definitions (alphabetical)
  → `<main>` body. All metadata elements carry `hidden`.
- `<style>` block contains ONLY `:root { --token: value; }` lines, sorted.
- Stable node ids serialize as `data-fdn-id`.
- No trailing whitespace, LF endings, single trailing newline.

## Node identity

`parseDocument` mints ids for elements lacking `data-fdn-id`: `n<counter>` where the
counter continues from the highest existing minted id in the document. Minting is
deterministic for a given input text.

## Test fixtures

`boards/system-help-center.fdn.html` and `boards/overlay-evidence.fdn.html` are the
primary fixtures (parse → project fixpoint; bake of at least one declared state each).
`boards/inbox-unified.fdn.html` is stretch. Synthetic micro-fixtures per module are
expected and live in the module's test directory.
