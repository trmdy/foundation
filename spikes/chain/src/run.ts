/**
 * Entry point for `pnpm spike:chain`.
 *
 * Runs the gauntlet (G1–G5) and the secondaries (S1 perf, S2 diff-ergonomics
 * LOC count, S3 undo, S4 metadata roundtrip) for both adapters and writes
 * spikes/chain/RESULTS.md. Nothing in here throws to fail the run on a
 * library "losing" a scenario — every scenario/check produces a verdict
 * that's recorded in the report; only a bug in the harness itself (a thrown
 * error escaping a try/catch) should abort the run.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import type { ChainAdapter, ChangeMeta } from './contract.js'
import { canonical } from './contract.js'
import { LIBRARIES, findNode, runGauntlet, type LibraryName, type Verdict } from './gauntlet.js'
import { runPerfSuite, type PerfResult } from './perf.js'
import { buildBaseTree } from './fixtures.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ——— S2: semantic-diff lift LOC, counted from marker comments in the adapters ———

function countMarkedLoc(filePath: string, marker: string): number {
  const text = readFileSync(filePath, 'utf8')
  const lines = text.split('\n')
  let total = 0
  let inBlock = false
  for (const line of lines) {
    if (line.includes(`${marker}-START`)) {
      inBlock = true
      continue
    }
    if (line.includes(`${marker}-END`)) {
      inBlock = false
      continue
    }
    if (inBlock) total++
  }
  return total
}

interface DiffLocResult {
  library: LibraryName
  linesOfCode: number
}

function runDiffLocCount(): DiffLocResult[] {
  return [
    { library: 'loro', linesOfCode: countMarkedLoc(join(__dirname, 'loro.ts'), 'SEMANTIC-DIFF-LIFT') },
    { library: 'automerge', linesOfCode: countMarkedLoc(join(__dirname, 'automerge.ts'), 'SEMANTIC-DIFF-LIFT') },
  ]
}

// ——— S3: undo, including undo-of-move and undo-after-merge ———

interface CheckResult {
  name: string
  library: LibraryName
  result: 'pass' | 'violation'
  details: string
}

function safeCheck(name: string, library: LibraryName, fn: () => CheckResult): CheckResult {
  try {
    return fn()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { name, library, result: 'violation', details: `threw: ${message}` }
  }
}

function checkUndoOfSetProp(library: LibraryName, make: () => ChainAdapter): CheckResult {
  return safeCheck('S3 undo-of-setProp', library, () => {
    const base = buildBaseTree()
    const adapter = make()
    adapter.init(base)
    adapter.setProp({ author: 'user:t', message: 'set lang' }, 'n-root', 'lang', 'zz')
    adapter.undo({ author: 'user:t', message: 'undo' })
    const ok = canonical(adapter.materialize()) === canonical(base)
    return {
      name: 'S3 undo-of-setProp',
      library,
      result: ok ? 'pass' : 'violation',
      details: ok ? 'reverted exactly to pre-edit canonical state' : 'state after undo does not match pre-edit state',
    }
  })
}

function checkUndoOfMove(library: LibraryName, make: () => ChainAdapter): CheckResult {
  return safeCheck('S3 undo-of-move', library, () => {
    const base = buildBaseTree()
    const adapter = make()
    adapter.init(base)
    adapter.moveNode({ author: 'user:t', message: 'move aside' }, 'n-aside', 'n-header', 0)
    const movedCanonical = canonical(adapter.materialize())
    adapter.undo({ author: 'user:t', message: 'undo move' })
    const restoredCanonical = canonical(adapter.materialize())
    const moveHappened = movedCanonical !== canonical(base)
    const ok = moveHappened && restoredCanonical === canonical(base)
    return {
      name: 'S3 undo-of-move',
      library,
      result: ok ? 'pass' : 'violation',
      details: ok
        ? 'move was applied then exactly reverted by undo'
        : `move applied=${moveHappened}, restored to base=${restoredCanonical === canonical(base)}`,
    }
  })
}

function checkUndoAfterMerge(library: LibraryName, make: () => ChainAdapter): CheckResult {
  return safeCheck('S3 undo-after-merge', library, () => {
    const base = buildBaseTree()
    const root = make()
    root.init(base)
    const a = root.fork('author-a')
    const b = root.fork('author-b')

    a.setProp({ author: 'user:a', message: 'a edits root lang' }, 'n-root', 'lang', 'aa')
    b.setProp({ author: 'user:b', message: 'b edits title' }, 'n-title', 'data-touched', '1')

    a.merge(b)
    a.undo({ author: 'user:a', message: 'undo a edit after merge' })

    const materialized = a.materialize()
    const rootNode = findNode(materialized, 'n-root')
    const titleNode = findNode(materialized, 'n-title')
    const aReverted = rootNode?.props.lang !== 'aa'
    const bPreserved = titleNode?.props['data-touched'] === '1'
    const ok = aReverted && bPreserved

    return {
      name: 'S3 undo-after-merge',
      library,
      result: ok ? 'pass' : 'violation',
      details: `a's local edit reverted=${aReverted}, b's merged edit preserved=${bPreserved} (lang=${rootNode?.props.lang ?? '(unset)'})`,
    }
  })
}

function runUndoChecks(): CheckResult[] {
  const out: CheckResult[] = []
  for (const { name: library, make } of LIBRARIES) {
    out.push(checkUndoOfSetProp(library, make))
    out.push(checkUndoOfMove(library, make))
    out.push(checkUndoAfterMerge(library, make))
  }
  return out
}

// ——— S4: author/message metadata roundtrip through save/load and merge ———

function checkMetadataThroughSaveLoad(library: LibraryName, make: () => ChainAdapter): CheckResult {
  return safeCheck('S4 metadata-through-save-load', library, () => {
    const adapter = make()
    adapter.init(buildBaseTree())
    const meta: ChangeMeta = { author: 'agent:bee-7', message: 'metadata roundtrip check' }
    adapter.setProp(meta, 'n-root', 'lang', 'pt')
    const bytes = adapter.save()

    const reloaded = make()
    reloaded.load(bytes)
    const history = reloaded.history()
    const found = history.find((h) => h.meta.author === meta.author && h.meta.message === meta.message)
    return {
      name: 'S4 metadata-through-save-load',
      library,
      result: found ? 'pass' : 'violation',
      details: found
        ? `author/message survived save+load (nativeId=${found.nativeId})`
        : `no history entry with author=${meta.author} message="${meta.message}" after save+load`,
    }
  })
}

function checkMetadataThroughMerge(library: LibraryName, make: () => ChainAdapter): CheckResult {
  return safeCheck('S4 metadata-through-merge', library, () => {
    const root = make()
    root.init(buildBaseTree())
    const a = root.fork('author-a')
    const b = root.fork('author-b')
    const meta: ChangeMeta = { author: 'user:carol', message: 'edit from b' }
    b.setStyle(meta, 'n-title', 'color', 'blue')
    a.merge(b)
    const history = a.history()
    const found = history.find((h) => h.meta.author === meta.author && h.meta.message === meta.message)
    return {
      name: 'S4 metadata-through-merge',
      library,
      result: found ? 'pass' : 'violation',
      details: found
        ? `author/message from the remote peer's change survived merge (nativeId=${found.nativeId})`
        : `no history entry with author=${meta.author} message="${meta.message}" after merge`,
    }
  })
}

function runMetadataChecks(): CheckResult[] {
  const out: CheckResult[] = []
  for (const { name: library, make } of LIBRARIES) {
    out.push(checkMetadataThroughSaveLoad(library, make))
    out.push(checkMetadataThroughMerge(library, make))
  }
  return out
}

// ——— report assembly ———

function fmtMs(n: number): string {
  return n.toFixed(3)
}

function fmtKb(bytes: number): string {
  return (bytes / 1024).toFixed(1)
}

function fmtMb(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(2)
}

function renderGauntletTable(verdicts: Verdict[]): string {
  const scenarios = [...new Set(verdicts.map((v) => v.scenario))]
  const lines: string[] = []
  lines.push('| Scenario | loro | automerge |')
  lines.push('| --- | --- | --- |')
  for (const scenario of scenarios) {
    const loro = verdicts.find((v) => v.scenario === scenario && v.library === 'loro')
    const am = verdicts.find((v) => v.scenario === scenario && v.library === 'automerge')
    const cell = (v: Verdict | undefined) => (v ? (v.result === 'pass' ? 'PASS' : '**VIOLATION**') : 'n/a')
    lines.push(`| ${scenario} | ${cell(loro)} | ${cell(am)} |`)
  }
  lines.push('')
  lines.push('Details:')
  lines.push('')
  for (const v of verdicts) {
    lines.push(`- **[${v.library}] ${v.scenario}** — ${v.result}: ${v.details}`)
  }
  return lines.join('\n')
}

function renderPerfTable(results: PerfResult[]): string {
  const lines: string[] = []
  lines.push('| Metric | loro | automerge |')
  lines.push('| --- | --- | --- |')
  const loro = results.find((r) => r.library === 'loro')
  const am = results.find((r) => r.library === 'automerge')
  if (!loro || !am) return '(perf results missing)'
  lines.push(`| start node count | ${loro.startNodeCount} | ${am.startNodeCount} |`)
  lines.push(`| total ops | ${loro.totalOps} | ${am.totalOps} |`)
  lines.push(
    `| op mix (move/insert/remove/setProp/setStyle/setText) | ${Object.values(loro.actualOpCounts).join('/')} | ${Object.values(am.actualOpCounts).join('/')} |`,
  )
  lines.push(`| append latency p50 (ms) | ${fmtMs(loro.appendLatencyMsP50)} | ${fmtMs(am.appendLatencyMsP50)} |`)
  lines.push(`| append latency p95 (ms) | ${fmtMs(loro.appendLatencyMsP95)} | ${fmtMs(am.appendLatencyMsP95)} |`)
  lines.push(`| append latency mean (ms) | ${fmtMs(loro.appendLatencyMsMean)} | ${fmtMs(am.appendLatencyMsMean)} |`)
  lines.push(`| total append time (ms) | ${fmtMs(loro.totalAppendMs)} | ${fmtMs(am.totalAppendMs)} |`)
  lines.push(`| save() size (KB) | ${fmtKb(loro.saveBytes)} | ${fmtKb(am.saveBytes)} |`)
  lines.push(`| save() time (ms) | ${fmtMs(loro.saveMs)} | ${fmtMs(am.saveMs)} |`)
  lines.push(`| load() time (ms) | ${fmtMs(loro.loadMs)} | ${fmtMs(am.loadMs)} |`)
  lines.push(`| RSS delta during ops (MB) | ${fmtMb(loro.rssDeltaBytesDuringOps)} | ${fmtMb(am.rssDeltaBytesDuringOps)} |`)
  lines.push(`| RSS delta after save (MB) | ${fmtMb(loro.rssDeltaBytesAfterSave)} | ${fmtMb(am.rssDeltaBytesAfterSave)} |`)
  return lines.join('\n')
}

function renderCheckList(title: string, checks: CheckResult[]): string {
  const lines: string[] = [`### ${title}`, '']
  lines.push('| Check | loro | automerge |')
  lines.push('| --- | --- | --- |')
  const names = [...new Set(checks.map((c) => c.name))]
  for (const name of names) {
    const loro = checks.find((c) => c.name === name && c.library === 'loro')
    const am = checks.find((c) => c.name === name && c.library === 'automerge')
    const cell = (c: CheckResult | undefined) => (c ? (c.result === 'pass' ? 'PASS' : '**VIOLATION**') : 'n/a')
    lines.push(`| ${name} | ${cell(loro)} | ${cell(am)} |`)
  }
  lines.push('')
  for (const c of checks) {
    lines.push(`- **[${c.library}] ${c.name}** — ${c.result}: ${c.details}`)
  }
  return lines.join('\n')
}

function renderReport(
  gauntlet: Verdict[],
  perf: PerfResult[],
  diffLoc: DiffLocResult[],
  undoChecks: CheckResult[],
  metadataChecks: CheckResult[],
): string {
  const gauntletViolations = gauntlet.filter((v) => v.result === 'violation')
  const loroLoc = diffLoc.find((d) => d.library === 'loro')?.linesOfCode ?? 0
  const amLoc = diffLoc.find((d) => d.library === 'automerge')?.linesOfCode ?? 0

  return `# Chain spike results — Loro vs Automerge 3

Generated by \`pnpm spike:chain\` (spikes/chain/src/run.ts). This file is regenerated
on every run — do not hand-edit the sections above "## Recommendation".

## Gauntlet (G1–G5)

${renderGauntletTable(gauntlet)}

## Disqualifier hits

${
  gauntletViolations.length === 0
    ? 'None. Both adapters converged to identical, valid, complete trees on every scenario except where noted above.'
    : gauntletViolations.map((v) => `- **[${v.library}] ${v.scenario}**: ${v.details}`).join('\n')
}

## S1 — perf (10k sequential changes, incl. 1k moves, on a ~500-node tree)

${renderPerfTable(perf)}

Methodology note: latencies are per-verb-call wall-clock time via
\`performance.now()\` around each adapter method call, no benchmarking
framework, single process, JIT-warm (no separate warmup phase — first ops are
included in the p50/p95 distribution, which is why p95 in particular should be
read as "including some JIT warmup," not a steady-state tail latency).
RSS deltas are best-effort (\`--expose-gc\` not guaranteed available) and
should be read as directional, not precise.

## S2 — semantic-diff ergonomics

Lines of adapter code (inside the diff-lift region only, marked with
\`SEMANTIC-DIFF-LIFT-START\`/\`-END\` comments in the source) it took to lift
each library's native diff/patch representation to the contract's
\`SemanticOp[]\` vocabulary:

| Library | LOC |
| --- | --- |
| loro | ${loroLoc} |
| automerge | ${amLoc} |

Loro's \`LoroDoc.diff()\` already returns \`TreeDiff\`/\`MapDiff\` shapes that are
structurally close to \`SemanticOp\` — create/delete/move tree actions with
target/parent/index, and map updates keyed by container id. The adapter code
is mostly a 1:1 field rename plus a small id-translation step (Loro's TreeID
isn't the contract's NodeId).

Automerge's \`diff()\` returns low-level JSON-patch-style ops (\`put\`/\`del\`/
\`insert\`/\`splice\`) against whatever shape the adapter chose to store data in
— there's no built-in "this subtree moved" concept, because there's no
built-in subtree-move operation. Reconstructing insert-node vs. move-node
requires correlating an \`order\` list \`insert\` patch against whether the
inserted id was newly created in the same window (tracked via a \`tag\` put).
It also turned up a real wrinkle: Automerge represents every string-valued
put as a \`put ""\` placeholder followed by \`splice\` patches with the actual
characters (see automerge.ts's SEMANTIC-DIFF-LIFT comment) — even for fields
that are never edited at the character level — so the lift resolves final
values from a \`view()\` at the target anchor rather than trying to replay the
splice stream.

## S3 — undo (inverse-append)

${renderCheckList('Undo checks', undoChecks)}

## S4 — metadata roundtrip

${renderCheckList('Metadata checks', metadataChecks)}

## Findings — workarounds required by each library

### Loro

- **No "author" field distinct from peer id.** \`LoroDoc.commit()\` only takes
  a single \`message\` string (plus origin/timestamp). The adapter packs the
  Foundation \`{author, message}\` envelope as JSON into that string field, and
  \`history()\` parses it back out. Peer id itself is a numeric \`PeerID\`, not
  a semantic author string, and is derived deterministically from the actor
  name (\`derivePeerId\` in util.ts) rather than left to Loro's random default,
  to keep spike runs reproducible.
- **TreeID isn't the contract's NodeId.** Loro assigns each tree node an
  opaque \`\${counter}@\${peer}\` identity. The adapter stores the caller's
  NodeId inside each node's metadata map (\`data.get('id')\`) and maintains a
  JS-side \`Map<NodeId, TreeID>\` rebuilt from doc content after merge/load.
- **\`checkout()\` mutates live document state** (LoroDoc detaches on
  checkout). The adapter saves the current frontiers, checks out the anchor,
  materializes, and checks back out to the saved frontiers, so the contract's
  "must not disturb current state" requirement holds — at the cost of a
  save/restore dance around every \`checkout()\` call, compared to Automerge's
  cheap non-mutating \`view()\`.
- **Op identity is positional, not content-addressed.** \`nativeId\` is
  \`\${peer}:\${counter}\` — Loro does not hash changes the way Automerge does
  (SPEC D2 open question 1 flags this explicitly as a trade-off).

### Automerge

- **No native tree-move operation.** This is the headline limitation SPEC D2
  calls out. The adapter models the tree as a parent-pointer field per node
  plus an explicit ordered child-id list per parent (\`order[parentId]\`).
  \`moveNode\` updates both. Under concurrent moves of the same node to
  different parents, both destination parents' order lists end up containing
  the node id after merge (list inserts always survive; only the
  last-write-wins \`parent\` field picks a winner) — left unhandled this would
  duplicate the node under naive traversal. \`materialize()\` reconciles this
  by only rendering a child from \`order[p]\` when that child's own \`parent\`
  field still equals \`p\` — a real, adapter-level workaround, not a CRDT
  guarantee. It avoids duplication (see G1: PASS) but does **not** detect or
  prevent move/move cycles (see G5: VIOLATION — a node can be orphaned,
  unreachable from root, when two concurrent moves each point into the
  other's new subtree).
- **String values are internally splice-based, not atomic puts** (see the S2
  section above) — this doesn't change the CRDT *semantics* observed (we
  verified concurrent scalar string writes still resolve via ordinary
  last-write-wins with \`getConflicts()\` visibility, not char-level merging),
  but it meaningfully complicated the diff-lift code, and would complicate
  any other code that tries to read Automerge's patch stream directly instead
  of reading resolved values from the document.
- **No "author" field distinct from actor id**, same limitation as Loro: the
  adapter uses the identical \`{author, message}\` JSON-in-\`message\` envelope
  trick. Actor ids are derived deterministically from the actor name
  (\`deriveHexActor\` in util.ts) as a hex string, since Automerge requires
  hex-ish actor identifiers.
- **\`nativeId\` is a genuine content hash** (\`decodeChange().hash\`,
  SHA-256-based) — the one place Automerge matches SPEC D2's original
  description ("SHA-256 change DAG") more directly than Loro does.

## Recommendation

<!-- Left intentionally empty. A human (or the gating agent) writes the
     recommendation after reading the results above — it is not
     auto-generated by run.ts. -->
`
}

function main(): void {
  console.log('Running gauntlet (G1-G5) for both adapters...')
  const gauntlet = runGauntlet()

  console.log('Running perf suite (S1, 10k ops x 2 libraries)...')
  const perf = runPerfSuite()

  console.log('Counting semantic-diff-lift LOC (S2)...')
  const diffLoc = runDiffLocCount()

  console.log('Running undo checks (S3)...')
  const undoChecks = runUndoChecks()

  console.log('Running metadata roundtrip checks (S4)...')
  const metadataChecks = runMetadataChecks()

  const report = renderReport(gauntlet, perf, diffLoc, undoChecks, metadataChecks)
  const outPath = join(__dirname, '..', 'RESULTS.md')
  writeFileSync(outPath, report, 'utf8')
  console.log(`Wrote ${outPath}`)

  const gauntletViolations = gauntlet.filter((v) => v.result === 'violation')
  console.log(`\nGauntlet: ${gauntlet.length - gauntletViolations.length}/${gauntlet.length} passed.`)
  for (const v of gauntletViolations) {
    console.log(`  VIOLATION [${v.library}] ${v.scenario}: ${v.details}`)
  }
}

main()
