# Epic — Foundation-in-Apiary: the Phase C surface

- **Status:** design draft, 2026-08-02. Nothing implemented; no code written.
  Resolves PRD open question 2 (RailKind at Phase C vs. staying a served page
  in the browser sidecar — **decided here: promote**, see §The Portal test).
  Leaves PRD open question 3 (design-system inheritance) explicitly unresolved
  — see §Product design systems.
- **Home:** written into `repos/foundation/docs/` because Phase C is scoped by
  `PRD.md` §5 and the type contract (`FdnAnnotation`) it depends on lives here.
  The implementation is 100% apiary code (`apps/desktop`, `packages/core`); this
  file moves into `apiary/docs/epics/` with that PR — nothing here commits
  foundation-engine to anything.
- **Companions:** apiary `docs/EMBEDDED_APPS_DESIGN.md` §3, `docs/AGENT_GATEWAY_DESIGN.md`,
  `docs/epics/sheets-and-docs.md` (style + the RailKind precedent imitated on
  purpose); foundation `docs/PRD.md` §4/§5, `docs/SPEC.md` D2/D4/§13a, `packages/engine/src/types.ts`.
- **Scope:** Phase C (L3a) only — the dedicated Apiary pane/rail. Component
  importer v1 and Product design-system authoring are PRD Phase C line items
  too but separate engine/importer work with their own doc; this is the *surface*.

## Problem

Foundation documents exist and can be inspected, baked, rendered, diffed, and
served — headlessly, via CLI or MCP — but a human today watches one by opening
`foundation serve`'s URL in a **browser tab**. That is deliberately fine for
Phase A/B (PRD §5: "`serve` replaces every `drafts/*/server.mjs`"), and it is
exactly the failure mode Portal already taught the house to recognize: a
served page in a browser tab is one page at a time, one URL, no chain, no
diff, no annotation state — everything Foundation's *type system* already
promises (`FdnAnnotation`, anchors, `SemanticOp`, `ConformanceReport`) and the
browser can't show. Two boards this dogfooding round already hit the ceiling
by hand: `tracks-pane-run.md` compared two rendered states "by noticing the
card was in both" (no diff tool in the loop at all), and
`usage-dashboard-run.md` abandoned the MCP render tool for a raw CLI shell-out
because the only way to *look at* a 314-node board was a full-page PNG at
1386px (friction §4–5, both docs). The dogfood evidence says the missing
surface isn't a nicety — it's the tool people are already reaching around.

## What exists today (facts)

**Foundation side.** `foundation serve <file> [--port N]` (`packages/cli/src/commands/serve.ts`)
binds `node:http` on a caller-supplied or OS-assigned port
(`serve/index.ts:242`, default `port ?? 0`), watches the file itself with
`fs.watch` (`serve/index.ts:233`) and pushes SSE `reload` events, and wraps
the baked HTML in **its own floating chrome**: a bottom strip with state
links, `/report`, `/source`, and an error badge (`wrapPage`, `serve/index.ts:76-99`).
There is no document-metadata JSON endpoint — `/report` returns a
`ConformanceReport` for one `?state=`, nothing lists state *names*, the
matrix, or annotations, and `foundation inspect`/`foundation_inspect` return
only **counts** (`states: doc.states.length`, `inspect.ts:42`; `tools.ts:286`),
never names. `FdnAnnotation` (`types.ts:106-120`) and the `annotate` /
`set-annotation-status` / `remove-annotation` `PatchOp`s (`types.ts:230-232`)
are real, typed, chain-native — "hidden metadata in projection, never baked
into design output" (`types.ts:139`) — but **no CLI command and no MCP tool
writes one**: `main.ts`'s command table has no `patch`/`annotate` verb, and
the live `TOOLS` registry (`mcp/tools.ts:807-987`) tops out at 13 verbs with
nothing that appends to `doc.annotations`. This is the one hard blocker for
§Comment tee, and it's a foundation-repo gap, not an apiary one. Foundation
already has a working "resolve my own absolute path" precedent:
`resolveShimCommand` (`packages/cli/src/mcp/gatewayRegistry.ts:127-146`) looks
for a global wrapper at **`~/.local/bin/foundation`** first, falls back to
`process.argv[1]` with a loud portability warning, and is what `foundation
gateway install` uses to seed bees' MCP config today — but the CLI's bin
target is presently `#!/usr/bin/env -S npx tsx` over `src/main.ts`
(`packages/cli/package.json` `bin`; `main.ts:1`), so there is no compiled,
standalone binary yet. `boards/foundation.json` is real and already the
grouping unit in practice: `{ schema, id, name, documents: [{ path, docId }] }`,
5 documents today, no `designSystem` populated even though `SPEC.md` §13a(iii)
reserves that field.

