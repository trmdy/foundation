# Foundation — Product Requirements Document

**Version:** 0.2 · **Date:** 2026-07-30 · **Author:** Tormod / Ur Solutions
**Status:** Draft · **Supersedes:** Veft PRD v0.1 (2026-04-10)
**Companion:** `SPEC.md` (L0 specification skeleton) — the spec is the product; this PRD
is its delivery plan.

---

## 0. Lineage

Veft v0.1 proposed an agent-first HTML design canvas as a standalone app: Axum server,
GrapesJS document engine, own preview frontend, own annotation system, own chat pane,
Playwright screenshots. Between April and July, Apiary absorbed most of that surface
area: a CDP-driven Browser pane with batch comment mode (selector-anchored, framework-
resolved to component + source line), an agent gateway with generic registration
(`~/.hive/gateways/`), AgentRun panes, and Pollinate routing. An adversarial review of
the Veft concept against that reality killed, in order: the standalone app, the
renderer-as-product, the service/daemon, and the bespoke annotation system.

What survived the review, expanded, is this: Foundation is not an app. It is a
**methodology and technology** — a format, an engine, and a protocol for agent-first
HTML design iteration — on which apps are then built, ours and others'.

## 1. Vision

Bring web and app design into the age of agents: design as a live, addressable,
diffable, mergeable document type that agents and humans author *as peers*, that
renders deterministically anywhere, and whose frozen form lives in the repo next to
the code it describes.

Foundation is enormously opinionated about: the allowed HTML/CSS subset and how it
renders; the verbs of manipulation; document truth and storage; tokens, params, and
conditional UI; multiplayer and local-first sync; sealed use of external component and
icon libraries; and human–agent collaboration. The opinions are codified in `SPEC.md`
as four one-way doors (closed HTML subset · chain-of-changes truth · first-class
components with an importing compiler · canonical text projection) plus trailing decisions that may evolve.

The name is the thesis: hive foundation is the embossed wax sheet that constrains
where comb can be built. Substrate, not tool.

## 2. Problem

1. **Agents design blind.** Parameterized design documents exist in the house today
   (`.dc.html` boards) but nothing local expands their states; an agent iterating on
   one sees whichever single state it happens to open, and has no way to ask "what
   changed visually?"
2. **Renders aren't comparable.** Ad-hoc screenshots from different bees, machines, and
   browser builds cannot be diffed. Without a pinned render contract, visual diffing —
   the core of agent self-correction and design QA — is noise.
3. **Open CSS is agent-hostile.** Ambiguous layout, non-local cascade, magic numbers:
   agent edits to freeform HTML/CSS are unreliable and their diffs are unreviewable.
4. **Design truth has no home.** Figma-class tools own truth in a cloud scene graph
   (translation loss, no repo story, no agent-native access). The house alternative —
   throwaway `drafts/*/server.mjs` loops and a manual screenshot-QA ritual — is the
   pain that started this document.
5. **Design and code can't see each other.** Components live in repos; designs live
   elsewhere. Nothing ties a design to the component it describes, or reviews them
   together.

## 3. The bet

