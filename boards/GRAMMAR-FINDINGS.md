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

---

## (f) Overlay evidence round 2 (SPEC open question 2 — closed)

**Inputs:** `boards/overlay-evidence.fdn.html`, a new board drawing the two shapes §(c) explicitly
flagged as never-drawn-open — a context menu and a tooltip — plus a dropdown/select popover, plus one
small confirm dialog for contrast against the established dialog+scrim pattern. All four are drawn
fully open, anchored, with real content (8-item menu with one destructive item and one submenu
indicator; a genuinely truncated title with a hover tooltip; a 10-row scrollable single-select list
with one row checked; a small centered confirm dialog). Checked for HTML well-formedness (Python
`html.parser`) and rendered with Playwright at 1480×1100 and full-page; every overlay was inspected
visually and iterated until it read correctly — see the process note at the end of this section for
what the rendering pass itself caught, which turned out to be as informative as the grammar question.

### Verdict: one `fdn-overlay` primitive is enough — structurally. It is not enough on its own for the tooltip.

All four shapes compose from exactly the same three ingredients §(c) already had on the table —
`data-fdn-role`, `data-fdn-anchor`, `data-fdn-dismiss` — plus one genuinely new fact this round
surfaces (below): **what makes the overlay visible in the first place is not always "an ancestor state
says so."** For menu, popover, and dialog, `data-fdn-role` alone (`menu` / `popover` / `dialog`)
distinguishes them enough that no new *structural* primitive was needed — one `<fdn-overlay>` element,
one substructure convention (`data-fdn-role="panel"`, `"scrim"` where applicable), one anchor fact, one
dismiss fact, covers dialog, toast (§(c), prior round), menu, and popover. The tooltip is the outlier,
and it is an outlier in **triggering**, not in structure — its panel is the simplest of the four (one
node, no `panel`/`scrim` substructure needed at all). So the SPEC open question 2 verdict is: **yes,
one sanctioned overlay context is enough for menus, popovers, dialogs, and toasts — the tooltip needs
the *same* structural primitive plus one additional fact this grammar does not yet have a name for.**

### Anchor vocabulary that emerged

§(c)'s `data-fdn-anchor="viewport-center"` (dialog) was the only anchor fact on the table before this
round. Trigger-anchored overlays need more than a single enum value, because "where" and "which way it
opened" and "what the author originally wanted" are three different facts, and a **projection with no
live layout engine can only ever show one already-resolved geometry per baked state** (open question 10
— the canonical form has no room for "recompute on paint"). This board settled on five attributes,
tested against the menu, which is the hardest case (drawn deliberately near a frame's right *and*
bottom edge so both axes must flip):

- `data-fdn-anchor="trigger"` — the anchor kind (`trigger` | `viewport-center`; a third,
  `viewport-edge`, is implied by the toast in §(c) but wasn't re-tested here).
- `data-fdn-anchor-ref="<id>"` — which element is the anchor source, by id. This is new: §(c)'s
  `fdn-overlay` had no way to point *at* a specific node, because its one drawn instance
  (`viewport-center`) doesn't need to. Trigger-anchoring does, so the trigger element itself needs a
  stable identity — see the new `data-fdn-role="trigger"` convention below.
- `data-fdn-anchor-preferred-edge="bottom-start"` — the author's declared, un-flipped intent (design
  time). This board's menu declares `bottom-start` (open below, left-aligned to the trigger) as intent.
- `data-fdn-anchor-edge="top-end"` — the **resolved** edge actually rendered in *this* baked instance
  (render time), after flip. For the menu these two attributes disagree on purpose — that disagreement
  is the whole point being demonstrated (a menu opened where a real one would end up, next to a trigger
  near a corner) — and the disagreement is exactly why both facts need to be recorded separately rather
  than collapsing to one `data-fdn-anchor-edge`. A validator that only kept one would either lose the
  author's real intent (if it kept only the resolved value) or ship a static file that visibly
  contradicts its own declared behavior (if it kept only the preferred value and rendered resolved).
- `data-fdn-anchor-flip="viewport"` — declares that this instance is allowed to flip to stay inside its
  containing frame at all (the dialog's `viewport-center` anchor sets this to `none`, since centering
  has no "edge" to flip). This is metadata for the render/verb layer, exactly like `dismiss` — no script
  runs client-side; a real engine would consult it when re-baking a state at a different geometry.
