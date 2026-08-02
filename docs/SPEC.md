# Foundation — L0 Specification (skeleton)

**Spec version:** 0.0.1-draft · **Date:** 2026-07-30 · **Author:** Tormod / Ur Solutions
**Status:** skeleton — the four one-way-door decisions are argued; everything after them is
scaffolding with intent notes, to be filled as the engine (L1) forces precision.

Foundation is a methodology and a technology for agent-first HTML design iteration.
This document is the methodology made checkable: a closed grammar, a truth model, a
component contract, and a projection rule. Everything else — the engine, the protocol,
the surfaces, the App — consumes this spec and has no authority over it.

The name is the thesis. In a hive, *foundation* is the pre-embossed wax sheet placed in a
frame: it does not build the comb, it constrains where and how comb can be built. An
opinionated substrate, not a tool.

**Independence stance.** This spec depends on nothing from Apiary, Hive, or Valhall. It
must be implementable by a third party from this document plus the conformance suite.
House integrations (gateway registration, peer sync, comment-mode tee) live in L2/L3
documents, never here.

---

## 1. Terminology

- **Document** — one design artifact: a chain of changes plus the current materialized state.
- **Change** — an immutable, hash-addressed operation batch appended to a document's chain.
- **Anchor** — a named, human-meaningful pointer into the chain (what v0.1 called a snapshot).
- **Projection** — the canonical deterministic text form of a document state.
- **Subset** — the closed HTML/CSS grammar of the document layer (D1).
- **Component** — a named, parameterized, reusable definition: typed props, slots,
  variants. Its body is **native** (subset nodes, fully transparent) or **sealed**
  (a compiled capsule) — see D3.
- **Instance** — a placement of a component with prop bindings and sanctioned overrides.
- **Capsule** — the deterministic compiled body of an imported external component
  (React/Svelte/…): scoped markup + styles; internals excluded from the edit and diff
  surfaces.
- **Token** — a named design value (color, space, type, radius…); the preferred,
  auditable value channel. Raw values are also legal — see D1.
- **Param** — a declared document input; **state** — one assignment of params;
  **matrix** — the declared set of states × viewports a document renders under.
- **Design system document** — a document whose exports (tokens, components, named
  styles) other documents inherit; the Product-level unit.
- **Freeze** — emitting a projection + lock into a repo as a reviewable artifact.

---

## 2. Decisions (one-way doors)

Four decisions are load-bearing and effectively irreversible once documents exist in the
wild. They are argued here in full. Nothing else in this spec has that status.

### D1 — The document layer is a closed subset of HTML: closed by schema, not by vocabulary.

The grammar is spelled in real HTML wherever HTML has a word for the concept:

- **Structure:** a broad allowlist of HTML5 elements — nearly the full semantic and
  presentational vocabulary, semantic tags expressly included; the list worth writing
  down is the *exclusions* (scripting, embedded browsing contexts, event-handler
  attributes — §3). `fdn-*` custom elements exist only for semantics HTML lacks:
  component definitions, instances, slots, conditionals. Closure does its work in
  attributes, styling, and values, not in the tag list.
- **Layout:** flex and grid composition only. No floats, no absolute positioning except
  inside the one sanctioned overlay context, no magic-number geometry.
- **Values:** arbitrary values are legal — `padding: 13px` is a valid document, not an
  error. Tokens (CSS custom properties, `padding: var(--space-4)`) are the preferred
  channel and the one the conformance plane audits against a design system: off-token
  values are *reported*, never rejected. What is constrained is **form, not choice** —
  values are stored in one canonical form, and context-dependent constructs (complex
  `em` chains, ambiguous percentages) are resolved to predictable units at ingestion.
- **Cascade:** styles attach to nodes or named styles; no descendant selectors, no
  specificity games, no `!important`. Style resolution is local and total.
- **Script:** none in the document layer. Conditional UI is declarative (§4).

Why a closed subset: agents are unreliable at open CSS because open CSS is ambiguous —
five ways to center a box, non-local cascade effects, unitless magic. A closed subset
makes agent edits *semantically diffable*, renders deterministic by construction, and
turns "does this follow the design system" from a review opinion into a validation
result. The subset is to design what a type system is to code.

