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
loadChain(bytes: Uint8Array, opts?: { actor?: string }): FdnChain
// (actor on load added 2026-07-31: hash-of-bytes peer derivation collides when two
//  independent loads of the same snapshot both edit locally before merging)
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

## Wave 2 signatures

```ts
// render (src/render/) — port of spikes/render learnings into the engine.
interface RenderConfig { viewport: FdnViewport; deviceScaleFactor?: number }
interface LayoutEntry { id: string; x: number; y: number; width: number; height: number }
renderHtml(html: string, config: RenderConfig):
  Promise<{ png: Uint8Array; layout: LayoutEntry[] }>
// Bakes then renders every matrix cell (or the given state/viewport subset).
renderDocument(doc: FdnDocument, opts?: { state?: string; viewport?: string }):
  Promise<Array<{ state: string | null; viewport: FdnViewport; png: Uint8Array; layout: LayoutEntry[]; report: ConformanceReport }>>

// diff (src/diff/)
visualDiff(a: Uint8Array, b: Uint8Array):
  { identical: boolean; diffPixels: number; width: number; height: number; diffPng: Uint8Array | null }
conformanceDiff(a: ConformanceReport, b: ConformanceReport):
  { added: ReportLine[]; resolved: ReportLine[] }

// serve (src/serve/) — node:http + SSE live reload, no new deps.
serveDocument(filePath: string, opts?: { port?: number }):
  Promise<{ url: string; close: () => Promise<void> }>
```

## CLI (packages/cli)

Zero-dependency argv parsing, bin name `foundation`. Commands v0:
`new <name>` · `inspect <file>` · `validate <file>` · `ingest <file>` (normalize
in place + print report) · `bake <file> [--state S] [-o out]` · `render <file>
[--state S] [--viewport V] [-o dir]` · `diff <a.html> <b.html>` (structural via
parse + visual via render) · `serve <file> [--port]` · `chain <file> log|verify`
(operates on `<file>.chain` beside the document when present). Exit codes:
0 ok, 1 validation errors, 2 usage.

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
