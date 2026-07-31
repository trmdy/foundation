# Foundation

A methodology and technology for agent-first HTML design iteration: a closed-by-schema
HTML subset, a chain-of-changes truth model, first-class components, deterministic
rendering, and a canonical text projection that freezes into repos.

- **Spec:** [docs/SPEC.md](docs/SPEC.md) — the four one-way doors and the grammar skeleton
- **PRD:** [docs/PRD.md](docs/PRD.md) — the bet, the layers, the delivery plan

## Status

Pre-L1. Current work is the three de-risking spikes:

| Spike | Question | Where |
|---|---|---|
| Chain | Loro vs Automerge 3 as the change-DAG substrate (decided by the concurrency gauntlet) | [spikes/chain](spikes/chain) |
| Grammar | Does the proposed subset survive re-drawing real design boards? | [boards](boards) |
| Render | Are bit-identical cross-machine renders achievable, or is the honest contract layout-identical + pixel-tolerance? | [spikes/render](spikes/render) |

## Development

```
pnpm install
pnpm typecheck
pnpm test          # gauntlet + harness tests
pnpm spike:chain   # run the full chain gauntlet, writes spikes/chain/RESULTS.md
pnpm spike:render  # render determinism check, writes spikes/render/RESULTS.md
```
