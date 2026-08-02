FDN-DESIGN-3 · boards/usage-dashboard.fdn.html · "Apiary — Account usage"
=========================================================================

SUMMARY (5 lines)
1. Two boards on real `hive usage --json` data (17 accounts, 4 providers): board 1 is the
   whole fleet at a glance — one 176px meter per rolling window, grouped by provider,
   with unreachable accounts kept in place carrying the CLI's own error text verbatim.
2. Board 2 expands claude-tormod-thto.no: three windows at real size, a 5h timeline
   marking NOW / projected exhaustion / the reset it will not reach, and a spillover
   rail ranking the accounts the fleet drains onto — the decision behind the number.
3. The one invented idea worth keeping: `projected = used% ÷ elapsed% of the window`.
   Used% alone is meaningless (58% is fine four hours in, alarming forty minutes in),
   so tone leaves calm only when the projection crosses 100% — 15 of 17 rows stay grey.
4. Apiary accent budget held: exactly one honey CTA per pane (Rebalance spawns / Park
   new spawns), everything else neutral gray or the shared status palette, no filled
   status pills, 4px grid, boxless docked panes.
5. 3 states (at-rest · anthropic-only · forecast-flat) × 1 viewport (1560×2040), all
   render with 0 errors; validate clean (0 issues); bake conformance info-only.

COMMITS
13 distinct chain commits (the chain log renders 21 envelopes — see friction §10):
  init · import Icon (native) · import Badge (native) · import UsageMeter (sealed) ·
  import UsageMeter (sealed, 2nd attempt) · import UsageMeter (native) · board v0 ·
  fleet row geometry · column header · grid/flat-forecast · viewport · doc-id ×2
Anchor `v1` = head (1f27d6060ad5). Registered: foundation.json now lists 5 documents,
`usage-dashboard.fdn.html  ok  chain 1f27d6060ad5`, docId 4598eca9-2093-42bf-b6d3-34fcd2df017e.

IMPORT OUTCOMES
  Icon      fixtures/icon.tsx        → NATIVE.  1 report line. 0 tokens added.
                                       1 prop (label), sentinel-substituted into aria-label.
                                       Used 3× (projection explainer, forecast explainer,
                                       unreachable-accounts callout), aria-label bound to real copy.
  Badge     fixtures/badge.tsx       → NATIVE.  14 report lines. 10 theme vars → document
                                       tokens (color-{amber,blue,green}-{100,800}, spacing,
                                       text-xs, text-xs--line-height, font-weight-semibold),
                                       1 unresolved (--tw-leading). `variant` folded into two
                                       generated lookups (BadgeLookup1 background, BadgeLookup2
                                       colour). Retuned post-import: Tailwind blue/green/amber →
                                       Apiary tokens, rounded-full pill → radius-4 hairline chip.
                                       Used for plan (max/pro/advanced), auth source, NO AUTH.
  UsageMeter /tmp/c3-components/usage-meter.tsx (authored here; cva, 3 variant groups,
                                       hover: state, Tailwind only)
                                     → SEALED, SEALED, then NATIVE on the third import once
                                       I found the classIndex keying bug (friction §2).
                                       Final: 25 report lines. 4 theme vars → tokens
                                       (font-mono, radius-md, spacing, tracking-wider);
                                       12 unresolved theme vars (my own --color-* tokens, which
                                       the document declares, plus Tailwind's --tw-numeric-*
                                       plumbing — both benign). `tone` folded into 2 lookups,
                                       `size` folded into 3 ternaries, hover: → style-hover.
                                       Used 34× in board 1 (size=sm) and 3× in board 2 (size=md),
                                       every prop bound to data.

TOTALS: 3 components imported, 2 native first try, 1 native after 2 seals.
        14 document tokens contributed by imports; 13 unresolved-theme-var warnings, all benign.

=========================================================================
FRICTION LOG (honest, foundation_import first)
=========================================================================

§1 — foundation_import cannot compile a .tsx that lives outside a node_modules tree.
  /tmp/c3-components/usage-meter.tsx →
    "harvest failed [compile-error]: esbuild compile failed: Could not resolve
     "react/jsx-runtime"; Could not resolve "react-dom/server.node"; Could not resolve "react""
  compile.ts's own docstring claims "Only this shim's own react/react-dom imports resolve
  against foundation-importer's pinned versions" — but `resolveDir` is the *component's*
  directory, so they resolve from there and find nothing. The task brief asks for a component
  under /tmp, i.e. the documented happy path is unreachable out of the box. Routed around by
  symlinking packages/importer/node_modules into /tmp/c3-components. The error also never names
  the fix ("the component's directory has no react — install or link one"), so an agent without
  read access to compile.ts would just be stuck.