- `data-fdn-anchor-offset="6"` — the px gap between trigger and panel (both the menu and the tooltip
  needed this as a distinct, small, per-instance number; folding it into `edge` would make that
  attribute's grammar do two unrelated jobs).

A new **`data-fdn-role="trigger"`** value was needed on ordinary content nodes (the fleet row's kebab
button, the truncated title span, the popover's own trigger chip) — §(c)'s `data-fdn-role` vocabulary
only ever named *overlay substructure* (`scrim`, `panel`). Anchoring needs the anchor **source**
identified too, and it lives outside the `<fdn-overlay>` entirely (a sibling, in ordinary document
flow) — so the reserved-role vocabulary turns out to span two different kinds of element: the overlay's
own internal parts, and the arbitrary content node an overlay points at. Worth making explicit in §3 as
two sub-vocabularies of one attribute rather than one flat enum.

One open question this round couldn't close: whether `data-fdn-role="menu"` and `data-fdn-role="popover"`
are actually two different facts a validator should care about, or one structural shape (trigger-
anchored panel, no scrim, dismiss on outside-click/item-select/esc) wearing two different content
conventions (commands with shortcuts vs. a single-select list with a filter field). This board kept
them distinct because they read as different *intents* to a human — but nothing in the anchor/dismiss
contract actually depends on which one it is. A future pass should ask whether `role` here is doing
real validation work or just documentation work.

### The hover-visibility finding — this is the one that matters most

**Showing the tooltip on hover is a visibility state, and the resolved Q11 mechanism (`style-hover`)
does not reach it.** This needs to be said precisely, because it would be easy to wave at `style-hover`
and assume the tooltip is covered:

- `style-hover`/`style-focus`/`style-active`/`style-disabled` (Q11, resolved) are **same-node,
  same-subtree** facts: they say "when this node is hovered, *this node's own declared style
  properties* take these values instead." Every interactive row in this board actually uses this
  mechanism for real (`style-hover="background:var(--color-selected-bg)"` on every menu row, popover
  row, and fleet row) — it is the right tool for "this row highlights on hover," and it worked exactly
  as specified.
- The tooltip needs something categorically different: hovering **element A** (the truncated title)
  must change whether **element B** (a sibling `<fdn-overlay>`, structurally unrelated in the tree)
  renders *at all*. That is not a style property changing value on a hover — it's a node's presence in
  the render tree gated by another node's pointer state. No amount of `style-hover` vocabulary
  extension reaches this, because `style-hover` is defined (correctly, per Q11) as *"same value grammar
  as `style`"* — and "does this node exist" is not a style property.
- This board invented `data-fdn-trigger="hover:<ref>"` on the `<fdn-overlay>` itself to name this fact
  explicitly, paired with `data-fdn-dismiss="none"` (deliberate, not an oversight: a tooltip has no
  *user* dismiss action — dismiss answers "how does the user make an open overlay close," and a
  tooltip's closing is symmetric with its opening, gated by the same hover fact, not a separate
  action). `data-fdn-trigger` is genuinely new — it answers "what makes this overlay visible," a
  question §(c)'s `fdn-overlay` never had to answer because both prior instances (dialog, toast) were
  drawn as permanently-open baked states with no visibility gate at all.
- Whether `data-fdn-trigger` should be scoped to `hover` only, or needs to generalize (`click:<ref>`
  for a menu/popover's own open action, `focus:<ref>` for a focus-triggered affordance) is open — this
  board only had to answer it for one case. But the shape of the answer seems right: overlay
  *visibility* is its own declarative fact, siblings with `anchor` and `dismiss`, not a derived
  consequence of per-node style state. **This is a new spec-level gap, not a drafting gap in this
  board** — §4's interaction-state resolution (Q11) covers styling; it was never asked to cover
  presence, and menus/popovers/dialogs sidestepped the question by being drawn as baked-open states
  with their visibility already implied by the containing `<fdn-state>`. A tooltip is the first shape
  in either round of evidence whose visibility genuinely depends on *another node's* interaction state
  rather than the document's own param/state assignment, and that's a real, load-bearing distinction
  the spec doesn't have a name for yet.

### New pinch points

1. **The named-style dual-carry gap from finding (b.3) is not hypothetical — this board reproduced it
   as a real, working bug before the fix.** The first draft of every resolved `<fdn-use>` instance in
   this board (menu rows, fleet rows, popover rows) carried `data-fdn-style="menu-row"` plus only the
   *variable* per-instance style (e.g. `color`) inline, mirroring how `inbox-unified.fdn.html`'s
   `<fdn-component>` **definitions** are written. Rendered, every row's children fell back to normal
   inline flow with no gap and no right-alignment — text ran together unreadably. Cross-checking
   against `inbox-unified.fdn.html`'s actual **resolved** `<fdn-use>` content (not its component
   definitions) showed the real convention: resolved instances must inline the *complete* computed
   style (`display:flex;align-items:center;gap:...;height:...;padding:...;border-radius:...`, not just
   the variable slice), because a named style has no CSS home in a plain browser (b.3) and a
   `data-fdn-style` reference on a resolved node does nothing by itself. This is the same finding as
   (b.3) and (b.9) combined, but sharpened: it is not just that the two representations of a named
   style *can* silently disagree — it's that a resolved instance that only dual-carries the *diff*
   from a named style (a natural thing to write, since that's exactly how the component *definition*
   is written) renders visibly broken, silently, with no parser error. A conformance check for
   "resolved instance completeness" (b.9 already asked for this) should specifically include "carries
   the full named-style declaration, not a delta" as one of its assertions.
2. **The frame-as-viewport convention needs the page's own layout to actually respect the declared
   matrix viewport width, or the "stays in viewport" demonstration is undermined by the document's own
   chrome, not the overlay logic.** This board's first draft gave `<main>` 32px of horizontal padding
   around a `width:1480px` frame — 1544px of real content width against a 1480px matrix viewport
   (`<fdn-viewport name="board" width="1480">`). The menu, correctly flipped to stay inside its own
   *frame*, still rendered past the edge of an actual 1480px screenshot, because the frame itself
   didn't fit. Nothing in §5/§7 currently says a projection's outer chrome must reconcile with its own
   declared matrix viewport size; this board's fix (zero horizontal padding on the outermost flow
   container, inset padding pushed onto individual text nodes instead) is a workaround, not a spec
   answer. A render-contract note that "the matrix viewport bounds the rendered surface, and a
   projection's own layout is responsible for not exceeding it" would have caught this before render.
3. **`data-fdn-anchor-preferred-edge` vs `data-fdn-anchor-edge` doubles the anchor fact, and that's
   deliberate, but it interacts oddly with Q10's "template is canonical, resolved trees are derived
   bake artifacts."** If parameterized content stays symbolic in the canonical projection (Q10,
   resolved), which of these two attributes is even *stable* across bakes? `preferred-edge` should be
   (it's authored intent, independent of any particular state's trigger geometry); `edge` is a
   per-bake derived fact like the rest of a resolved tree. That means `preferred-edge` plausibly
   belongs on the **component definition** (or a document-level default), while `edge` only ever makes
   sense on a **resolved instance** — the same definition/instance split finding (a.3) already
   identified for props in general, showing up again specifically for anchor geometry. Not resolved
   here; flagged for whoever writes the real attribute schema.
