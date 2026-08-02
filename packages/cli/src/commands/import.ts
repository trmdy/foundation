/**
 * `foundation import <source.tsx> --into <file.fdn.html> [--name N]
 * [--props <json>] [--sealed]` — Wave 4 Stage 3 CLI wiring over
 * packages/importer (API.md "Wave 4 — component importer" CLI section):
 * harvest (Stage 1) -> project (Stage 2, forceSealed for --sealed) -> merge
 * the resulting FdnComponent into the target document (add/replace by name)
 * -> write via the ORDINARY canonicalize path (parse/project, same as
 * `ingest`) -> chain-commit when a chain exists next to the target file.
 *
 * The importer package pulls in esbuild + react/react-dom + tailwindcss —
 * real weight, nothing else this CLI touches comes close — so it is loaded
 * lazily via a computed import specifier (same trick commands/render.ts and
 * mcp/tools.ts already use for the Wave 2 render/diff modules): every other
 * `foundation` invocation, and in particular `foundation mcp`'s stdio
 * server startup, must not pay that cost just because `import` exists as a
 * command somewhere in the binary.
 *
 * CONTRACT FINDING (node-id collisions across independently-harvested
 * components): projectArtifact mints its component body's node ids (n1,
 * n2, …) from a FRESH, isolated counter local to that one artifact (see
 * project/html.ts, which reuses parseDocument's own minter on a bare
 * fragment) — it has no visibility into the target document's existing id
 * space. A real .fdn.html document mints ids from ONE counter shared across
 * its whole body + every component (packages/engine/src/parse/index.ts,
 * `scanMaxMintedId` + one shared `IdMinter`), and `parseDocument` only
 * mints for elements LACKING `data-fdn-id` — it never renumbers ids that
 * are already present, so simply splicing a harvested component's body
 * into the target doc and reprojecting would silently leave two "n1"s (one
 * in the pre-existing content, one in the freshly imported component) that
 * parseDocument would preserve verbatim forever after. Neither
 * `scanMaxMintedId` nor `IdMinter` is exported from foundation-engine, so
 * this module carries its own small equivalent (see `remintComponentIds`
 * below) and re-numbers the harvested component's body against the target
 * document's current max id BEFORE merging — the same invariant a real
 * hand-edit would get for free from parseDocument's single shared counter.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { loadChain, parseDocument, projectDocument } from 'foundation-engine'
import type { FdnComponent, FdnDocument, FdnLookup, FdnNode, FdnProp } from 'foundation-engine'
import type { CliIO } from '../io.js'
import { flagString, parseArgs } from '../argv.js'
import { defaultAuthor } from '../identity.js'
import { injectDocIdAttr, readDocIdAttr } from '../docid.js'
import { chainPathFor } from './chain.js'

// ——— lazy foundation-importer loader (computed specifier — see module doc) ———

// Exported (not just used locally) so mcp/tools.ts's foundation_import can
// share this exact loader/merge/renumber logic instead of re-deriving it —
// same sharing pattern as chainPathFor/writeChainInit (commands/chain.js)
// and skeletonDocument (commands/new.js), which mcp/tools.ts already reaches
// into rather than duplicating.
export interface HarvestComponentOptions {
  source: string
  name?: string
  props?: FdnProp[]
}
export interface RenderArtifact {
  name: string
  propSchema: FdnProp[]
  provenance: { source: string; contentSha256: string }
}
export interface ProjectResult {
  component: FdnComponent
  mode: 'native' | 'sealed'
  report: { code: string; severity: string; message: string; nodeId?: string; detail?: unknown }[]
  extraLookups: FdnLookup[]
}
interface HarnessErrorLike extends Error {
  code: string
  detail?: unknown
}
export interface ImporterModule {
  harvestComponent: (opts: HarvestComponentOptions) => Promise<RenderArtifact>
  projectArtifact: (artifact: RenderArtifact, opts?: { forceSealed?: boolean }) => ProjectResult
}

// Not an inline string literal in the import() call on purpose: TypeScript
// would otherwise statically resolve+typecheck the target module's own
// exports against this call site, re-coupling the CLI to foundation-importer
// at compile time even though the whole point is to defer loading it (and
// everything it drags in) to the one command/tool that actually needs it.
const IMPORTER_MODULE_SPEC = 'foundation-importer'

export async function loadImporterModule(): Promise<ImporterModule> {
  return (await import(IMPORTER_MODULE_SPEC)) as unknown as ImporterModule
}

function isHarnessErrorLike(err: unknown): err is HarnessErrorLike {
  return err instanceof Error && typeof (err as { code?: unknown }).code === 'string'
}

export function formatStructuredError(stage: 'harvest' | 'project', err: unknown): string {
  if (isHarnessErrorLike(err)) {
    const detail = err.detail !== undefined ? ` ${JSON.stringify(err.detail)}` : ''
    return `${stage} failed [${err.code}]: ${err.message}${detail}`
  }
  return `${stage} failed: ${err instanceof Error ? err.message : String(err)}`
}

export function harnessErrorCode(err: unknown): string | undefined {
  return isHarnessErrorLike(err) ? err.code : undefined
}

// ——— node-id renumbering (see the module-doc CONTRACT FINDING) ———

const MINTED_ID_RE = /^n(\d+)$/

function scanMaxMintedId(nodes: FdnNode[]): number {
  let max = 0
  const walk = (list: FdnNode[]): void => {
    for (const n of list) {
      const m = MINTED_ID_RE.exec(n.id)
      if (m?.[1] !== undefined) max = Math.max(max, Number(m[1]))
      walk(n.children)
    }
  }
  walk(nodes)
  return max
}

/** Max minted id across the document, EXCLUDING `excludeComponentName`'s own
 *  body when given — that component is about to be replaced wholesale, so
 *  its current ids are about to be discarded, not kept. Excluding it is
 *  what makes re-importing the SAME component idempotent: without this, a
 *  second import of an unchanged source would scan the first import's own
 *  leftover ids as "existing", start the new counter above them, and grow
 *  the document's ids by one component's worth on every single re-import —
 *  breaking the "repeated import is byte-identical" determinism contract
 *  (API.md Wave 4 acceptance suite) for no reason other than replacing a
 *  component with an identical copy of itself. */