§2 — THE BIG ONE. Every Tailwind arbitrary value referencing a CSS var is unprojectable,
     and the report blames the class instead of the cause.
  I deliberately wrote the component against the board's own tokens so it would land inside the
  Apiary palette: `bg-[var(--color-surface-sunken)]`, `text-[var(--color-text-faint)]`,
  `hover:bg-[var(--color-hover)]`. Every one produced:
    import-unprojectable-css: class "…" is not in the compiled classIndex — its declarations
    are unknown, so it cannot be faithfully projected
  …and the component sealed. Adding the disambiguating type hint (`bg-[color:var(--x)]`) changed
  nothing. Root cause is in harness/class-index.ts: entries are keyed by
  `design.printCandidate({...candidate, variants: []})`, and Tailwind *normalizes* on print:
      bg-[color:var(--color-surface-sunken)]  →  key "bg-(color:--color-surface-sunken)"
      text-[color:var(--color-text-faint)]    →  key "text-(color:--color-text-faint)"
      bg-[#B8842E]                            →  key "bg-[#B8842E]"        (round-trips fine)
  So the key never equals the token project/style.ts looks up. Only var() references break;
  literal arbitrary values are fine. Workaround: write them in Tailwind v4's shorthand form
  `bg-(--color-hover)` / `text-(--color-text-faint)`, which round-trips exactly and resolves to
  the right declaration — third import went native with no other change.
  I found this by reading class-index.ts and running printCandidate by hand. Nothing in the
  report, the tool description, or the message points at normalization. This silently pushes
  *any* design-token-driven component — the exact kind you want to import into Foundation —
  into sealed mode.

§3 — "sealed" was not behaviour-preserving here, though the docs promise it is.
  The tool description: a sealed component "still works correctly at bake time (same props in,
  same html out)". But my sealed capsules also carried:
    import-unprojectable-css: class "bg-[var(--color-surface-sunken)]" … omitted from the
    sealed capsule's css
  i.e. the capsule dropped the very declarations that failed to project. The meter would have
  baked as an uncoloured, trackless stack. The warnings are honest; the headline claim is not,
  and the brief's "sealed is legal, accept it" is bad advice in precisely this case. Suggest the
  seal path either inline the raw CSS it couldn't resolve, or promote the omission to an error.

§4 — A string prop that lands in an inline `style` value is silently never bound.
  `style={{ width: fill }}` came through the projection as a literal, un-substituted sentinel:
      width:⟦fdn:prop:fill⟧
  project/sentinel.ts walks `node.attrs` and `node.text` only; the parsed style map is a separate
  field. The report is technically honest by omission — there are import-sentinel-substituted
  lines for label/value/resets/pace and none for `fill` — but an absent line is not a signal, and
  a raw `⟦fdn:prop:…⟧` surviving into the document should be an error, not silence. The document
  then validated clean with a broken interpolation in it. Fixed by hand-editing to {{ prop.fill }}.

§5 — Adapting an imported component is unprotected against the next import.
  Both fixtures needed post-import work to be usable (Badge: Tailwind blue/green/amber → Apiary
  tokens, rounded-full filled pill → hairline chip; UsageMeter: the §4 sentinel). "Native means
  editable" is real and good — but a re-import of the same source silently replaces the whole
  component body, discarding all of it, with no diff and no warning. `data-fdn-import-sha256` is
  already stamped on the component and is exactly the mechanism needed to say "this component has
  local edits since import"; it isn't used that way.

§6 — MCP foundation_ingest strips data-fdn-doc-id. The CLI foundation ingest does not.
  Reproduced on a scratch copy of tracks-pane.fdn.html:
      foundation ingest        → data-fdn-doc-id still present
      mcp foundation_ingest    → data-fdn-doc-id gone
  Cause: the doc id lives only in the file text (docid.ts deliberately bypasses
  parse/project, since FdnDocument has no field for it), and the MCP path is
  parse → project → write with no re-stamp. Consequences, in order: `foundation new` minted an
  id; my first MCP ingest deleted it; every later chain commit stored a doc with no id, so the
  chain's own docId() went null too; `foundation project add` then refused the document with
  "no document id found (no data-fdn-doc-id stamped in the text and no <path>.chain)" — the
  second half of which is also wrong, the chain existed and was healthy. The original id is
  unrecoverable (not in the Loro blob as text), so I minted a fresh UUID and landed it via the
  CLI, which preserves it. For the tool documented as "THE write path for agents editing
  Foundation documents", silently deleting the document's identity is the worst finding here.

