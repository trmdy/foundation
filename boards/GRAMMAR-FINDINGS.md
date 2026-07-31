# Grammar-derivation spike: findings

**Inputs:** `docs/design-explorations/inbox-unified.dc.html` (832 lines, dense/stateful) and
`docs/design-explorations/system-help-center.dc.html` (352 lines, simpler), both from the Apiary
repo, hand-translated into `boards/inbox-unified.fdn.html` and `boards/system-help-center.fdn.html`
against `docs/SPEC.md` v0.0.1-draft §3/§4 skeletons.

**Method:** re-draw the *design*, not the `.dc.html` file format (per SPEC open question 6, this repo
does not adopt `.dc.html`'s own grammar). Where §3/§4 said "to fill," I invented the smallest concrete
syntax that let the redraw compile in my head, used it consistently across both files, and logged
every point where the invention felt arbitrary, lossy, or where I could see two reasonable answers.
Both output files were checked for HTML well-formedness (Python `html.parser`, void-element aware) —
both parse clean and open in a plain browser.

---

## (a) Syntax proposals invented

### a.1 — Document header block: `<fdn-doc>` / `<fdn-params>` / `<fdn-data>` / `<fdn-states>` / `<fdn-matrix>`

```html
<fdn-doc data-fdn-spec-version="0.0.1-draft" data-fdn-title="...">
  <fdn-params>
    <fdn-param name="selectedItemId" type="enum" values="a,b,c" default="b" description="..."/>
  </fdn-params>
  <fdn-data name="inboxItems">
    <fdn-item id="pay-webhooks" glyph="agent" title="pay-webhooks" state="failed" age="1h44" .../>
  </fdn-data>
  <fdn-states>
    <fdn-state name="review-selected" selectedItemId="checkout-guest-cart" detailMode="review" viewport="wide"/>
  </fdn-states>
  <fdn-matrix>
    <fdn-viewport name="wide" width="1480" height="872"/>
    <fdn-cell state="review-selected" viewport="wide"/>
  </fdn-matrix>
</fdn-doc>
```

**Rationale:** §4 promises "param types, state declaration syntax, the matrix declaration" and
Terminology defines param/state/matrix precisely — but gives no element shape. I put it first in
`<body>` (an `x-dc`-`<helmet>`-shaped analog) because it's document metadata a human or agent should
read before the markup, and because `<head>` is reserved for the one legal `<style>` block plus
real `<meta>`/`<link>`/`<title>`. `fdn-param.type` needed an enum beyond "string/number/boolean" —
I added `enum` (with a `values` CSV) and `token` (a value expected to be a CSS custom-property
reference) because both boards leaned on them constantly (`detailMode`, `state`, icon `name`).
`fdn-data`/`fdn-item` exists because §4 explicitly calls out "iteration over declared sample data" —
the queue rail (7 records) and the "what to test" checklist (4 records, 2 done) are exactly that,
and neither source board's underlying real UI is static prose; both are obviously data-driven lists
that a real Foundation document should declare once and iterate, not hand-repeat.

### a.2 — Named styles: `<fdn-styles>` + `data-fdn-style="<name>"`, dual-carried with inline `style=""`

```html
<fdn-styles>
  <fdn-style name="rail-row" display="flex" flex-direction="column" gap="3px" padding="7px 9px 8px" .../>
</fdn-styles>
...
<div data-fdn-style="rail-row" style="background:var(--color-selected-bg)">...</div>
```

**Rationale:** the task brief explicitly restricts `<style>` to `:root` tokens, so a named style
cannot be a CSS rule (that would also violate D1's "no descendant selectors, no specificity games" —
even a flat attribute-selector rule like `[data-fdn-style="rail-row"]{...}` is a selector, and D1's
own alternatives-rejected §1 explicitly kills "lints are advisory" full-CSS reasoning, which by
extension argues against any selector-driven mechanism the validator can't fully own). So a named
style is modeled as a **flat declaration bag resolved by the engine at materialize/projection time**,
not a browser-native construct. Every node that references one *also* carries the fully resolved
value as inline `style=""`, because the task also requires the projection to "open meaningfully in a
plain browser" with real fidelity — and a named style with no CSS home is otherwise invisible outside
the engine. See finding (b) for the cost this creates.

### a.3 — Component declaration: `<fdn-component>` / `<fdn-props>` / `<fdn-prop>` / `<fdn-slot>` / `<fdn-use>` / `<fdn-fill>`, dual-form (template vs. resolved)

```html
<fdn-component name="QueueRow">
  <fdn-props>
    <fdn-prop name="title" type="string" required="true"/>
    <fdn-prop name="selected" type="boolean" default="false"/>
  </fdn-props>
  <div data-fdn-style="rail-row" style="background:{{ prop.selected ? 'var(--color-selected-bg)' : 'transparent' }}">
    <span>{{ prop.title }}</span>
  </div>
</fdn-component>

<fdn-use component="QueueRow" data-fdn-prop-title="pay-webhooks" data-fdn-prop-selected="false">
  <!-- in a real engine-produced projection: the resolved subtree goes here -->
</fdn-use>
```

**Rationale:** D3 gives the concept precisely (props/slots/variants, native vs. sealed body) but no
syntax. `{{ prop.x }}` / `{{ item.x }}` mustache interpolation is invented wholesale — **the spec
defines no text or attribute interpolation facility at all**, which is the single biggest gap this
spike found (see b.1). I split component usage into two forms on purpose: the **definition** is a
template (mustache-bearing, never itself projected — D3 says a definition is "editable... like any
other content," which reads as an editing-surface concern, not a projection concern); the **instance**
(`<fdn-use>`) carries fully resolved, literal children — what a plain browser actually renders — plus
`data-fdn-prop-*` attributes as the machine-checkable binding. This is the only way I found to satisfy
D4's "canonical projection is deterministic text" *and* "opens meaningfully in a browser" at the same
time, given mustache templates render as literal `{{ ... }}` text with no engine present. The cost:
instance content and the prop bindings now have two independent sources of truth in the same file
(see b.1) — a real tension, not a solved problem.

`<fdn-fill slot="name">` (a slot-fill wrapper at the use site) is invented too — §3 names `fdn-slot`
for the *definition* side only; nothing names the *instance*-side container for slotted content.

### a.4 — Overlay: `<fdn-overlay data-fdn-role="..." data-fdn-dismiss="..." data-fdn-anchor="...">`

```html
<fdn-overlay data-fdn-role="dialog" data-fdn-dismiss="esc,backdrop-click" data-fdn-anchor="viewport-center" style="position:absolute;inset:0">
  <div data-fdn-role="scrim" style="position:absolute;inset:0;background:rgba(46,43,39,.32)"></div>
  <div data-fdn-role="panel" style="position:absolute;left:210px;top:52px;...">...</div>
</fdn-overlay>
```

**Rationale:** D1 says "no absolute positioning except inside the one sanctioned overlay context" but
§3's grammar-to-fill doesn't name it. `fdn-overlay` is the literal permission boundary: children of
this element may use `position:absolute/fixed`; nothing outside it may. `data-fdn-role` distinguishes
scrim/panel/trigger substructure (needed for render-contract hit-testing and for annotation anchoring
per D3's capsule-geometry idea). `data-fdn-dismiss` and `data-fdn-anchor` are declarative *metadata*,
not behavior — no event handlers exist in this grammar (D1), so these are read by the render/verb
layer, not executed client-side. See (c) for whether one such context actually covers what these two
boards needed.

---

## (b) Pinch points — what the grammar lacks or makes awkward

1. **No interpolation syntax, at all.** §4 scopes "no expressions beyond comparison and boolean
   composition" to `when`, but says nothing about getting a prop or a sample-data field *into text or
   an attribute value* in the first place — which every single component in both files needed
   (`{{ prop.title }}`, `{{ item.age }}`, ternary-shaped `{{ prop.selected ? '...' : '...' }}` for
   value-mapping). Without this, "props" are inert metadata a human reads on the definition but can
   never actually see rendered. This is more foundational than `when`/`each` and isn't mentioned at
   all in the current skeleton.

2. **Value-dependent styling has no lookup/switch, only N `when` branches.** Both boards color-code
   status by an enum (`failed`→red dot, `review`→orange, `waiting`→hollow ring, `login`→hollow red
   ring; `<Icon name="...">` picking one of six paths). Under "no expressions beyond comparison," the
   *only* legal way to express "value X maps to visual Y" is one `when="prop.state == 'V'"` branch per
   enum value — see `StatusDot` and `Icon` in `inbox-unified.fdn.html`. Four states, four near-
   identical `<span>`/`<path>` siblings differing only in one attribute value. This scales linearly
   and gets genuinely bad for anything with more than ~5 variants (e.g. a 10-color status palette, or
   a 24-icon set) — real product surfaces in Apiary have exactly that shape (the fleet pane's status
   palette, referenced directly in board 2b of the help-center draw, is larger than 4 values).
   A `{{ token-for(prop.state) }}`-shaped mapping/lookup primitive (still non-Turing-complete, still
   auditable) would collapse this without reopening "arbitrary logic."

3. **Named styles have no CSS home under the task's own constraint, so they don't actually save
   bytes.** See (a.2). Every `data-fdn-style` reference in both files is followed by (or paired with)
   an inline `style=""` carrying the same values, because nothing in a plain-HTML `<style>` block (no
   selectors permitted) can apply a named style to an arbitrary node. That means named styles as
   drafted are an **audit/dedup handle for the engine, not a size or drift win for the text format** —
   two representations of one style can silently disagree (I could ship `rail-row`'s `padding` as
   `7px 9px 8px` in `<fdn-styles>` and `7px 8px 8px` inline and nothing here would catch it). SPEC
   open question 8 ("style lifting... when do repeated declaration sets become a shared named style")
   is adjacent but doesn't cover *how a named style is rendered at all* without an engine in the loop.

4. **List-typed / structured props don't exist.** `ShortcutRow`'s `keys` field is really a list of
   chord-groups (`⌘D`, `⌘⇧D`), rendered as N `<KbdCap>` siblings. §4's prop-type vocabulary (implied:
   string/number/boolean/enum) has no `list<T>` or `record` shape, so I encoded it as a single string
   (`"⌘D · ⌘⇧D"`) and split on `" · "` at the use site (`each="group in prop.keyGroups.split(' · ')"`)
   — inventing both a delimiter convention *and* a `.split()`-shaped operation that is definitely
   "more than comparison and boolean composition." This is the most load-bearing violation of my own
   invented rules in either file, and I could not find a clean way around it without a real list prop
   type.

5. **`when`/`each` have no defined projection semantics — I had to invent a stance.** If the
   canonical projection is deterministic *text* (D4) and `when`/`each` are declarative conditionals
   evaluated against params/data, what does the *text* actually contain: (i) the unresolved
   conditional tree (so one document handles every state), or (ii) one fully-materialized state
   (so the projection is per-state and there are N projections)? The spec doesn't say, and it matters
   enormously for D2's hashing/sync/diff story ("two conforming engines must produce byte-identical
   canonical form from identical input," open question 4). I adopted (i) for `<fdn-component>`
   definitions (they keep `when`/`each`, they're template surfaces, never projected raw) and a
   pragmatic hybrid at the top level: each declared `<fdn-state>` gets its own `<section
   data-fdn-state="...">` with a fully resolved `<fdn-use>` subtree, mirroring exactly how the source
   `.dc.html` boards already stack multiple pinned example states in one file. That degrades sensibly
   in a plain browser (every state is visible, stacked, labeled) but I want to flag explicitly: **this
   is my invention, not a spec answer**, and a real engine would need to pick one of (i)/(ii) and make
   it a one-way door, because it changes what "the projection" even means.

6. **No design-system / cross-document inheritance syntax, so both files duplicate their whole token
   set and five-to-six components verbatim.** §3 lists "inheritance from design system documents" as
   "to fill." In a real Foundation deployment `KbdCap`/`ShortcutRow`/`SectionHead` etc. would live in
   one shared design-system document Apiary's whole help/shortcuts surface imports — instead each
   `.fdn.html` here re-declares its own token block and its own component set, and nothing enforces
   that `--color-text-primary` means the same hex in both files (it does here, by discipline; it
   drifted between `#2A2620` in the inbox board and `#2E2B27` in the help-center board **in the
   original `.dc.html` source itself** — a real, sourced inconsistency I preserved as separate tokens
   rather than silently "fixing," see (d)).

7. **`data-fdn-*` attribute soup competes with real semantic attributes.** `<fdn-use component="X"
   data-fdn-prop-selected="true">` works, but nothing stops an agent from also legitimately wanting a
   real `id`/`aria-*`/`data-testid` on the same instance element, and the two attribute namespaces
   (Foundation's own bookkeeping vs. the subset's ordinary HTML attributes) aren't distinguished
   anywhere in §3. I kept `data-fdn-*` strictly for grammar bookkeeping in both files, but the spec
   should say this explicitly (a reserved-prefix rule) before agents start guessing.

8. **Canonical projection requires metadata/definition elements to be browser-inert; `hidden` is the
   mechanism — and I initially shipped both boards without it.** The first draft of both `.fdn.html`
   files left `<fdn-doc>`, `<fdn-styles>`, and every `<fdn-component>` definition as plain, visible
   custom elements. That is a real, load-bearing bug, not a cosmetic one, and it was caught only by
   actually rendering the files (Playwright screenshot), not by the HTML-well-formedness check I had
   relied on — a parser confirms tags balance; it says nothing about what an unknown element *shows*.
   Two concrete failure modes surfaced: (i) `<fdn-component name="Icon">`'s definition body is a
   `<svg>` whose `width`/`height` are unresolved mustache (`width="{{ prop.size }}"`) — a browser
   cannot parse that as a dimension, falls back to intrinsic/auto sizing, and the icon's several
   `<path>`/`<g>` branches (all of them, since a plain browser has no `when` and renders every branch
   simultaneously) render as one un-sized, black-filled shape stretched to fill the block — the "giant
   black blob" that ate the entire viewport. (ii) every `<fdn-component>` and `<fdn-styles>` body is,
   to an unrecognized-element-tolerant HTML parser, ordinary inline content: their raw
   `{{ prop.x }}`/`{{ item.x }}` mustache template text rendered as literal, visible page text ahead of
   the real document. **The fix, and the rule I'm recording here as a genuine spec finding this spike
   produced**: every element whose job is authoring/engine metadata rather than rendered content
   — `<fdn-doc>` (and its `<fdn-params>`/`<fdn-data>`/`<fdn-states>`/`<fdn-matrix>` children),
   `<fdn-styles>`, and every `<fdn-component>` definition — must carry both the `hidden` attribute
   *and* an inline `style="display:none"` (belt-and-braces: `hidden` alone is a light-weight UA-stylesheet
   default that inline styles or a later cascade rule could override in a less disciplined document;
   D1 has no cascade to worry about here, but the redundancy costs nothing and removes the ambiguity).
   This wants to be a normative rule in §3/§7, not a per-document convention: **"projection-inert
   elements are inert only if marked inert"** — nothing about being a `fdn-*` custom element makes a
   browser hide it by default, the way `<head>` or `<template>` get free special-casing in the HTML
   spec. Foundation's `fdn-*` vocabulary gets no such free ride from real browsers, so the projection
   format has to earn it explicitly, on every metadata/definition element, every time. A real Foundation
   validator should almost certainly *reject* a `<fdn-component>`/`<fdn-styles>`/`<fdn-doc>` that lacks
   `hidden`, rather than leave it to author discipline the way I initially (wrongly) did.

9. **The dual-form component model (finding a.3) is real work, not free, and is easy to half-do.** My
   first draft defined the *template* half correctly (mustache bodies inside `<fdn-component>`) but
   left most `<fdn-use>` instances at real use sites either self-closing or empty, with a comment
   claiming "the engine would inline this" — i.e. I wrote the rationale for dual-carry in
   GRAMMAR-FINDINGS.md (a.3) without actually doing the second half of the work in the boards
   themselves. The result was exactly what you'd expect: every instance of `InboxChrome`, most
   `QueueRow`/`DetailTab`/`ActionButton`/`StatusDot`/`ShortcutRow`/`NavRow` uses, and two `each`-loop
   sites rendered as either blank space or leaked template text, because there was no resolved content
   for a plain browser to show. I only caught this by rendering both files and looking, which is the
   actual lesson: **HTML-well-formedness (tags balance, parses cleanly) is necessary but nowhere near
   sufficient evidence that a projection "opens meaningfully."** A conforming validator for this
   grammar needs a distinct check — call it instance completeness — that every `<fdn-use>` in a
   projected (non-template) context carries a non-empty, mustache-free resolved subtree, separate from
   and in addition to schema/tag validation. Nothing in §10's conformance-level sketch (F-core/
   F-render/F-collab) currently names this as its own checkable property, and it should.

---

## (c) Overlay verdict (SPEC open question 2)

**Evidence available:** exactly **one** overlay was fully drawn open across both source boards — the
`?`-triggered help dialog in `system-help-center.dc.html` board 1 (centered panel, dimmed scrim,
esc/click-outside dismiss). `inbox-unified.dc.html` draws one **toast** fully open (board `d5`,
"HANDLED · SELECTION CONTINUITY & UNDO" — a dark pill anchored to the bottom-center of a card, no
scrim, auto-timeout-shaped with an inline undo affordance). Both are re-drawn faithfully in the
`.fdn.html` outputs (dialog: `system-help-center.fdn.html` board 1, inside `<fdn-overlay
data-fdn-role="dialog">`; toast: `inbox-unified.fdn.html`, the "HANDLED" decision card — rendered as
plain static markup there since it's a decoration of a *decision card*, not a live overlay instance,
which is itself informative: the source draws the toast **already at rest** next to explanatory prose,
never as a genuine floating layer over live content).

Neither source board draws a **menu** or a **tooltip** actually open. Both are referenced only as
static text/labels: "pane ⋯ menu" (a button that would open one, help-center board 6) and the several
"⋯" overflow buttons in the inbox board's headers. A **popover** is referenced but not drawn either
(the "click keys to rebind" recording affordance in help-center board 4 replaces content *in place*
within the row — no floating layer at all; I rendered it as an ordinary inline dashed-box state, not
an overlay).

**Verdict: one sanctioned overlay context is enough for the two shapes actually observed (dialog,
toast), but I cannot confirm it covers menus/popovers/tooltips from this evidence, and I don't think
anyone honestly can yet.** The dialog and the toast already need *different* behavior contracts under
one structural primitive — `data-fdn-anchor="viewport-center"` + scrim + esc/click-outside vs.
`data-fdn-anchor="<edge-or-trigger>"` + no scrim + timeout/undo — which `fdn-overlay`'s `role` +
`anchor` + `dismiss` attributes can express structurally. But a menu (anchored to a trigger, dismissed
on outside-click *or* on item-select, typically no scrim, must reposition to stay in viewport) and a
tooltip (anchored to hover, no dismiss affordance at all, appears/disappears on a timer with no user
action) both introduce interaction shapes — hover-triggered, timer-driven — that push toward SPEC open
question 3 ("capsule interactivity budget... hover/focus/open states") territory, not just structural
layering. My recommendation, consistent with the SPEC's own instruction to "decide from real
explorations, not speculation": **before deciding, someone needs to draw a menu and a tooltip fully
open** in a real Apiary exploration board (the app clearly has both — the fleet pane's row context
menu, the keycap "click to rebind" popover implied but not drawn, hover tooltips on truncated titles)
and re-run this same translation exercise against them. This spike's boards simply didn't happen to
contain that evidence, and I'd rather say so than extrapolate from zero instances.

---

## (d) First inventory of normalizer rewrite rules encountered

Concrete rewrites the ingester would need to perform on this pair of source boards, each an "exact,
spec-fixed rule with one deterministic output" per D1/open-question-4's requirement:

- **`font:` shorthand → longhand.** Every text node in both `.dc.html` sources uses CSS font
  shorthand (`font:600 13px 'Hanken Grotesk',sans-serif`). The subset's inline `style=""` in the
  `.fdn.html` output keeps the shorthand for readability, but D1 requires canonical form to be
  singular and deterministic — the normalizer needs a fixed expansion order
  (`font-style font-variant font-weight font-size/line-height font-family` → four/five explicit
  declarations) so `font:600 13px X` and `font-weight:600;font-size:13px;font-family:X` don't hash
  differently for semantically identical style.
- **Multi-value shorthand disambiguation (`padding`, `border-radius`).** `padding:7px 9px 8px` (3
  values, TRBL wraparound) appears throughout; the normalizer must expand to 4 explicit
  `padding-{top,right,bottom,left}` values with one fixed disambiguation rule (which the 3-value and
  2-value forms currently rely on CSS's own implicit "top/right-left/bottom" and "top-bottom/
  right-left" wraparound — legible to a human, ambiguous as a diff primitive: "padding-right changed"
  vs. "padding changed").
- **`float`-based layout.** Not present as literal `float:` in either source (both already use flex
  throughout) — a genuine, useful negative finding: these two boards, hand-authored in claude.ai/
  design, never reached for floats. D1's `float`→flex rewrite rule exists for a real risk class this
  particular pair of fixtures doesn't exercise; the conformance suite needs fixtures from elsewhere
  for it.
- **Absolute-positioning-as-layout, not overlay.** Both `.dc.html` sources use `position:absolute`
  pervasively for **canvas placement** — every "board" is `position:absolute;left:...;top:...` against
  an implicit infinite canvas (this is the claude.ai/design canvas idiom, not a Foundation document's
  real layout). None of that is legal D1 layout; the rewrite is "delete the canvas positioning, flow
  the boards as ordinary block/flex siblings" — which is exactly what both `.fdn.html` outputs do
  (`<section>` stacked in a flex column). This is different from, and much larger in volume than, the
  *legitimate* sanctioned-overlay absolute positioning (dialog panel, toast) — the normalizer needs to
  tell "authoring-canvas absolute" from "overlay absolute" apart, and nothing in either source marks
  that distinction explicitly; a human/agent has to know that `dc-import` wrapper boundaries and
  `data-screen-label` markers are canvas scaffolding, not design content. (Both attributes, plus
  `data-drags-parent`, `<x-dc>`, `<helmet>`, `hint-size`, `<dc-import name="...">` are `.dc.html`-
  format-specific and were dropped entirely in translation, per the task's own instruction to
  translate the design not the file format.)
- **Arbitrary px values kept, not snapped.** Per D1/open-question-4 ("values are never snapped"), I
  left genuinely one-off values as raw px (`width:316px` for the queue rail, `212px`/`210px` canvas
  offsets, SVG viewBoxes) rather than forcing them onto a spacing token scale that doesn't fit them —
  these are legitimately off-token by design intent (a rail is 316px because that's what the content
  needs, not because "316" is a spacing step), and the conformance plane should *report*, not reject,
  them (D1 is explicit about this).
- **Hex color drift is a real, sourced finding, not a hypothetical.** `--color-text-primary` is
  `#2A2620` in `inbox-unified.dc.html` and `#2E2B27` in `system-help-center.dc.html` for what reads as
  the "same" ink-black text color across the two boards (both are near-black warm grays, ~1-2% apart).
  I kept them as two distinct tokens across the two `.fdn.html` files rather than silently merging them
  — normalizing two different source values to one canonical token is a *design decision* (are they
  the same color that drifted, or deliberately different?), not a mechanical rewrite, and D1 says
  rewrites must be exact/deterministic; a human call belongs in a normalization-report line, not a
  silent merge.
- **Declared-but-unused token: `--font-serif` / Spectral.** `system-help-center.dc.html` `@import`s
  `Spectral` in its Google Fonts link but the design's own board 6 states outright "Serif: unused." I
  kept the token in `:root` (faithful to the source's actual CSS) and flagged it as a normalization/
  conformance-report line rather than dropping it — a real example of "off-token" auditing but at the
  *import* level, not the value level.

---

## (e) Exclusion list as actually needed by these two boards

What D1's "closed by schema, not vocabulary" needed to actually exclude to make these two boards legal:

- **`<script>`** — both sources load `./support.js` (the claude.ai/design canvas runtime) via a
  `<script src>` in `<head>`. Dropped outright; it's exactly D1's named exclusion and the whole reason
  neither source is a valid Foundation document as-is.
- **`<x-dc>`, `<helmet>`, `<dc-import>`** — three custom elements from the `.dc.html` idiom that are
  *not* HTML5 and are not `fdn-*` semantics either; they're the source format's own scaffolding
  (canvas root, head-in-body, and a component-instantiation-with-baked-in-size mechanism). All three
  were structurally interesting (`dc-import name="InboxChrome"` reused twice is literally a component
  instance in spirit — see `InboxChrome` in `inbox-unified.fdn.html`, which is a direct translation of
  that pattern into `fdn-component`/`fdn-use`) but the elements themselves don't belong in the closed
  subset and were replaced, not merely allow-listed.
- **`style-hover="..."` attribute** — both sources use a bespoke, non-standard attribute
  (`style-hover="background:#EEEDE9"`) to declare `:hover` styling without a stylesheet, since the
  format has no CSS files and no `<style>` selectors either. This is a real, recurring need (nearly
  every clickable row/button in both boards has a hover state) that D1's "styles attach to nodes or
  named styles; no selectors" has **no answer for at all** — `:hover` is fundamentally a pseudo-class,
  which is a selector mechanism. I dropped `style-hover` from both `.fdn.html` outputs (rendering only
  the resting state) rather than inventing an unsanctioned answer, and I'm flagging this as the
  **single largest unresolved gap** this spike found: D1 has no story for *any* interaction-state
  styling (`:hover`, `:focus`, `:active`, `:disabled`) without either (a) a pseudo-class-shaped
  selector escape hatch (in tension with "no selectors"), or (b) pushing all of it into sealed-capsule
  territory (in tension with D3's stance that native bodies are the default and hover states are
  everywhere in ordinary product chrome, not just imported components).
- **Inline `<svg>` with arbitrary path data** — both sources hand-author small icon SVGs inline
  (chevrons, hexagons, search glyphs). SVG is not in D1's prose list of examples but nothing excludes
  it either, and "arbitrary values are legal" extends naturally to path `d=` data; I treated inline
  `<svg>` as fully legal subset content (allow-listed by the "broad HTML5 allowlist," since SVG is a
  standard embedded content model, not a scripting/iframe exclusion) and used it directly inside the
  `Icon` component.
- **Custom global CSS classes (`.kc`, `.srow`, `.slab`, ...) in a `<style>` block** — `system-help-
  center.dc.html` defines seven reusable classes in its `<helmet><style>` and applies them via
  `class="..."` everywhere. This is the source's own (crude) named-style system, and it had to be
  fully excluded and replaced with `<fdn-styles>`/`data-fdn-style` — not because classes themselves are
  forbidden vocabulary, but because D1's cascade rule ("no descendant selectors, no specificity games")
  kills class-selector stylesheets generally, which is most of what made this source's CSS compact.
- **Form-control elements as functional widgets** — neither source actually uses `<input>`/`<button>`/
  `<select>` for its "search field," "feedback textarea," or buttons; everything is `<div>`/`<span>`
  styled to look like a control (deliberately — these are static design boards, not live prototypes).
  This happens to align with D1's own framing ("form controls included as *presentational* elements
  (rendered, not functional)") — nothing needed excluding here, but it's worth noting the two example
  boards never actually exercised the presentational-form-control allowance either way.