export function docMaxMintedId(doc: FdnDocument, excludeComponentName?: string): number {
  let max = scanMaxMintedId(doc.body)
  for (const c of doc.components) {
    if (c.name === excludeComponentName) continue
    max = Math.max(max, scanMaxMintedId(c.body))
  }
  return max
}

/** Deep-clones `nodes`, replacing every node's `data-fdn-id`-shaped id with
 *  a fresh one minted from `counter` in the same pre-order (node, then its
 *  children, left to right) parseDocument's own IdMinter uses — so the
 *  renumbered subtree is indistinguishable from one parseDocument minted
 *  itself, just continuing the target document's counter instead of
 *  starting a new one at 1. */
export function remintComponentIds(nodes: FdnNode[], counter: { n: number }): FdnNode[] {
  return nodes.map((node) => {
    counter.n += 1
    return { ...node, id: `n${counter.n}`, children: remintComponentIds(node.children, counter) }
  })
}

// ——— lookup merge (name-collision -> error with hint) ———

export function mergeLookups(existing: FdnLookup[], extra: FdnLookup[]): { lookups: FdnLookup[] } | { error: string } {
  const merged = [...existing]
  const indexByName = new Map(merged.map((l, i) => [l.name, i]))
  for (const lk of extra) {
    const idx = indexByName.get(lk.name)
    if (idx === undefined) {
      indexByName.set(lk.name, merged.length)
      merged.push(lk)
      continue
    }
    const cur = merged[idx] as FdnLookup
    if (JSON.stringify(cur.entries) !== JSON.stringify(lk.entries)) {
      return {
        error:
          `lookup name collision: "${lk.name}" is already declared in doc.lookups with different entries ` +
          `(existing: ${JSON.stringify(cur.entries)}, new: ${JSON.stringify(lk.entries)}) — the importer names ` +
          `generated lookups "<Component>Lookup<N>", so this is almost always two different components ` +
          `(or two imports of the same component under different --name overrides) colliding on the same ` +
          `generated name; re-run with a different --name, or edit/remove the existing "${lk.name}" lookup ` +
          `in the target document before re-importing.`,
      }
    }
    // identical name + identical entries: already merged (e.g. a repeated,
    // idempotent import of the same component) — nothing to do.
  }
  return { lookups: merged }
}

const USAGE = 'usage: foundation import <source.tsx> --into <file.fdn.html> [--name N] [--props <json>] [--sealed] [--author A]'

