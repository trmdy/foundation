# Git integration (Wave 3, SPEC 13a-iv)

Foundation's truth is a hash-linked chain of changes (D2), not the `.fdn.html`
text — so a plain textual `git merge` is the wrong tool for both file types
this repo produces: `<file>.chain` is a binary Loro snapshot (a byte-level
merge is meaningless), and `<file>.fdn.html` is a *projection* of whichever
chain state won, not independently mergeable content. `foundation
git-merge-driver` teaches git to call into the real merge logic
(`mergeChains`, SPEC 13a-iv) for both instead of doing its own diff3.

## Setup

1. **`.gitattributes`** — mark both file shapes for the custom driver:

   ```gitattributes
   *.fdn.html.chain merge=foundation
   *.fdn.html       merge=foundation
   ```

   (Or scope more narrowly, e.g. `boards/*.fdn.html.chain merge=foundation`,
   if only some directories are chain-tracked.)

2. **`git config`** — register the driver command. Per-repo:

   ```sh
   git config merge.foundation.name "Foundation chain-aware merge"
   git config merge.foundation.driver "foundation git-merge-driver %O %A %B"
   ```

   `%O`/`%A`/`%B` are git's own placeholders for the common-ancestor,
   "ours", and "theirs" temp files (gitattributes(5)) — git substitutes real
   paths before invoking the command. `foundation` must be on `PATH` (or use
   an absolute path to `packages/cli/src/main.ts` via the repo's runtime).

With that in place, `git merge`, `git rebase`, `git cherry-pick`, etc. call
`foundation git-merge-driver <ancestor> <ours> <theirs>` for every path that
matches, instead of git's built-in text/binary merge.

## What the driver guarantees per file type

### `<file>.fdn.html.chain` (the binary snapshot)

Calls `mergeChains(oursBytes, theirsBytes)` — a real two-chain CRDT merge
(SPEC 13a-iv), not a byte-level diff. **Guarantee:** the result is a valid
merged chain containing the full causal history of both sides; concurrent
property-level writes are resolved by Loro's last-write-wins-per-key
semantics (deterministic, not "pick one side arbitrarily per file"), and any
detected `concurrent-overlap` lines are printed to stderr as a review signal
— they are **not** blocking; the merge still completes and git sees no
conflict markers for this path. If the merge itself throws (e.g. one side
isn't a valid chain snapshot), the driver logs the error and leaves "ours"
untouched — still exit 0, so this never blocks a merge outright.

The ancestor (`%O`) argument is accepted for protocol compliance but **not
used** — Loro chains carry their own causal history, so `mergeChains` doesn't
need an externally-supplied ancestor the way a text three-way merge does.

### `<file>.fdn.html` (the projected text)

There are two paths, and only one of them is a real merge:

- **If a sibling `<ours-path>.chain` file exists on disk** (literally
  `${A}.chain` next to whatever path git handed the driver for `%A`), the
  driver loads it and overwrites `%A` with `projectDocument()` of that
  chain's merged document (re-stamping `data-fdn-doc-id`, since the id lives
  outside `FdnDocument` — see `packages/cli/src/docid.ts`). This is the
  "real" outcome, but it depends on that sibling chain already reflecting
  the merged truth (e.g. because the `.chain` driver ran first, or because
  something ran `foundation chain merge` beforehand and left the merged
  chain there).
- **Otherwise: structural fallback.** There is **no three-way text merge
  implemented.** The driver keeps "ours" completely unchanged and prints a
  loud warning to stderr. Exit code is still 0 — git will NOT show conflict
  markers, it will just silently keep whatever "ours" already was.

**Why the fallback is the realistic common case, honestly:** git invokes
merge drivers with three *temporary* files for `%O`/`%A`/`%B` — none of them
is guaranteed to be, or be named like, the real repository path (see
gitattributes(5)). That means the driver generally has no reliable way to
locate the *real* `<file>.fdn.html.chain` from a `%A` argument alone, so
"sibling chain exists" will rarely fire in a genuine `git merge` invocation
today. It's implemented anyway (useful when this command is invoked directly
with real paths, e.g. for manual conflict resolution, and forward-compatible
with a future git config that passes `%P` — the real repo-relative path —
as a fourth argument), but **do not rely on it** for unattended git merges
yet. The safe, honest recommendation until a real structural (or `%P`-aware)
merge exists:

```sh
# resolve the .chain first, for real, then let the .fdn.html driver invocation
# pick up the sibling (or just regenerate the text yourself):
foundation chain merge <file> <path-to-theirs.chain>
```

or resolve `<file>.fdn.html` by hand when the fallback fires (the stderr
warning tells you exactly that happened).

## Also see

- `packages/cli/src/commands/chain.ts` — `chain push|pull|sync <file> <dir>`
  (blob-directory exchange) and `chain merge <file> <theirs.chain>` (the
  non-git entry point to the same `mergeChains` logic, plus text
  regeneration — this is what the driver's "sibling chain" path assumes has
  already run).
- `packages/cli/src/commands/git-merge-driver.ts` — the implementation.
- `packages/engine/src/chain/exchange.ts` — `mergeChains`/`exportBlobs`/
  `importBlobs` and the `concurrent-overlap` heuristic's exact rules.