§7 — foundation_render reports a warning count you cannot read.
  Every render returned `warnings: 265` (later 279) with no lines, no flag to reveal them, and
  the CLI's render command doesn't print them either. foundation_bake on the same state reported
  0 warnings, so the two surfaces disagree. They turn out to be `system-font-stack` — one line
  per font-family declaration in the tree, i.e. ONE finding repeated 265 times, because
  render/index.ts concatenates preReport + bake lines + font lines without running bake's own
  dedupeReports. A three-digit unreadable warning count on every single render trains you to
  ignore the field entirely, which is the opposite of what it's for.

§8 — The `node` crop can't address iterated instances, and the error guesses the wrong cause.
  `node: "n162"` (an fdn-use with each="w in data.windows") →
    "node "n162" not found in this cell's layout (it may be when-gated out of this state/viewport)"
  It was not when-gated; it was iterated, and instances carry derived ids (n100::n30 style, per
  the layout JSON). The suggestion sends you looking in the wrong place, and the instance-id
  scheme isn't documented on the tool.

§9 — <fdn-use> survives bake as an inline wrapper, so a component's own root can't be a flex item.
  Three WindowBlocks with `flex:1` sat at content width inside a `display:flex` row, filling ~58%
  of the pane. The baked HTML keeps `<fdn-use …>` wrapping the resolved subtree; an unknown
  element is `display:inline`, so `flex:1` on the component's root div never reaches the flex
  container. I diagnosed this by reading the baked HTML. Worked around with
  `display:grid; grid-template-columns:1fr 1fr 1fr` on the parent, which sizes the wrapper.
  Worth a line in the grammar docs: **layout that a component must negotiate with its parent has
  to be expressed at the use site, not on the component root.**

§10 — Chain log shows two envelopes per commit.
  Every `--commit` produced two entries with the same message and the same prevHash — e.g. two
  "Usage board v0" both at prevHash d0ea712…, two "Fleet row geometry" both at 305c45e…. 13
  commits, 21 entries. Nothing broke and verify didn't complain, but the log reads as a fork per
  commit and makes the history hard to trust at a glance.

§11 — Minor: imported arbitrary sizes are off-token by construction.
  `text-[10.5px]` projects to a literal `10.5px`, which bake then flags 22× as
  off-token-value ("matches token font-size-xs — consider var(--font-size-xs)") — and
  --font-size-xs is *exactly* 10.5px. The importer resolves Tailwind *theme* vars into document
  tokens (nice, and it worked) but never snaps a literal to an existing document token, so every
  imported component starts life with conformance noise it can't avoid.

§12 — Minor, docs: GRAMMAR-FINDINGS.md §a.3 still shows the retired dual-carry <fdn-use> form.
  It carries a 2026-08-01 amendment saying so, which saved me — but the amendment is two screens
  below the code block an agent will actually copy.

WHAT WENT WELL (so it isn't only complaints)
  · The three-attempt import loop worked exactly as a loop should: each report was specific
    enough to act on, and `action: "replaced"` + a fresh chain commit made retrying cheap.
  · cva → enum props → generated lookups + ternaries is genuinely good projection. `tone` became
    two lookups and `size` three ternaries with no help from me, and the result is editable
    Foundation content I then bound to real data.
  · `hover:bg-(--color-hover)` → `style-hover` round-tripped correctly into the grammar's own
    interaction model.
  · The `node` crop (when the id is addressable) is the single most useful tool in the loop —
    judging a 176px meter from a 1560×2040 full-page PNG is not possible, and cropping made
    the "the two meters read as one object" and "the fable column looks like part of weekly"
    problems obvious in one look.
  · validate/bake/render never disagreed about correctness; every problem I had was legibility,
    not brokenness.

ARTIFACTS
  boards/usage-dashboard.fdn.html            (+ .chain, anchor v1)
  boards/foundation.json                     (5 documents)
  /tmp/c3-components/usage-meter.tsx         (authored; lib/cva.ts + node_modules symlink alongside)
  /tmp/c3-render/v1/{at-rest,anthropic-only,forecast-flat}--board.png