Why HTML syntax and not an invented vocabulary: closure lives in the schema and the
validator, not in the tag names. Agents are natively trained on HTML and humans read it
fluently; an invented lexicon spends that prior and buys nothing the validator doesn't
already provide. Generation fluency comes from the training distribution; reliability
comes from the validation loop — take the first where it's free, enforce the second
where it's cheap.

**Liberal ingestion, strict projection** (with D4): input may be loose, and
normalization is **lossy but total**. Agents write ordinary HTML and CSS; the ingester
converts as well as it can — structures map to their subset equivalents (`float` →
flex on the parent), loose CSS (inline, classes, stylesheets) is lifted into the
node/named-style model ("styles directly", never stylesheets in the canonical form),
and unsupported *constructs* are rewritten to canonical equivalents (complex `em`/
`rem` chains resolved to predictable units, shorthands expanded) — each rewrite an
**exact, spec-fixed rule with one deterministic output**, never best-effort. Values
themselves are not policed (D1): 13px stays 13px. Hard rejection is reserved for the
unrepresentable: script and behavior. Every conversion emits a **normalization
report** naming each rewrite and each drop — the report and the validator's corrective
errors are the teaching mechanism, and the conformance fixtures enumerate common HTML
and CSS with their required normalizations. That is how the uncanny-valley risk ("it
looks like HTML, so surely all of HTML works") is managed: not by refusing loose
input, but by making every transformation legible.

Alternatives rejected:

1. **Full HTML/CSS with lints.** Rejected: lints are advisory, so every guarantee
   downstream (deterministic render, semantic diff, token audit) becomes probabilistic.
   The whole engine inherits the ambiguity we built Foundation to remove.
2. **An invented element vocabulary** (`frame`, `text`, `overlay` — this spec's own
   first draft). Rejected: fights the training prior of every agent and the reading
   fluency of every human for a closure guarantee the schema provides anyway, and
   degrades the projection's browser-openability from "renders meaningfully" to
   "renders as nothing."
3. **Tailwind-classes-as-the-subset.** Rejected: Tailwind constrains values but not
   structure or cascade, ties the format to a third party's release train, and its
   class-string encoding is hostile to structural diffing. We steal its lesson
   (constraint wins) and not its encoding.
4. **A proprietary JSON scene graph (Figma-style, GrapesJS-style — the Veft v0.1 plan).**
   Rejected: loses the single biggest asset of HTML-native design — the projection is
   viewable, greppable, and reviewable everywhere — and re-creates the translation-loss
   problem Foundation exists to kill.

### D2 — Truth is a hash-linked chain of changes. Undo is a new change.

A document is an append-only DAG of immutable, content-addressed changes. The
materialized state is a pure fold over the chain. Cmd+Z appends the inverse change;
history is never rewritten. Anchors name points in the chain; freeze pins one.

**Granularity (resolved 2026-07-31):** one change = one patch-verb batch = one undo
step = one authored unit (one envelope, one hash, one author, one message).
Finer-grained input — keystrokes, drag ticks — batches client-side before commit and
never enters the chain individually.

Why: this gives multiplayer (changes merge), local-first (chains sync lazily and
offline), audit (every change carries authorship — `agent:<bee>` or `user:<id>`), and
time-travel diffing ("render anchor 12 vs anchor 9") from one primitive. It is also the
only truth model under which *agents and humans are the same kind of author* — both
just append changes.

This is not novel technology and must not be built as if it were: it is the
CRDT-with-retained-history category. **Trade study (open, blocking L1):** three
candidates, and the decisive criterion is **tree move** — the document is a DOM tree,
reparenting is a core agent verb, and naive approaches duplicate subtrees or create
cycles under concurrency. **Loro** (lean): git-like op DAG, frontiers time-travel,
fork/merge, and production movable-tree/movable-list types — the only candidate
covering history semantics *and* move natively; younger project, op identity is
(peer, counter) not cryptographic hashes. **Automerge 3**: D2's architecture verbatim
(SHA-256 change DAG, native authorship/messages, built-in diff-between-heads; the old
memory objection died with 3.0's ~10× reduction) — but move is published research, not
a shipped operation. **Yjs** (demoted): merge kernel only — no content addressing, no
change metadata, history fights compaction, no move; the entire chain layer would be
hand-rolled around it, and the "house rails" advantage is small since L2 owns sync
regardless. Whichever wins, a thin **Foundation change envelope** (author, message,
spec version, SHA-256 over the envelope) wraps library change blocks: freeze locks and
chain-head hashes are Foundation's own, the spec never names the library normatively,
and migration is replay. The spec fixes the *semantics* (immutable DAG, inverse-change
undo, anchors); the engine picks the implementation.

Alternatives rejected:

1. **Git as the version store** (the adversarial-review position). Rejected as the
   *truth* layer: git's grain is the commit, and design iteration produces dozens of
   sub-review states per hour that must merge live across authors; git cannot merge
   concurrent edits to one file without a human. Git remains the *distribution* layer —
   frozen projections live in repos (D4).
2. **Mutable current-state + snapshot copies** (Veft v0.1's SQLite model). Rejected:
   loses merge, loses authorship-per-change, makes undo destructive, and multiplayer
   would have to be bolted on later against the data model.

### D3 — Components are first-class citizens; external code enters through an importing compiler.

Users and agents must be able to think in higher-level reusable components, not raw
HTML — so the component model is native to the grammar, not an attachment:

- A **component** is a named, parameterized definition — typed props, slots, variants —
  living in a document or a Product design-system document. An **instance** places a
  component with prop bindings and sanctioned overrides. Both are grammar primitives
  (§3): visible in every surface, selectable, movable, diffable. "`Button.primary`
  padding token changed" is one semantic change that ripples to every instance — not N
  text edits.
- A definition's **body** is one of two kinds:
  - **Native** — subset nodes. Fully transparent: editable, diffable, token-audited
    like any other content. The default, and what agents create when they extract
    repetition into a component.
  - **Sealed** — a compiled **capsule** (scoped markup + arbitrary CSS) produced by the
    importer. Internals are excluded from the edit and diff surfaces; the props
    contract, placement, variants, and layout participation remain fully manipulable.
    The capsule retains structure metadata (internal node geometry) so surfaces can
    anchor annotations *inside* it even though edits cannot reach there.
- **The importer** (a sidecar toolchain) brings external components — React, Svelte,
  ShadCN, icon sets — into the model: source + pinned dependencies + declared props
  schema → a content-addressed component definition, deterministically. It is
  **transparent by default**: render output is projected into the subset through the
  same lossy-but-total normalization as any other input (D1) — canonical rewrites,
  normalization report — and emitted as a *native* body: editable,
  ejectable, linked back to its source for divergence tracking. There is no fidelity
  gate; the report, not a threshold, carries the loss. The sealed capsule exists only
  for output normalization cannot represent at all (canvas-drawn internals,
  pseudo-element art). Either way, **determinism is enforced at
  compile, not requested**: no network, frozen clock, seeded randomness; banned APIs
  (storage, timers beyond animation, IO) fail the compile with a legible error.
  "Presentational only" is a compiler guarantee, not a norm.

Sealing is therefore a property of a definition's *body*, never of componenthood:
every component, native or sealed, is equally a first-class, visible, manipulable
citizen of the document. Icon libraries are the degenerate case of the import contract
(props: `name`, `size`, `color` — token-bound) and need no separate mechanism.

Alternatives rejected:

1. **Inline the render output into the document.** Rejected: breaks D1's closed grammar
   and poisons the diff surface with generated noise.
2. **Live-mount components at render time** (import from `node_modules` in the
   renderer). Rejected: render output now varies with the consumer's dependency tree —
   two machines disagree about what the design *is*.
3. **Curated component whitelist only.** Rejected: recreates the walled-garden pain
   Foundation exists to remove; the contract, not curation, is the boundary.
4. **Opaque-embeds-only** (this spec's own first draft: external components as sealed
   glyphs, no native component primitive). Rejected: makes components second-class —
   invisible internals, props-only interaction — and leaves users and agents thinking
   in raw HTML everywhere except at sealed boundaries, defeating the point of a
   component model.

### D4 — The chain is truth; the projection is canonical, deterministic text.

Live collaboration needs the chain (D2). Agents, repos, editors, and PR review need
text. Both are served by one rule:

- Every document has exactly one **canonical projection**: a deterministic,
  stable-ordered, whitespace-normalized text serialization in the subset grammar —
  the **unresolved template form** (parameterized content symbolic; resolved
  per-state trees are derived bake artifacts, not canonical text — open question 10,
  resolved)
  (proposed extension: `.fdn.html` — HTML-flavored so browsers and existing tooling can
  still open it; see §7).
- Any edit to projected text — by an agent with a file tool, a human in an editor, a PR
  suggestion — is **ingested**: parsed, validated against the subset, diffed against the
  current state, and appended to the chain as an ordinary change. Text editing is not a
  second truth; it is an input method.
- **Freeze** = write the projection + a lock header (spec version, engine version,
  chain-head hash, imported-component artifact hashes) into a repo. Frozen files are dead text with a
  verifiable pedigree — reviewable in the same PR as the component they sit beside, and
  re-hydratable into a live chain on demand.

Alternatives rejected:

1. **Text as truth, chain as cache.** Rejected: concurrent multiplayer edits to one text
   file reduce to git-merge semantics — see D2.1.
2. **Chain as truth, no canonical projection** (export-only, Figma-style). Rejected:
   kills the repo story, PR review, grep, and the independence stance in one stroke;
   agents would be back to manipulating truth through an RPC keyhole.

---

## 3. Document model & grammar — *skeleton*

Intent: real product UI spelled in HTML (D1), permissively. The element allowlist is
nearly all of HTML5 — the full semantic set (`article`, `aside`, `figure`, `time`,
tables, definition lists, …) expressly included, and form controls included as
*presentational* elements (rendered, not functional). The normative list is the
**exclusions**: scripting (`script`), embedded browsing contexts (`iframe`, `object`),
event-handler attributes, live media behavior. On top: `fdn-*` elements for what HTML
lacks — `fdn-component` (definition: props, slots, variants), `fdn-use` (instance
with prop bindings), `fdn-slot` — and `when`/`each` attributes for declarative
conditionals (§4), plus one sanctioned overlay context (open question 2). Everything
outside the grammar is normalized in where mappable (D1) before validation rejects
the remainder.

Decided leans from the grammar spike (evidence: `boards/GRAMMAR-FINDINGS.md`):
inline `<svg>` is legal subset content (embedded content model, not scripting);
`fdn-*` elements and `data-fdn-*` attributes are a **reserved namespace** for grammar
bookkeeping — ordinary HTML attributes (`id`, `aria-*`, `data-testid`) coexist freely;
all metadata/definition elements (`fdn-doc` header block, `fdn-styles`,
`fdn-component` definitions) are **browser-inert** in the projection via the `hidden`
attribute, so a plain browser renders only design content.

To fill: the exclusion list made exact, attribute enumeration per element, full
grammar (schema), node identity rules (stable ids for diff/anchoring/comments), named
styles (see open question 12), component/variant declaration syntax, inheritance from
design system documents (both boards duplicated their full token + component sets for
lack of it — finding b.6).

## 4. Tokens, params, conditionals, data — *skeleton*

Intent: tokens are the preferred, audited value channel (D1 — raw values legal);
params are the only variability channel. Declarative conditionals (`when` on nodes) and iteration over declared sample
data — no expressions beyond comparison and boolean composition; if a design needs more
logic, that logic belongs in an imported component. Sample data is declared in-document or inherited
from the design system document, so states are self-contained and renderable headless.
To fill: token taxonomy and theming (light/dark as token planes), param types —
including `enum`, `token`, and structured `list`/`record` shapes (finding b.4: real
component props are lists, e.g. keyboard chord groups) — state declaration syntax, the
matrix declaration (states × viewports), the **interpolation facility** (open
question 9 — the grammar spike found this more foundational than `when`/`each`: props
are inert without a way into text and attribute values), and a bounded value-mapping
primitive (open question 9; finding b.2: enum→style mapping via N `when` branches
scales linearly and badly).

## 5. Render contract — *skeleton*

Intent: pixel output is a pure function of (projection hash × render-config hash).
Pinned browser engine revision, bundled font set, frozen clock, seeded PRNG, animations
disabled, declared viewport set and DPR. Output: per-state PNG + layout report (node
geometry) addressable by content hash — cacheable and comparable across machines and
time.

**Resolved 2026-07-31 (spikes: `spikes/render/RESULTS.md`, `CROSS-MACHINE.md`,
macOS-arm64 vs linux-x86_64):** renders are bit-identical run-to-run per (platform,
pinned browser). Cross-machine, **bundled fonts are the determinism boundary**: with
the same embedded font file, element geometry is float-exact across OS text stacks
(CoreText vs FreeType); all observed divergence came from OS system-font resolution.
The contract therefore: (1) render-time font resolution never touches OS fonts —
generic families map deterministically onto the pinned bundled set; (2) **layout
identity is a hard cross-machine guarantee** (pending adversarial font fixtures —
ligatures, fallback, CJK — before 1.0); (3) pixels are two-tier — byte-identical per
platform, with **linux-x86_64 headless as the reference platform** producing canonical
pixels for freeze verification and QA diffing; renders elsewhere are previews compared
under pixelmatch tolerance.

To fill: exact pinning mechanism, the layout-report schema, capsule hydration rules
at render time.

## 6. Diff semantics — *skeleton*

Intent: three diff planes, all first-class engine outputs: **structural** (tree +
property operations between two states, in subset vocabulary — "padding token changed
on `hero.cta`", never byte ranges), **visual** (per-state pixel diff with changed-region
geometry), **conformance** (token/audit delta: new violations, resolved violations).
To fill: diff document schema (this schema is itself a Foundation-adjacent format —
review surfaces will render it), matrix-level rollups.

## 7. Projection & freeze format — *skeleton*

Intent: `.fdn.html` — a constrained HTML5 document with `data-fdn-*` carrying subset
semantics; opens in any browser (degraded but visible), parses with any HTML parser,
validates only with a Foundation validator. Lock header as a leading comment block.
**Decided (L1 parse module, 2026-07-31):** the projection **never self-closes
non-void elements**. HTML5 tree construction silently ignores `/>` on ordinary and
custom elements, so a self-closed `<fdn-use …/>` mis-nests its siblings in every
spec-conformant parser. Ingestion normalizes self-closed `fdn-*` tags to explicit
open/close pairs (report line `self-closing-tag-normalized`); the conformance suite
must carry this fixture class.

To fill: exact serialization order rules (determinism), lock header schema, re-hydration
(frozen file → live chain) and divergence detection (frozen file drifted from chain).

Non-normative forward note — **export backends**: the canonical projection is the sole
source; exports to framework idioms (Tailwind, StyleX, JSX/React, Svelte, vanilla CSS)
are derived, one-way, lossy compilations owned by a later engine module — deliberately
outside L0 and post-1.0, but anticipated: one canonical truth, N derived outputs is a
large part of the format's eventual power. Freeze is not an export — freeze is
truth-preserving; exports are translations for consumption.

## 8. Verbs — the manipulation protocol — *skeleton*

Intent (pillar 3): agents get *semantic* verbs, not DOM RPC and not blind text
overwrite — though blind text overwrite works too, via D4 ingestion. Proposed core:
`inspect` (state + matrix + validation), `patch` (typed operations: set-prop,
set-token-binding, insert/move/remove node, declare param/state, define/extract
component, bind instance props), `render`, `diff`, `anchor`, `freeze`,
`annotate` / `resolve`. Every verb speaks document semantics; none
speak pixels or bytes. To fill: operation schemas, batch/transaction rules, error
vocabulary (validation failures must be legible to an agent mid-loop).

## 9. Sync & multiplayer — *skeleton*

Intent: chains sync as append-only logs; local-first; any transport (filesystem, peer
replication, a relay server) — the spec defines the log exchange, not the pipe.
Annotations and review state are in-chain (they are changes like any other, so they
sync, merge, and carry authorship for free). To fill: exchange protocol, awareness
(presence/cursors) as an explicitly *non-truth* side channel, auth boundary for
cloud relays.

## 10. Conformance — *skeleton*

Intent: three implementable levels so others can build partial systems on the format —
**F-core** (parse, validate, materialize, project), **F-render** (the §5 contract,
bit-stable), **F-collab** (chain exchange). A public fixture suite defines each level.
To fill: the fixtures.

---

## Open questions

1. ~~Chain library~~ — **resolved 2026-07-31: Loro** (spike:
   `spikes/chain/RESULTS.md`). Loro passed the full concurrency gauntlet including
   G5 move-cycle; Automerge 3 hit the pre-agreed disqualifier on G5 (no native move —
   its parent-pointer workaround orphans a node under concurrent cyclic moves), and
   was also ~40× slower on append with a costlier diff-lift. Conditions bound to the
   decision (see RESULTS.md Recommendation): the Foundation change envelope is
   mandatory from day one (Foundation-owned SHA-256 + author/message over Loro's
   positional op ids), loro-crdt is pinned exactly, and engine time-travel reads
   serialize around Loro's detaching `checkout()`. The ChainAdapter contract was
   implemented twice, so migration-by-replay remains real, and this spec continues to
   never name the library normatively.
2. ~~Overlay coverage~~ — **resolved 2026-07-31** (evidence:
   `boards/overlay-evidence.fdn.html`, findings §f): one `fdn-overlay` primitive with
   `role`/`anchor`/`dismiss` metadata structurally covers dialog, toast, context
   menu, dropdown/popover, and tooltip — no portal primitive needed. The anchor
   vocabulary that emerged: anchor kind (`trigger` | `viewport-center`), an
   `anchor-ref` to the trigger element (which gains `role="trigger"`),
   **preferred edge (author intent) kept distinct from resolved edge (this baked
   instance's already-flipped geometry)**, flip permission, and offset.
   `scrim`/`panel` substructure is optional — the tooltip is the minimal legal case.
   One residue became open question 13.
3. ~~Capsule interactivity budget~~ — **resolved 2026-08-02 (importer kickoff)**:
   a sealed capsule is `{ html, css }` — its scoped stylesheet MAY use
   `:hover/:focus/:active/:disabled` pseudo-classes and CSS transitions/animations;
   it may NOT contain scripts, event handlers, timers, network access, or storage —
   enforced at import compile (banned globals throw legible errors in the SSR
   sandbox), never by convention. Bake scopes the css under a generated capsule
   class. Internals stay excluded from edit/diff; geometry is retained for
   annotation anchoring (D3). Transparent-first stands: sealing happens only when
   projection fails (structural prop interactions, unrepresentable CSS) and always
   with a report line saying why.
4. ~~Transparent-import fidelity~~ — **resolved 2026-07-31**: no fidelity gate. The
   importer always projects to a native body via D1 normalization (canonical rewrites
   + normalization report); sealed capsules only for unrepresentable output. Values
   are never snapped (raw values are legal, D1); the surviving requirement is that
   every rewrite rule the normalizer performs (`float`→flex, `em`-chain resolution,
   shorthand expansion) is specified exactly, with one deterministic output — because
   documents are content-hashed, two conforming engines must produce byte-identical
   canonical form from identical input or sync and freeze verification break.
5. `.fdn.html` vs a non-HTML extension: does browser-openability outweigh the risk of
   people hand-editing projections outside validation? Current lean: keep `.fdn.html` —
   the projection is now real HTML (D1), so it renders meaningfully anywhere, and
   ingestion validates hand edits anyway (D4).
6. Migration: an importer for the existing `.dc.html` explorations — worth it, or
   re-draw the live ones? (`.dc.html` is claude.ai/design's format; Foundation does not
   adopt or extend it — see PRD, rejected alternatives.)
7. Spec governance once third parties build on it: versioning policy, what a breaking
   change to the subset even means for frozen files (lean: frozen files are forever
   valid under their locked spec version).
8. Style lifting: when ingestion normalizes loose CSS "into styles directly", when do
   repeated declaration sets become a shared named style vs stay node-attached?
   (Lean: node-attached by default; named-style extraction is an explicit verb or an
   importer heuristic with a report line — never silent.)
9. ~~Interpolation and the expression budget~~ — **resolved 2026-07-31, widened
   same day by dogfooding**: `{{ … }}` admits: property/data references, ternary
   (nestable via parentheses), comparisons with **refs on either side** (the
   selection idiom `item.id == prop.selecteditemid`) usable both as conditions and
   as boolean values, and references into **declared lookup tables**. Still no
   arithmetic, no method calls, no string operations — the spike's one `.split()`
   need is answered by real `list`/`record` prop types (§4), not expressions.
   Non-Turing, fully auditable. (Original draft allowed only ref-vs-literal
   comparison and no grouping; real boards needed both within hours of use.)
10. ~~Projection semantics for parameterized content~~ — **resolved 2026-07-31**:
    the canonical projection is the **unresolved template document** — one file, one
    hash, all states; parameterized content stays symbolic. Fully resolved per-state
    trees are **derived artifacts** the engine bakes on demand (for serving,
    rendering, review), never hand-edited, marked as generated wherever embedded.
    A bake with no state selected uses each param's declared `default`; a param
    without a default renders empty and is flagged in the conformance report. The
    grammar spike's dual-form hybrid is retired.
11. ~~Interaction-state styling~~ — **resolved 2026-07-31**: sanctioned, enumerated
    per-state style attributes — `style-hover`, `style-focus`, `style-active`,
    `style-disabled` — validator-owned, same value grammar as `style`, no other
    pseudo-class mechanism. (The `.dc.html` precedent, adopted deliberately.) Named
    styles may grow matching state planes in L1 if duplication demands it.
12. ~~Named styles' rendering home~~ — **dissolved by the resolution of Q10**: the
    canonical (template) form keeps named styles symbolic — no dual-carry, so drift
    is impossible rather than detected; only derived baked artifacts inline the
    resolved styles, and those are engine-generated by definition.
13a. ~~Document identity and addressing~~ — **resolved 2026-07-31 (Phase B kickoff)**:
    (i) **Document id**: a UUID minted once at creation (CLI/surface layer — the
    engine stays randomness-free), carried as `data-fdn-doc-id` on the `fdn-doc`
    header element and in the chain's metadata, immutable for the document's life;
    peers and relays pair chains by it. (ii) **Author identity**: CLI defaults to
    `user:<os-username>@<hostname>`, never a shared literal (peer ids derive from
    author strings; shared defaults collide — proven). Hive identity overrides when
    present. (iii) **Project manifest**: a `foundation.json` in the project
    directory — `{ schema, id, name, documents: [{ path, docId }], designSystem?:
    <path>, viewports?: defaults }`; the filesystem stays the database, the
    manifest is the index. Design-system *inheritance semantics* remain §3 to-fill.
    (iv) **Exchange format**: the chain's wire form is a **content-addressed
    change-blob directory** — `<docId>/<envelope-hash>.fdnc`, one blob per change.
    Append-only + content-addressed makes directory **union** a correct merge, so
    any dumb file-syncer (Syncthing, rsync, iCloud, a shared tailnet folder) is a
    valid transport with no server logic; a relay is just a hosted copy. The
    single-file `.chain` snapshot remains a local compaction/fast-load cache and
    is NOT safe to file-sync (whole-file LWW clobbers appends). Merges report
    concurrent overlapping property writes as review signals. Envelopes are hashed
    but not yet signed — untrusted relays are a recorded future upgrade, and the
    envelope leaves room for signatures.
14. **Boolean attribute presence** (importer Stage 2 discovery, 2026-08-02): the
    grammar can interpolate attribute *values* and gate *nodes* (`when=`), but has
    no way to make an attribute's *presence* conditional — HTML boolean attributes
    (`disabled`, `checked`, `open`) are presence-based, so a component whose only
    variant difference is `disabled` cannot project to a native template and
    correctly seals today. Candidate: `attr-when-<name>="<cond>"` (attribute
    emitted iff cond true), or a rule that an interpolated empty value omits
    known-boolean attributes. Decide before the importer's v2 pass; the sealed
    fallback is correct meanwhile.
13. **Hover-triggered presence** (overlay evidence round 2, findings §f — genuinely
    new, distinct from resolved Q11): a tooltip's *visibility* is gated by another
    node's interaction state — hovering element A decides whether unrelated subtree B
    exists in the render at all. Q11's `style-hover` is same-node styling; presence
    is not a style property. Candidate mechanism: a declarative trigger binding on
    the overlay (`data-fdn-trigger="hover:<ref>"` + `dismiss="none"`), with all
    other overlay shapes continuing to imply visibility from their containing baked
    state. Decide in L1 alongside the bake semantics.