4. **A tooltip's panel needed no `data-fdn-role="panel"` substructure at all** — its entire content is
   one styled `<div>`, no scrim, no separate panel wrapper. Worth confirming in §3 that `panel`/`scrim`
   substructure roles are optional conveniences for overlays complex enough to need them (dialog,
   menu-with-sections), not a required shape every `<fdn-overlay>` must carry — this board's tooltip is
   the existence proof that the minimal legal `<fdn-overlay>` is just the wrapper plus content, no
   substructure at all.

---

## (g) Toolchain dogfood — bringing all three boards to zero `validate` errors

**Method:** ran `foundation validate` on each board, fixed the reported errors at the source (never
suppressed), re-ran `validate` to convergence, then `foundation ingest` to canonicalize. Visual fidelity
was checked by baking (`foundation bake`) each board before my first edit and after my last, screenshotting
both with Playwright at 1480×1100 full-page, and inspecting the PNGs directly — per the task brief, the
*baked* output is the real rendering; the raw `.fdn.html` file (with its dual-carried literal fallback
content inside every `<fdn-use>`) was only ever a degraded plain-browser preview, and `ingest` deletes that
fallback content outright (`resolved-instance-collapsed`), so bake fidelity is the only fidelity that
survives past this pass.

### Per-board error counts and fixes

