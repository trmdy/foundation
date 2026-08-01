# fdn-design-1 — Apiary Tracks pane exploration board

FILE: boards/tracks-pane.fdn.html · anchor "v1" · validate: 0 issues · 4 params, 3 states,
16 components, 314 nodes · renders inspected at every step.

## What I designed (5 lines)

1. Board 1 — Tracks at rest: a 724px docked list pane of seven *definitions*, each row carrying
   the spine shape on the right (`6 items · 1 branch · 9 nodes`) and its live attachments on the
   left as status dot+label pairs; queue depth and a hollow-brick exception ring trail the row.
2. Board 2 — one track selected: master-detail at 1416px. Left rail is the same list, compacted;
   right is the real schema-v2 spine drawn as typed nodes (action · orchestrate · branch with
   LANE A/B · review with a DENIED arm · deploy · ask), with attached bees and their position in
   the spine, the FIFO queue behind other bees, the recorded exceptions, and the one pending
   `track_propose` edit rendered as an accept/refine/discard diff.
3. Board 3 — empty: what a track *is* in one sentence, one honey CTA, a hand-plotted pixel bee
   (art tokens declared separately from chrome tokens), and the quieter second path — ask a
   sidecar agent to draft one, which arrives as the same proposal loop board 2 shows.
4. Truthfulness: modelled from the real `track_define`/`track_attach`/`track_queue`/`track_propose`
   MCP schemas, not a generic list pane — a definition has no state of its own, queue depth is a
   property of *bees*, and exceptions are deliberately outside the status palette (not a state).
5. Accent budget held: exactly one honey moment per pane (Define track · accept · Define a track);
   every selection, tab, count and status is neutral gray or the shared status palette.

COMMITS: 6 chain entries (init + 5 real edits), anchored "v1".

---

## FRICTION LOG (the honest part)

### 1. `<main>`'s own styles are silently discarded — cost me a render cycle
`parse/index.ts` treats `<main>` as the document root and takes only its *children*
(`bodyNodes = convertChildren(main, ctx)`). Same for `<body>`. So `<main style="padding:32px;
row-gap:44px;width:1416px">` and `<body style="background:var(--color-bg)">` both evaporated:
my first render had zero page padding, no inter-board gaps, and a white page instead of `--bg`.
Nothing reported it — not validate, not ingest's normalization report, not bake's conformance
report. Workaround: an inner `<div data-fdn-style="page">` immediately inside `<main>`, carrying
`margin:-8px` to cancel the browser's default body margin so the bg reaches the viewport edge.
**Ask:** either honour `<main>`'s style, or emit a report line when a root wrapper's attributes
are dropped. The `margin:-8px` trick in particular is a wart every board will now have to repeat.

### 2. **Boolean params are coerced on `default` but NOT on `<fdn-state>` assignments** (real bug)
This is the worst one, because it fails *silently and wrongly*. `parseParams` does
`coerce(type, a.default)` — a `type="boolean"` param's default becomes a real boolean. But
`parseStates` does `state.assignments[k] = v` with no coercion at all, and `bakeDocument` copies
the assignment through verbatim. So `<fdn-state name="at-rest" proposalopen="false">` binds the
**string** `"false"`, and `when="param.proposalopen"` → `isTruthy("false")` → `true`.
Net effect: my `at-rest` and `track-selected` states rendered the "pending proposal" card that
they explicitly turned off, and the `when="!param.proposalopen"` branch was unreachable. Zero
errors, zero warnings, an entirely plausible-looking PNG. I only caught it by comparing two
rendered states side by side and noticing the card was in both.
This is the same *class* as GRAMMAR-FINDINGS §g.4 (camelCase props) and §g.5 (numeric ternaries):
validate's model of the document and bake's model have quietly diverged, and validate has no
check for it. Fix should be one line (`coerce(param.type, v)` in `parseStates`), but a fixture
test asserting "a boolean param assigned by a state is a boolean at bake" is the real ask.
My board-level resolution was to re-model the param as `type="enum" values="pending,none"` —
which I think is genuinely better design, but I want to be clear I changed the design to route
around an engine bug, not because I discovered a better model on my own.

### 3. Ingest sorts components alphabetically, and I deleted one without noticing
After the first ingest, `<fdn-component>` definitions come back sorted by name. I later regenerated
the `PixelBee` sprite with a script that replaced everything between `PixelBee` and `SectionLabel`
— which, post-sort, contained `QueuedRow`. It vanished. `validate` returned **0 issues** on a
document with a live `<fdn-use component="QueuedRow">` pointing at nothing. I caught it only
because I grepped the component list for an unrelated reason.
**Missing check:** `fdn-use` referencing an undeclared component should be a validate *error*.
Right now an unresolvable component reference is invisible until you stare at a PNG and notice a
section is blank — and a blank section in a busy board is very easy to miss.

### 4. `foundation_render`'s MCP result is unusable at board scale
The layout array is one entry per node — for a 314-node board that's ~170KB of JSON, which blew
the tool-result limit and got spilled to a file. The PNG path (the only thing I actually needed)
was buried in the truncated preview. From render #3 onward I abandoned the MCP tool and shelled
out to `pnpm exec tsx packages/cli/src/main.ts render`, which prints one line: the PNG path.
**Ask:** make the layout report opt-in (`includeLayout: false` default), or return only the paths
and write layout JSON to disk like the CLI already does. As shipped, the primary "look at your
work" verb is the one I could not keep using.

### 5. No way to render a crop / no way to view the PNG without leaving the toolchain
Related but separate: every visual check is a full-page PNG of a 1480×2136 board, downscaled by
the image reader to ~1386px wide. Fine-grained things — is the status dot actually 7px, is the
exception ring hollow, does the pixel bee read as a bee — are simply not legible at that scale.
I ended up driving `sips` to crop regions before I could judge my own sprite. A
`foundation_render` option for a node-scoped crop (`node: "n271"` — the layout report already has
every box) would turn three shell round-trips into one call.

### 6. Small things that were right, and one that wasn't
- `data.<name>` each-sources and the `lookup[ref]` primitive both work now; the two bugs
  GRAMMAR-FINDINGS §b.2 and §g.2 asked for are fixed. `statuscolor[prop.state]` collapsed what
  would have been six near-identical `when` branches into one span. This is the single biggest
  quality-of-life win in the grammar since that document was written.
- `style-hover` on `<fdn-style>` works and merges correctly at bake. Named styles genuinely
  dedup now (bake inlines them), so the §b.3 dual-carry tax is gone for anyone who bakes.
- Writing resolved children inside `<fdn-use>` is pointless work — ingest strips them
  (`resolved-instance-collapsed`). GRAMMAR-FINDINGS a.3 argues at length for dual-carry; the
  engine has since decided against it. **The findings doc now actively misleads a new agent on
  this point** and should be amended, because I nearly wrote every instance twice.
- `text-children-conflict` never fired once across ~314 nodes, because I knew about it up front
  from the findings doc. That's a good error existing; it's also evidence the rule is learnable
  but not *discoverable* — nothing in the tool descriptions mentions it.

### 7. Meta: the tool descriptions oversell `foundation_new`
`foundation_new` scaffolds a document whose one token is `--color-accent: #3366CC` — a cool blue,
in a toolchain whose only real consumer is a warm-accent design system. Everything it generates
gets deleted on the first real edit. Its actual value was starting the chain, which is worth
keeping; the scaffold content is not. A `--empty` mode that emits only the header + chain would
have saved a delete-everything step.