**Apiary side.** The Portal pane was built, shipped, and cut in one day
(`EMBEDDED_APPS_DESIGN.md` §3): "under the hood it was the Browser pane in
different clothes" — codified here as **the Portal test**. `ViewTypes`
(`packages/core/src/views.ts`) is a flat string-enum registry with a params
comment convention (`Sheet: 'files.sheet'`, params `{ path?, sheet? }`,
`views.ts:75-79`) — adding a type is cheap. `RailKind`
(`packages/core/src/agentSurfacesState.ts:1-12`) is a closed union;
`AGENT_GATEWAY_RAIL_KINDS` (`:14-22`) is the agent-drivable subset,
`AgentSurfaceStateY` (`:66-85`) carries per-kind singleton handle fields
(`sheetPath`, `readerPaths`) that `migrateAgentSurfaceState` (`:267-303`) and
`sidecarShowSheetPath`/`sidecarShowReaderPath` (`:438-470`) maintain.
`sheets-and-docs.md` §Sequencing ran this exact motion for `files.sheet`/`sheet`
and dated the RailKind join "ASAP — phase 3" — direct precedent for this
doc's own phase split. `synHost.ts` is the **don't-own-the-process** pattern:
it never spawns Syn, only bridges a WebSocket to an already-running app and
file-watches a library dir with a debounce (`WATCH_DEBOUNCE_MS = 400`, `:51`)
and exponential reconnect (`RECONNECT_MIN_MS`/`MAX_MS`, `:47-48`, doubling in
`scheduleReconnect`, `:512-519`). `waxHost.ts` is the **own-the-process**
pattern: `resolveWaxBinary` (`:206-264`) tries an env override, then a
packaged/bundled resource, then PATH, in that order; the host spawns one
long-lived subprocess, multiplexes typed NDJSON requests over stdio by id,
times every request out, and allows **exactly one restart** after a crash
(`hasCrashed`/`restartUsed`, `:568-586`) before failing loud. `ProductsHost`
(`product-folders-and-scratch-design.md` §1-2) is the **CLI-in-main**
pattern: every `pro` invocation is `execFile` in main, never the renderer.
`browser-comment-mode.md`'s v2 is the shipped per-comment dispatch shape:
pick element → prompt card → **Add task** or **Message**, target defaulting
to "the sidecar's own bee when the browser is an agent sidecar."

## Decision (proposed)

The Foundation pane is a new pane type, `foundation.board`, embedding a
main-managed `foundation serve` process in a native `WebContentsView` with
Apiary chrome around it. It reuses three house patterns nearly whole —
gateway rings, the RailKind/sidecar state machine, and browser comment
mode's capture-and-tee mechanics — rather than inventing parallel machinery
for any of them. What's genuinely new is the host: no existing host manages
*N concurrent per-file HTTP servers with a port registry*; wax owns one
process for the app's life, Syn owns none.

### Rejected alternatives (host + pane shape)