**`system-help-center.fdn.html`: 27 errors → 0.**
- **22 × `text-children-conflict`.** Every case was the same shape: a block of prose with one or more
  inline elements stitched into the middle (`<b>`, `<fdn-use>` icon chips, `<code>`) — e.g. `<div>APIARY
  · SYSTEM — HELP CENTER · <fdn-use component="KbdCap" .../> opens a context-aware help dialog...</div>`.
  Fix: wrapped every *non-whitespace* direct text run in its own `<span>`, leaving pure word-separating
  whitespace between spans/elements untouched as bare text (so the parent's own `.text` collapses to
  empty and the conflict disappears) — this is byte-identical visually, since `<span>` is unstyled/inline
  by default and no characters moved or were re-collapsed differently than the original single-string
  join already did.
- **2 × `expression-not-in-subset` / `undeclared-ref-root`** on `each="group in prop.keyGroups.split('
  · ')"` (`ShortcutRow`'s multi-chord keycap row, GRAMMAR-FINDINGS §b.4's own predicted violation).
  Fix: made `keyGroups` a real `type="list"` prop (per `types.ts`'s list convention — primitive items
  addressed as `<binding>.value`), changed the each to `each="group in prop.keyGroups"` and the
  downstream ref to `{{ group.value }}`, and re-encoded every call site's chord string as a JSON array
  literal (`data-fdn-prop-keyGroups='["⌘D","⌘⇧D"]'` — the same encoding `bake/index.ts`'s
  `coercePropValue` already uses for `list`/`record` props, confirmed against
  `packages/engine/test/bake-component.test.ts`). The underlying `fdn-item keys="⌥D · ⌥B · ⌥T · ⌥S"`
  sample-data attributes became `keys='["⌥D","⌥B","⌥T","⌥S"]'` for the same reason — real lists, not a
  middot-delimited string operated on at use-time.
- **3 × `position-outside-overlay`** on the "ghost app behind the dialog" background chrome (three
  `position:absolute;left:...;top:...` siblings simulating a 3-pane app window) — exactly the board's own
  caption right above them: *"ghost app behind the overlay: ordinary flex chrome, NOT part of the
  overlay context."* Fix: converted to a flex row (`display:flex;gap:12px`) with the two card children
  carrying `margin:12px 0` / `margin:12px 12px 12px 0` in place of their `top`/`bottom`/`right` offsets —
  arithmetically identical geometry, confirmed by re-deriving each pixel value from the original
  `left`/`top`/`bottom`/`right` numbers rather than eyeballing it.

