# Chain spike — Loro vs Automerge 3

Decides SPEC.md D2's library choice. Both adapters implement `src/contract.ts`
(fixed — findings, not interface changes, when a library can't express something).

## Protocol

**Gauntlet (the decider).** Three offline authors fork from a common base, apply
conflicting operations, then merge all-pairs until convergence. Scenarios:

- **G1 move-vs-move**: two authors move the same node under different parents.
- **G2 edit-inside-moved-subtree**: author A moves a subtree while author B edits a
  node inside it.
- **G3 delete-vs-edit**: author A deletes a subtree while author B edits inside it.
- **G4 reorder-vs-insert**: author A reorders siblings while author B inserts among them.
- **G5 move-cycle**: A moves X under Y while B moves Y under X (the classic cycle case).

**Disqualifiers** (any occurrence fails the library): duplicated nodes, cycles /
invalid tree, silently lost edits (an edit neither applied nor deterministically
superseded), divergent state across converged peers.

**Secondaries.**
- **S1 perf**: 10k sequential changes incl. 1k subtree moves — append latency,
  save/load time, memory, bytes on disk.
- **S2 semantic diff**: anchor at N points; lift library diff output to `SemanticOp[]`.
  Record how much adapter code this took — diff ergonomics is a scored criterion.
- **S3 undo**: inverse-append undo, including undo of a move and undo after a merge.
- **S4 metadata**: author/message roundtrip through save/load and merge.

## Outputs

`pnpm spike:chain` runs everything and writes `RESULTS.md`: per-scenario verdict per
library, disqualifier hits, perf table, adapter LOC/complexity notes, and a
recommendation block left empty — the recommendation is written by a human (or the
gating agent) after reading, not auto-generated.

A gauntlet scenario failing is a *result to record*, not a test failure: vitest
asserts harness correctness (invariant checkers, adapter contract conformance on
non-conflicting ops); the gauntlet runner records library behavior.