1. **Bundle `foundation-engine` into apiary and render boards in-process.**
   Rejected on two grounds. First, architecture tenet #3 — "Apiary owns
   UI/composition state, not tool truth" (`architecture.md:35-40`) — design
   truth is Foundation's, exactly as PRD §9 rejected-alternative 6 argues
   against building Foundation inside Apiary at all ("couples the format to
   an Electron app's lifecycle... violates the independence stance"). Second,
   generalize the wax lesson past its own language: apiary never grows
   another product's toolchain in its dependency tree, Rust or Node — wax
   ships as a vendored/PATH binary specifically so sheet-parsing JS never
   enters apiary (`sheets-and-docs.md` §Spike results); `foundation-engine`
   as an apiary `package.json` dependency is the same mistake with
   `npm install` instead of `cargo`. This dogfood round alone found a
   parse-root style bug, a state-assignment coercion bug, and an import
   class-index keying bug — exactly the independent-repo velocity a bundled
   dependency would drag into every apiary release.
2. **Load the served page in a plain `<iframe>` in the renderer.** Rejected:
   the house CSP is `default-src 'self'` (`sheets-and-docs.md` §What exists
   today), so a cross-origin `http://127.0.0.1:<port>` iframe needs a carve-out
   apiary has zero of today; more importantly, `WebContentsView` already
   solves this pane's actual problem — native-view-floats-above-DOM chrome
   reservation (`EMBEDDED_APPS_DESIGN.md` §4.1), the obscuring guard, the
   permission broker, and (for §Comment tee) the isolated-world
   script-injection machinery browser comment mode already hardened. An
   iframe rebuilds all of that inside a sandboxed frame with strictly worse
   tooling — the same conclusion Portal itself reached ("the browser pane's
   `WebContentsView` machinery" was Portal's actual substance,
   `EMBEDDED_APPS_DESIGN.md` §3); this pane inherits the substance, not the
   app-mode skin.

## The Portal test

Portal died because "wear a web app as a pane" bought nothing a URL bar
didn't already buy. Every headline Foundation-pane feature is checked here
against the same question: *could a plain browser tab pointed at the served
URL do this?*

- **Chain-history rail.** A scrollable list of chain envelopes/anchors
  (`foundation chain log` / `foundation_chain_log`), click-to-preview any
  point in the document's history. `foundation serve` has no notion of the
  chain at all — it bakes whatever is on disk *right now*. No URL exists for
  "anchor 9," because anchors aren't page state, they're chain state a
  browser never sees.
- **State-matrix side-by-side.** The declared matrix (states × viewports) is
  Foundation's actual design surface (SPEC §4, §5) — comparing two states is
  the point of iterating on a document. A browser tab shows exactly one
  `?state=` at a time; flipping between two to eyeball a diff is how
  `tracks-pane-run.md`'s friction §2 (a silently-wrong boolean coercion) went
  undetected until "I only caught it by comparing two rendered states side by
  side." A pane that lays out N baked states in one view turns that into a
  glance instead of a memory exercise.
- **Structural diff view.** `foundation diff`/`foundation_diff` emits
  `SemanticOp[]` — document-vocabulary changes ("padding token changed on
  `hero.cta`"), not byte ranges (SPEC §6). No URL renders a diff; the served
  page renders states, never deltas between them.
- **Annotations → chain.** Comments here *are* `PatchOp`s appended to the
  document's own chain (once §Comment tee's blocking dependency ships) —
  durable, resolvable, carrying `agent:<bee>`/`user:<id>` authorship forever.
  A browser has no channel back into a chain it never opened; the served
  page is read-only by construction.
- **Validate/conformance status.** A live badge sourced from `/report`,
  refreshed on the same `reload` SSE event the page already gets, tied to
  the document's identity across every state — not a page attribute, a
  property of the artifact.

None of these are expressible as "the same page, different URL." That's the
bar Portal failed and this pane clears — which is also this doc's answer to
PRD open question 2: promote to a dedicated RailKind/pane at Phase C, don't
wait for more evidence in the browser sidecar. The dogfood friction logs
already are the evidence.

## Host architecture: `foundationHost.ts`

One main-process host, one `foundation serve` **child process per open
document path**, because `serve` is bound to one file and knows nothing
about siblings — unlike wax's one-process/many-handles shape, this is
per-document, wax's binary-resolution rigor plus Syn's watch/backoff
discipline, recombined for a process the host itself must spawn *and*
supervise as an HTTP peer rather than an RPC pipe.

**Binary resolution** deliberately has no bundled tier — the omission is the
enforcement mechanism for rejected alternative 1 above:

```ts
// mirrors resolveShimCommand (foundation's own gatewayRegistry.ts:127-146) —
// same target location, so a machine that installed the CLI once satisfies
// both apiary's host AND every bee's MCP shim.
async function resolveFoundationBinary(env = process.env): Promise<FoundationBinaryResolution> {
  const override = env.APIARY_FOUNDATION_BIN?.trim()
  if (override) return { command: override, source: 'env' }
  const localBin = join(env.HOME ?? homedir(), '.local', 'bin', 'foundation')
  if (await isExecutable(localBin)) return { command: localBin, source: 'local-bin' }
  const onPath = await findExecutableOnPath('foundation', env.PATH ?? '')
  if (onPath) return { command: onPath, source: 'path' }
  return { command: null, probedPaths: [localBin, ...pathCandidates], source: 'missing' }
}
```

No `--version` flag exists on the CLI today (wax's version probe,
`waxHost.ts:266-292`, is the shape to copy once it does); v1 skips the
handshake and treats a failed first request as `foundation_missing`, same
honesty tier as `WaxHostError('wax_missing', …)`.

**Port registry.** Rather than scrape `serve`'s human-readable stdout banner
(`foundation serve — <file>` then a bare URL line — not the NDJSON wax gets
to rely on), the host picks the port itself: bind an ephemeral `net.Server`
to port 0, read `.address().port`, close it, and pass that port to
`foundation serve <path> --port <N>` — the same race-and-retry-on-`EADDRINUSE`
technique every Node dev-server wrapper uses. A registry
(`Map<absolutePath, { port, pid, child, refCount }>`) tracks one entry per
open document; a second pane on the same path increments `refCount` instead
of spawning a second server (the wax-handle-dedup lesson, applied at the
process level instead of the request level).

**Health, watch, and restart.** "Watch" here means **process supervision**,
not content — `serve` already file-watches and SSE-reloads its own content
(`serve/index.ts:233`), so foundationHost's watcher only asks "is the child
still alive and answering." On spawn, poll `GET /` until 200 within an open
timeout (`waxHost.ts`'s `openTimeoutMs`); on unexpected exit, one restart
(`waxHost.ts:568-586`'s `hasCrashed`/`restartUsed` verbatim), then a loud
`foundation-crashed` empty state naming the resolved binary and probed
paths — never a silent retry loop. On the last pane referencing a path
closing, hold the process warm for a short grace window (Mirror's 45-second
idle-then-stop, `EMBEDDED_APPS_DESIGN.md` §2) so quick tab flips don't pay a
re-spawn.

**Reads that don't need a child process.** Chain log/anchor/diff have no
HTTP surface (`serve/index.ts` exposes only `/`, `/events`, `/source`,
`/report`) and go through `execFile('foundation', [...])` in main — the
`ProductsHost`/`pro` precedent verbatim ("All `pro` invocations live in the
main process," `product-folders-and-scratch-design.md` §1). The conformance
badge is a cheap `fetch` against the already-running server's own
`/report?state=` — no extra process. The state-tab strip is the interesting
middle case: `serve` never exposes state *names* structurally
(`foundation_inspect` gives only a count, `tools.ts:286`), but the served
page already renders them as anchors (`stateLinks()`, `serve/index.ts:59-68`)
— v1 scrapes those via the same isolated-world `executeJavaScript` mechanism
browser comment mode uses to read guest DOM safely, rather than wait on a new
Foundation API. Named plainly: **foundation should grow a structured
state/matrix/annotation-count read, and until it does, apiary's chrome is
held together with one DOM-scrape.**

## Pane + RailKind

`ViewTypes.FoundationBoard = 'foundation.board'`, params `{ path }` — one
document per pane, the `files.sheet` precedent exactly (`views.ts:75-79`).
Registration follows the same nine-step motion `sheets-and-docs.md` already
ran for the Sheet pane, split across C2/C3 below:

1. `ViewTypes.FoundationBoard` entry (`views.ts`).
2. `panes/registry.tsx` case → `FoundationBoardPane.tsx`.
3. `launcherCatalogue.ts` entry ("Foundation board").
4. `paneIcons.tsx` glyph.
5. Commands `foundation.open` / `foundation.new` in `CommandIds`, registered
   beside the Sheet/PDF precedent.
6. `RailKind` gains `'design'` (`agentSurfacesState.ts`'s `RAIL_KINDS` set,
   `:98-110`) — singleton, like `sheet`, not multi-instance like `browser`.
7. `AGENT_GATEWAY_RAIL_KINDS` gains `'design'` — Ring-1 self-opening for a
   bee's own board is exactly as harmless as its own sheet viewer; ship it
   alongside the RailKind itself rather than deferring further (the sheet
   precedent hesitated over exactly this and then just did it "ASAP").
8. `SIDECAR_PANE_KINDS` pop-out entry + a sidecar key combo
   (`agentSidecarKeys.ts`, ⌘⌥-family, next free slot).
9. `AgentSurfaceStateY` gains `designPath?: string` (singleton handle, mirrors
   `sheetPath`), migration in `migrateAgentSurfaceState`, and
   `sidecarShowDesignPath` mirroring `sidecarShowSheetPath` (`:464-470`).

Steps 1–5 are C2 (pane exists, opens, has its full native chrome — chain
rail, state tabs, diff view, conformance badge — from day one, since that
chrome *is* what passes the Portal test). Steps 6–9 are C3, alongside the
comment tee, matching the task's own phase split below.

### Comment-mode tee

Reuse browser comment mode's v2 shape (`browser-comment-mode.md`, its "in-page
prompt" redesign) against the served `WebContentsView` verbatim: pick an
element (or a viewport point, mirroring `FdnAnnotation`'s dual anchor —
`nodeId` when available, `x`/`y` else, `types.ts:111-115`), a prompt card
opens in the same isolated-world family, target defaults to the sidecar's own
bee when the board is an agent sidecar. The dispatch step is the only real
difference: instead of a task/buz message, the batch (or per-comment prompt)
calls a Foundation write path that appends an `annotate` `PatchOp` —

```
foundation annotate <path> --node <nodeId|x,y> --state <state> --text "..." --author <principal>
```

— **this command does not exist yet**, nor does an MCP `foundation_annotate`
tool (the live registry tops out at 13 verbs, none touching
`doc.annotations`). There is no correct workaround: annotations are
explicitly "hidden metadata in projection, never baked into design output"
(`types.ts:139`), so routing a comment through `foundation_ingest`'s
text-write path would mean hand-editing projected markup to fake one —
exactly the "worse than doing the real thing" the gateway design forbids for
browsers (`AGENT_GATEWAY_DESIGN.md` §7, quoted the same way in
`sheets-and-docs.md`'s Problem section). **This blocks C3 outright and is a
foundation-repo dependency, not an apiary gap** — filed here so the
implementation PR doesn't discover it mid-build.

## Product design systems

`boards/foundation.json` (`schema`, `id`, `name`, `documents: [{ path, docId }]`)
is the grouping unit the pane uses today: opening one document reads its
sibling manifest (walking up from `path`, the `ProductsHost`/`pro` discovery
pattern) and offers a board switcher over `documents[]` — Library-style, like
`library.syn`'s day-grouped packet list, scoped to one manifest rather than a
global scan.

**Product-level design-system documents are explicitly not this phase.**
PRD §4 describes "Product-level design system documents... that member
documents inherit," and `SPEC.md` §13a(iii) even reserves a
`designSystem?: <path>` manifest field — but nothing consumes it. `SPEC.md`
§3 lists "inheritance from design system documents" under **to fill**,
unresolved, naming the cost of not having it: "both boards duplicated their
full token + component sets for lack of it" (`SPEC.md:279-280`, finding b.6).
PRD open question 3 ("system wins, document override is a visible
conformance delta") is a *lean*, not resolved semantics — conflict
resolution, override UI, and what "member of a design system" means are all
unwritten. Phase C's pane reads `documents[]` and ignores `designSystem` if
present. **Follow-up, unscheduled: "Product design-system inheritance"** —
needs its own SPEC resolution before any pane UI can honestly show "this
board inherits from X."

This also resolves the PRD's "per Product and per Bee" grouping language into
concrete Apiary terms: **per Product** is the manifest-scoped board switcher
in the main pane (§ above); **per Bee** is the `design` RailKind singleton
sidecar (§Pane + RailKind steps 6–9) — two different UI surfaces for two
different groupings, not one mechanism doing both.

## Sequencing

**C2 — host + pane + launcher/commands (no rail, no tee).**
`foundationHost.ts` spawns/tracks/tears down `foundation serve` per open
path; port registry with health probe; one crash restart, then a loud
`foundation-crashed` state. `ViewTypes.FoundationBoard` opens from a
`.fdn.html`/`foundation.json` entry point and from `foundation.new`; the pane
renders the served page live in a native `WebContentsView` with its full
native chrome — state tabs (scraped), a chain rail (`execFile` reads), a
structural diff view between two anchors, a conformance badge (`/report`
fetch). *Exit criterion:* a designer or bee opens a board, flips through its
declared states and an old anchor, and sees a validate-clean badge — no
browser tab, no hand CLI. Panes on one path share a server; the last close
tears it down after its idle grace window.

**C3 — comment tee + RailKind + presence.**
`design` RailKind ships (steps 6–9): a bee's own board lives in its sidecar,
Ring-1 gated from day one. Comment mode's pick → prompt → dispatch loop
reuses the browser's isolated-world mechanics against the served view;
dispatch appends an `annotate` `PatchOp` through whatever satisfies
§Comment tee's blocking dependency. Presence rides the same Awareness-style
channel the whiteboard plan already specs (`AGENT_GATEWAY_DESIGN.md` §7),
Ring 1. *Exit criterion:* a human drops a pin, it lands as a chain change
with real authorship, the bee sees it on its own next read, resolving it
updates the pin live — zero prose round-trip through a transcript message.

C3 is **blocked**, not merely sequenced after C2, on the foundation-side
annotate verb; C2 ships independently and is real value alone (dogfooding
already proves "look at your board without leaving the toolchain" is the more
urgent gap).

## Non-goals (Phase C)

- No component importer work — that's PRD Phase C's own line item, separate
  doc, separate team motion (engine + importer, not apiary).
- No Product design-system inheritance UI — see §Product design systems;
  SPEC-level semantics don't exist yet.
- No multi-user/cross-machine board sync inside the pane. Chain exchange is
  content-addressed file union (`SPEC.md` §13a(iv)) and is Foundation's
  concern; the pane reads whatever chain state is locally present.
- No resolution-tracking UI beyond the annotation's own `status` field
  (`open`/`resolved`/`wontfix`, `types.ts:119`) — no reply threads, no Forum
  packet integration in v1 (mirrors browser comment mode's own non-goal:
  "Resolution tracking... needs a reply-correlation story... Design
  separately," `browser-comment-mode.md` §Non-goals).
- No compiled/packaged `foundation` binary work in this doc — `~/.local/bin/foundation`
  existing (or not) on a given machine is a prerequisite this epic depends on,
  not a deliverable of it.

## Open questions (for Tormod)

1. **The state-tab DOM-scrape** (§Host architecture) is a real v1 wart — is a
   foundation-side `inspect --json` (state names, viewports, annotation
   count) worth requesting before C2 starts, or fine to ship scraped and
   replace later?
2. **Comment tee dependency timing.** Start C3 once Foundation *commits* to
   an `annotate` verb shape (tee and CLI land together, risk of churn), or
   wait for it to ship and integrate after (risk: C3 idles)?
3. **`~/.local/bin/foundation` provisioning.** Nothing installs it there
   automatically today (`gatewayRegistry.ts`'s own fallback warns exactly
   this) — does foundationHost's missing-binary state just point at packaging
   docs, or does Apiary offer to run an install step itself (Mirror's
   System-Settings deep-link precedent)?
4. **Is C2's diff view worth shipping against `SemanticOp[]` directly**, or
   should it wait for `SPEC.md` §6's diff schema — itself still a skeleton —
   to stabilize first?