**`inbox-unified.fdn.html`: 24 errors → 0.**
- **23 × `text-children-conflict`**, same fix as above. 20 of 23 were caught by an automated pass; 3
  (`PR #214` and `drone-12` badges, and the `packet f-2183<br>bee drone-12 ↗<br>...` lineage block) were
  missed by that pass on the first try and fixed by hand — see the UX-review note below on why (a
  self-closing-`<fdn-use/>` parse subtlety the automation didn't replicate).
- **1 × `position-outside-overlay`** on a "notched legend" label (`CHANGED · CART MERGE`) straddling the
  top border of a dashed review-diff box — `position:absolute;top:-8px;left:12px`, a classic
  legend-over-fieldset-border trick, not overlay content. Fix: restructured as an ordinary flex column
  with the label as a sibling *above* the box, `align-self:flex-start` + `margin-left:12px` for horizontal
  position, `margin-bottom:-8px` on the label pulling the box up underneath it — same straddle, no
  absolute positioning. Confirmed visually (cropped screenshot) that the notch still reads correctly.

**`overlay-evidence.fdn.html`: 10 errors → 0.**
- **5 × `text-children-conflict`**, same fix as above (board captions and per-instance explanatory prose
  under each of the four overlay demos).
- **5 × `position-outside-overlay`**: two more instances of the same "ghost app chrome" canvas-idiom
  pattern (menu-board and dialog-board), fixed with the same flex-row conversion as system-help-center.
  The menu board additionally had a "docked fleet pane" floating at a fixed offset *inside* the ghost
  content area (`position:absolute;left:1084px;top:64px;width:360px` — real content, not decoration, but
  still not overlay content); converted by making the ghost content card `display:flex;justify-content:
  flex-end` with `padding:52px 24px 0 0`, re-deriving the padding numbers from the original absolute
  offsets minus the card's own new flex margin, so the fleet pane lands in the same pixel position.

**Also fixed, beyond `validate`'s own ask (see UX finding below for why this was necessary for bake
fidelity):** renamed the component prop identifiers `activeTopicId`, `keyGroups`, `leadingTag`
(system-help-center), `selectedItemId`, `detailMode` (inbox-unified, scoped to `InboxChrome`'s own props),
and `triggerActive` (overlay-evidence) to all-lowercase (`activetopicid`, `keygroups`, `leadingtag`,
`selecteditemid`, `detailmode`, `triggeractive`) — see finding 4 below.

**Not touched:** the top-level `<fdn-param>`/`<fdn-state>` camelCase names in `inbox-unified.fdn.html`
(`selectedItemId`, `detailMode`, `narrowScope`, `whatToTestExpanded`, …) and `system-help-center.fdn.html`
(`entryContext`, `rowBindingState`, `dialogOpen`, `searchQuery`) suffer the identical case-folding bug
(their `<fdn-state name="..." xxxYyy="value">` assignment attributes never bind), but nothing in either
board's `<main>` body actually reads `{{ param.xxxYyy }}` for these — the rendered content hardcodes
literal values at each `<fdn-use>` call site instead — so the state-assignment declarations are already
vestigial independent of the case bug. Renaming ~15 param names plus every `<fdn-state>` tag that assigns
them felt out of scope for a `validate`-driven pass with no visible payoff in the default bake; flagged in
finding 4 instead of silently fixed.

**Result:** `pnpm exec tsx packages/cli/src/main.ts validate <board>` reports zero issues (not just zero
errors — zero warnings too) for all three boards. `foundation ingest` was run on each afterward; its only
output was expected, benign normalization info (`shorthand-expanded` for `font`/`padding`/`border-radius`/
`gap`/`inset`, `text-whitespace-normalized`, `resolved-instance-collapsed` for every `<fdn-use>`'s dropped
dual-carried fallback content) — nothing surprising, nothing silently lossy beyond what D1 already commits
to. `pnpm test` remains green (352 tests; the fixpoint/determinism suites are shape-agnostic and the CLI
fixture test already tolerated either validity outcome).

**Visual fidelity:** I inspected the before/after PNGs for all three boards directly (not diffed
mechanically — pixelmatch was available but a mechanical diff would have flagged the *intended* content
increase described below as noise). Layout, alignment, and every hand-verified geometry conversion
(the two flex-row ghost-chrome rewrites, the docked-fleet-pane reposition, and the notched-legend
restructure) read as visually identical to the pre-edit bake. The overlay-evidence board in particular is
close to pixel-identical before/after, since none of its content is `each`-over-`data`-driven — it's the
cleanest apples-to-apples comparison of the three. The other two boards' *after* bakes render substantially
**more complete** than *before* — full paragraph prose, keyboard-shortcut chip rows, and active-state nav
highlighting all now appear where they were silently blank pre-fix. This is not a fidelity regression to
flag; it's the direct, intended effect of fixing `text-children-conflict` (which was silently discarding
the prose text at bake time even before any grammar work — see `buildRegularNode` in `bake/index.ts`:
`if (node.children.length === 0 && node.text !== undefined)`, i.e. text is dropped outright whenever
children are present) and the prop-name-casing bug (finding 4). The *before* bake was already a broken
rendering relative to the boards' own design intent (visible via the dual-carried fallback markup, which
is what a plain-browser "raw open" was actually showing); the *after* bake now matches that intent far
more closely. One content gap remains identical before and after and is **not** fixed by this pass: every
`each="<alias> in data.<name>>"` loop (queue rail, guide-nav topic lists, keyboard-shortcut catalogs)
still renders zero items in bake, for the reason in finding 2 below — a pre-existing engine bug outside
`boards/`'s power to fix, present identically before and after my edits.