A **closed format with a deterministic engine** beats a better editor. If design
documents are constrained enough to validate, render, and diff mechanically, then:
agents become reliable design authors; review becomes evidence ("state 3 shifted 4px,
one new token violation") instead of opinion; multiplayer falls out of the truth model
instead of being a feature; and the repo becomes the design archive via freeze. The
editor — everyone else's moat — becomes a replaceable surface on top.

## 4. Layers and products

| Layer | What | Ships as |
|---|---|---|
| **L0** | The spec: subset grammar, chain semantics, embed contract, projection/freeze, render + diff contracts, verbs, conformance suite | `SPEC.md` + fixtures, versioned, public |
| **L1** | The engine: one TypeScript library — parse, validate, materialize, project, render (pinned), diff, chain ops, component importer (sidecar toolchain) | `@foundation/engine` + `foundation` CLI (thin wrapper) |
| **L2** | The protocol: chain sync + the agent verb set | MCP server via gateway registration (`~/.hive/gateways/foundation.json`) — every bee on every node gets the verbs with no Apiary in the loop; CLI parity for non-MCP use |
| **L3** | Surfaces | **Foundation-in-Apiary** first (below); **Foundation App** — our answer to Figma — later, and deliberately so |

**Foundation-in-Apiary** (first real surface): a specialized pane/rail surface — not a
browser pane — for working on Foundation documents. Agent-first with minimal
human-ready manipulation tools; comment-mode / send-to-agent exactly like the browser
pane, but writing annotations into the document chain (durable, syncing, resolvable —
the lifecycle apiary's comment mode explicitly scoped out). Documents sync over the
Apiary org/workspace to all nodes via Foundation's own chain exchange (Apiary hosts a
transport and the library index, syn-style), grouped per
**Product** and per **Bee**: Product-level design system documents (tokens, components,
named styles) that member documents inherit, so agents working inside a Product change
and create styles against a governed system, trivially.

**Foundation App**: the standalone collaborative design application. Explicitly later;
it has no authority over L0 until the first two consumers (CLI, Apiary surface) have
shipped and shaped the spec.

**Freeze / crystallization** (strategic centerpiece): `foundation freeze` emits the
canonical projection + lock header into a repo — frozen design files living next to the
source components they describe, reviewed in the same PR, re-hydratable on demand, and
diffable against the component's later evolution. Combined with embed ingestion
(code→design) this is the bidirectional loop Figma structurally cannot close.

## 5. Delivery

**Phase A — Spec + engine core (L0 + L1, ~weeks 1–4).**
Grammar, validator, chain (post spike: Loro vs Automerge 3), projection/ingestion,
pinned render, structural+visual+conformance diff. CLI: `new · inspect · patch ·
render · diff · anchor · serve · freeze`. `serve` replaces every `drafts/*/server.mjs`
with one portless-named live-reload server with the annotation overlay.
Exit: the falsifiable tests in §6.1–6.3 pass headless, no Apiary installed.

**Phase B — Protocol + house integration (L2, ~weeks 5–7).**
Gateway registration; verb set over MCP; apiary browser comment-mode tee (comment batch
on a Foundation-served page → chain annotations); Pollinate route: annotation → bee
dispatch with document context; nightly design-QA bee over the open explorations;
nectar/Forum: diff reports attached to review packets.

**Phase C — The Apiary surface (L3a, ~weeks 8–12).**
The dedicated surface (new RailKind + pane, per the nine-step motion in the codebase),
Product/Bee document grouping over peer sync, Product design-system documents,
component importer v1 (React first, transparent-first with sealed-capsule fallback;
ShadCN as the acceptance suite; icons via the same contract).

**Phase D — Foundation App (L3b).** Not scheduled. Earns a PRD of its own once A–C
have proven the format.

**Deferred, explicitly valued — the export engine.** One canonical projection compiled
one-way into framework idioms: Tailwind, StyleX, JSX/React, Svelte, vanilla CSS. One
truth, N derived outputs is a large part of the format's eventual leverage (and the
StyleX target makes Foundation output land natively in Apiary's own codebase). A story
for after Phase C; noted so nothing in L0 accidentally forecloses it.

## 6. Success criteria (falsifiable)

1. **Matrix-aware agents:** an agent with no Apiary running renders every declared
   state × viewport of a document deterministically and receives a structural + visual +
   conformance diff between any two anchors.
2. **Nightly QA:** a cron bee answers "which open documents changed visually this week,
   and do any violate the Product design system?" unattended, every night.
3. **Determinism:** identical projection + render config on two different machines
   produce bit-identical layout reports and pixel-identical renders.
4. **Freeze-in-PR:** a frozen design file lands in a repo PR beside its component; a
   later component change surfaces a meaningful design diff in review.
5. **Closed loop:** human comments on a served document in Apiary → annotations enter
   the chain → a bee (routed via Pollinate) patches the document → pins resolve, with
   authorship on every change.
6. **Peer test:** a competent outsider can build an F-core-conformant tool from
   `SPEC.md` + fixtures without reading our engine source.

## 7. Non-goals

- A visual editor of any kind before Phase D. The manual escape hatch is text: edit the
  projection (D4 ingestion makes that safe), in any editor, including Apiary's.
- General web publishing. Foundation renders design documents; it is not a site
  generator, CMS, or app framework.
- Stateful/interactive app prototyping. Imported components are presentational by
  compiler-enforced construction; logic lives in real code.
- Adopting or extending `.dc.html` — that is claude.ai/design's format; we need our own
  (see §9). A one-way importer is an open question, not a commitment.
- A daemon, database, or cloud service in Phases A–C. Local-first files and chains;
  "easy cloud if you will" is a relay for chain sync later, not a truth store, ever.

## 8. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| **Platform trap** — spec calcifies before real use | Fatal | Two named consumers (CLI, Apiary surface) ship with the spec; the App has no design authority until then; nothing enters L0 that A–C don't need |
| **Subset too tight** → constant escape-hatch pressure | Adoption death | The embed contract *is* the pressure valve; subset grows only via spec versions driven by real blocked explorations |
| **Subset too loose** → determinism/diff guarantees erode | Product death | Conformance fixtures gate every grammar addition; "can two implementations disagree?" is the admission test |
| Import determinism is hard (SSR nondeterminism, CSS-in-JS runtimes) | Blocks pillar 8 | React-only v1; ShadCN as acceptance suite; banned-API compile errors; no fidelity gate — lossy-but-total normalization via exact canonical rewrite rules with a loss report; sealed capsule only for the unrepresentable; worst case imports ship sealed-only first — the native component model stands alone |
| Chain growth / CRDT choice regret | Perf, storage | One comparative spike week (Loro vs Automerge 3) before L1; the change-envelope layer keeps hashes and metadata Foundation-owned, so the engine can migrate by replay |
| Freeze adopted before spec stabilizes → frozen files stranded | Trust | Freeze is gated behind spec 1.0; frozen files are forever valid under their locked spec version |
| One person, three products (spec, engine, surfaces) | Schedule | Phases are strictly serial; Phase D unscheduled; agents do the breadth work (fixtures, importers, acceptance suites) |

## 9. Alternatives considered and rejected

1. **Status quo plus** — HTML files + git + Apiary browser/comment mode (the
   adversarial-review position). Rejected: cannot expand state matrices, cannot render
   comparably, cannot diff rendered states, cannot merge concurrent authors, and its
   review state dies with the steering message. It remains the substrate Foundation
   projects onto — and the bar every phase must beat.
2. **Adopt `.dc.html`.** Rejected: it is claude.ai/design's format — externally
   governed, no closed subset, no chain semantics, no embed contract, no render
   contract. Foundation needs its own format with some JS support (sealed, per D3);
   riding another product's format forfeits every one-way door.
3. **GrapesJS/JSON scene graph** (Veft v0.1). Rejected: proprietary truth invisible to
   git and agents, Node-sidecar document engine as a load-bearing dependency, and the
   visual editor it bought is now explicitly Phase D.
4. **Figma plugin.** Rejected: builds on rented, cloud-owned truth with no repo story;
   agent access forever mediated by their API surface and pricing.
5. **Extend Apiary's whiteboard/tldraw.** Rejected: vector sketching, not HTML truth;
   export needs a mounted window; and by Apiary's own tenet #3 (mirrors, never owns
   tool truth) design truth must live in a tool — Foundation is that tool.