export async function runImport(args: string[], io: CliIO): Promise<number> {
  const { positionals, flags } = parseArgs(args)
  const source = positionals[0]
  const into = flagString(flags, 'into')
  if (!source || !into) {
    io.stderr(USAGE)
    return 2
  }

  const name = flagString(flags, 'name')
  const sealed = flags.sealed === true
  const propsJson = flagString(flags, 'props')

  let propsOverride: FdnProp[] | undefined
  if (propsJson !== undefined) {
    try {
      const parsed: unknown = JSON.parse(propsJson)
      if (!Array.isArray(parsed)) throw new Error('expected a JSON array of prop overrides')
      propsOverride = parsed as FdnProp[]
    } catch (err) {
      io.stderr(`foundation import: --props must be a JSON array of FdnProp objects: ${err instanceof Error ? err.message : String(err)}`)
      return 2
    }
  }

  let targetSource: string
  try {
    targetSource = readFileSync(into, 'utf8')
  } catch (err) {
    io.stderr(`could not read ${into}: ${err instanceof Error ? err.message : String(err)}`)
    return 2
  }

  const importer = await loadImporterModule()

  let artifact: RenderArtifact
  try {
    artifact = await importer.harvestComponent({
      source,
      ...(name !== undefined ? { name } : {}),
      ...(propsOverride !== undefined ? { props: propsOverride } : {}),
    })
  } catch (err) {
    io.stderr(`foundation import: ${formatStructuredError('harvest', err)}`)
    return 1
  }

  let projected: ProjectResult
  try {
    projected = importer.projectArtifact(artifact, sealed ? { forceSealed: true } : undefined)
  } catch (err) {
    io.stderr(`foundation import: ${formatStructuredError('project', err)}`)
    return 1
  }

  const { doc } = parseDocument(targetSource)

  const targetName = projected.component.name
  const existingIndex = doc.components.findIndex((c) => c.name === targetName)
  const maxId = docMaxMintedId(doc, targetName)
  const component: FdnComponent = {
    ...projected.component,
    body: remintComponentIds(projected.component.body, { n: maxId }),
  }

  const lookupResult = mergeLookups(doc.lookups, projected.extraLookups)
  if ('error' in lookupResult) {
    io.stderr(`foundation import: ${lookupResult.error}`)
    return 1
  }

  const components =
    existingIndex === -1 ? [...doc.components, component] : doc.components.map((c, i) => (i === existingIndex ? component : c))

  const nextDoc: FdnDocument = { ...doc, components, lookups: lookupResult.lookups }

  // ordinary canonicalize path (API.md: "via ordinary ingest+commit" — same
  // project -> re-stamp-doc-id -> write dance as `ingest`, see ingest.ts).
  const canonical = projectDocument(nextDoc)
  const docId = readDocIdAttr(targetSource)
  const canonicalWithDocId = docId ? injectDocIdAttr(canonical, docId) : canonical
  writeFileSync(into, canonicalWithDocId, 'utf8')

  for (const line of projected.report) {
    io.stdout(`${line.severity} ${line.code}: ${line.message}`)
  }
  io.stdout(`mode: ${projected.mode}`)
  io.stdout(`provenance: source=${artifact.provenance.source} sha256=${artifact.provenance.contentSha256}`)
  io.stdout(`${into}: ${existingIndex === -1 ? 'added' : 'replaced'} component "${component.name}" (${projected.mode})`)

  const chainPath = chainPathFor(into)
  if (existsSync(chainPath)) {
    const author = flagString(flags, 'author') ?? defaultAuthor()
    try {
      const chain = loadChain(readFileSync(chainPath), { actor: author })
      const currentCanonical = projectDocument(chain.doc())
      if (currentCanonical === canonical) {
        io.stdout(`${chainPath}: no changes to commit (parsed document matches chain head)`)
      } else {
        const message = `import ${component.name} from ${source} (${projected.mode})`
        const envelope = chain.apply({ author, message }, [{ op: 'replace-document', doc: nextDoc }])
        writeFileSync(chainPath, chain.save())
        io.stdout(`${chainPath}: committed ${envelope.hash.slice(0, 12)} (${message})`)
      }
    } catch (err) {
      io.stderr(`chain commit failed: ${err instanceof Error ? err.message : String(err)}`)
      return 2
    }
  }

  return 0
}