### UX review: the `validate` → fix → `ingest` loop as an editing companion

**Best of the loop:**
- `position-outside-overlay`'s message is the model to hold every other corrective error to: it names
  the violation *and* both sanctioned alternatives in one sentence ("position:absolute is only legal
  inside `<fdn-overlay>` — wrap this content in fdn-overlay, or use flex/grid layout instead"). I used it
  almost verbatim as my fix decision tree (wrap vs. convert), and the board's own explanatory comments
  ("ghost app... NOT part of the overlay context") independently confirmed "convert to flex" was the
  right branch every time — message and board intent agreed with no ambiguity.
- `expression-not-in-subset`'s message for the `.split()` case ("iterate a declared data set
  (data.<name>) or a list-typed prop (prop.<name>) directly, no operations") pointed straight at the
  actual fix (make it a real list-typed prop) rather than just saying "method calls aren't allowed" —
  genuinely taught me the sanctioned shape, not just the violation.
- `text-children-conflict`'s message correctly predicts bake's actual behavior ("children win at bake
  time; remove one") — I confirmed this by reading `bake/index.ts`'s `buildRegularNode`, and it matches
  exactly: text is silently ignored whenever `children.length > 0`. No surprises, no gap between what the
  message promises and what the engine does.
- `ingest`'s normalization report is transparent and matched GRAMMAR-FINDINGS (d)'s own predictions
  (`font`/`padding`/`border-radius`/`gap`/`inset` shorthand expansion, self-closing-tag rewriting,
  text-whitespace collapsing) — every line was legible and none were surprising once fired.

**Worst of the loop / confusing:**
- **Node ids are not stable across edits until you `ingest`, and nothing tells you this.** `data-fdn-id`
  is minted fresh, in document order, on every parse of a file that doesn't already carry the attribute —
  so the moment you fix the *first* reported error, every subsequent nodeId in that validate run's output
  refers to a *different* physical element than it will on the next run. I had to build my own tooling
  (a parse5 walk replicating `parse/index.ts`'s exact mint order) to map nodeIds back to source text
  reliably and to plan a whole batch of fixes from one validate run rather than fixing-and-rechecking
  one at a time. A one-line hint on first use — "run `ingest` first to mint stable ids before iterating"
  — or better, `validate` auto-suggesting it when the input has no `data-fdn-id` attributes at all, would
  have saved real time.
- **`text-children-conflict`'s `ReportLine` carries no `detail`.** The type has a `detail?: unknown` field
  precisely for this (other codes populate it — `excluded-style-property` includes `{property, value,
  on}`), but this code passes nothing beyond the bare nodeId. For a conflict on a 250-node document, the
  message tells you *that* something's wrong at `n81` but not *what* the text or child tags are — exactly
  the information I had to reconstruct with custom tooling to fix 50 instances across three boards
  efficiently. Populating `detail: { text, childTags }` would turn this from "go find it yourself" into
  "here's exactly what to split."

**Validator/bake mismatches found (bugs to file, not board mistakes — none of these are board authoring
errors, and I did not work around any of them by guessing which side of the mismatch to trust):**

1. **No confirmed `validate` false positives.** Every error `validate` raised across all three boards
   corresponded to a real problem per the documented grammar (genuine text/children ambiguity, a genuine
   method call, genuine canvas-idiom absolute positioning) — I did not find a case where `validate`
   rejected something that should have been legal.
2. **`each="<alias> in data.<name>>"` — the exact shape `validate` requires — is not the shape `bake`
   executes, and this is the single most consequential finding of this pass.** `validate/index.ts`'s own
   code comment calls `data.<name>` "the sanctioned each-source shape in practice" and its regex
   (`/^data\.([A-Za-z_][A-Za-z0-9_]*)$/`) accepts *only* that shape, rejecting a bare data-set name as an
   `undeclared-ref-root` error. But `bake/index.ts`'s `resolveEachSource` does the opposite: `if
   (source.includes('.'))` routes the source through `resolveRef` against the `prop`/`param` binding bags
   only (no `data` key ever exists there, so `data.guideTopics` always fails to resolve); only a **bare**
   name with no dot at all reaches the branch that actually looks up `ctx.doc.data`. The practical effect,
   reproduced on all three boards: `foundation validate boards/system-help-center.fdn.html` reports zero
   issues, and `foundation bake boards/system-help-center.fdn.html` silently renders the guide-nav topic
   list, both keyboard-shortcut catalogs, and (in `inbox-unified.fdn.html`) the entire queue rail and
   "what to test" checklist as **empty** — every `each="X in data.Y"` loop in every board produces zero
   items. There is no source spelling that satisfies both `validate`'s requirement and `bake`'s
   implementation at once, so this cannot be fixed from `boards/`; I left it reproducible and undisguised
   rather than rewriting the `each` sources to the shape `bake` happens to accept (which would then fail
   `validate` again). To reproduce: bake any board with no `--state` flag and grep the output for content
   that should come from a `data.*` each loop.
3. **That failure is invisible through the CLI.** `bake.ts`'s CLI command only writes `severity ===
   'error'` report lines to stderr; the each-source failure above is reported at `warning` severity
   (`unknown-ref`, "each source ... not found"), so `foundation bake` exits 0 with no diagnostic at all
   while quietly dropping entire sections. I only found finding 2 by noticing large blank regions in the
   before/after screenshots and bisecting by hand — a `foundation bake --verbose` (or just "surface
   warnings too") would have surfaced it directly.
4. **Validator false *negative*: camelCase prop/param identifiers silently fail to bind, with no check
   anywhere.** HTML parses attribute *names* case-insensitively — parse5 lowercases `data-fdn-prop-
   activeTopicId="x"` to `data-fdn-prop-activetopicid` before any engine code sees it (confirmed
   empirically), so `instantiateComponent`'s exact-string lookup against the declared prop name
   (`activeTopicId`, case preserved from `<fdn-prop name="activeTopicId">`) never matches, and the prop
   silently falls back to its default (or `''` — again via a `warning`-severity report line the CLI never
   prints). This is systemic, not a one-off: every board in this repo uses idiomatic camelCase for
   multi-word identifiers (`activeTopicId`, `keyGroups`, `leadingTag`, `triggerActive`, `selectedItemId`,
   `detailMode`, `entryContext`, `rowBindingState`, …), and nothing in the documented expression grammar
   (`types.ts`'s ref EBNF permits `[A-Za-z_][A-Za-z0-9_]*`, mixed case included) suggests this is illegal
   — it is a pure HTML-hosting-format hazard the grammar/validator is silent about. `validate` should
   flag any declared prop/param name that isn't already all-lowercase (or fold case itself consistently
   throughout the pipeline) — as shipped, the identifier is spec-legal and silently non-functional.
5. **Numeric ternary branches are used pervasively and are not in bake's grammar, and `validate` doesn't
   catch it either.** `{{ prop.dim ? .5 : 1 }}`, `{{ prop.weight == 'active' ? 600 : 400 }}` — every human
   reading of "ternary: cond ? value : value" admits a bare number, but `bake/expr.ts`'s `parseValue()`
   only accepts `ref | lookupref | quoted-string-literal`, so these fail at bake time
   (`expr-parse-error`, `"expected a value (ref, lookup[ref], or quoted string)"`). `validate`'s
   `findDisallowedConstructs` only pattern-matches for method calls, so it never flags this. Net effect:
   every `opacity`/`font-weight`/`border-radius` value driven by a numeric ternary bakes to an empty
   declaration (`opacity:;`) across all three boards. This predates my pass, isn't a `validate` error, and
   I left it alone per the task's scope — flagging it here because it's the same *class* of bug as finding
   2 (validate's grammar and bake's grammar have quietly diverged) and because it affects the same visual
   properties (dimmed/disabled row opacity, active-nav-item font-weight) my fixes were trying to restore.

**Missing report codes, concretely:** a `prop-name-not-lowercase` (or equivalent) check at `fdn-prop`/
`fdn-param` declaration time (finding 4); a contract-level check or test that `validate`'s accepted
`each` source grammar and `bake`'s executed `each` source grammar are the same grammar (finding 2 — this
feels like it belongs as an engine-level fixture test, not just a board-level validate rule); and
`text-children-conflict` populating its `detail` field (UX finding above).