6. **Build it inside Apiary.** Rejected: couples the format to an Electron app's
   lifecycle, breaks headless/cron/CI use, and violates the independence stance —
   others must be able to build their own solutions on this system.

## 10. Open questions

Inherited from `SPEC.md` (chain tech, subset boundary, embed interactivity budget,
extension naming, `.dc.html` importer, spec governance), plus product-level:

1. ~~Repo/home and licensing~~ — **resolved 2026-07-31**: MIT (LICENSE in repo);
   home is `trmdy/foundation` in the new honeybee area; npm packages land under a
   honeybee org scope when that org is created. Product name "Foundation" noted as
   colliding with Zurb Foundation in the web-design space — accepted; package names
   will disambiguate.
2. Does Foundation-in-Apiary earn its RailKind at Phase C, or start as a served page in
   the browser sidecar until the surface proves it isn't "the Browser pane in different
   clothes"? (Portal test — current lean: start in the sidecar, promote on evidence.)
3. Product-level design systems: inheritance semantics when a Product system and a
   document disagree (lean: system wins, document override is a visible conformance
   delta, never silent).
4. Embed compiler scope for Svelte/Next after React v1 — demand-driven, not scheduled.

---

*Living document. The spec (`SPEC.md`) is authoritative for anything they disagree on.*
