/**
 * `foundation new <name>` — writes a minimal, valid `.fdn.html` skeleton
 * (one param, one state, one component, a tokens block — API.md CLI section)
 * so a human or agent has a legal starting document rather than a blank file.
 *
 * Also runs `chain init` on the freshly-written document by default, so new
 * documents are chain-tracked from birth rather than needing a separate
 * opt-in step — pass `--no-chain` to skip that (e.g. throwaway scratch
 * files). A chain-init failure (only realistic cause: a stray `<file>.chain`
 * already sitting next to a brand-new file) is a warning, not a hard
 * failure — the document itself was written successfully either way.
 */
import { randomUUID } from 'node:crypto'
import { existsSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'
import { projectDocument, validateDocument } from 'foundation-engine'
import type { FdnDocument, FdnNode } from 'foundation-engine'
import type { CliIO } from '../io.js'
import { flagString, parseArgs } from '../argv.js'
import { injectDocIdAttr } from '../docid.js'
import { defaultAuthor } from '../identity.js'
import { writeChainInit } from './chain.js'

function leafNode(partial: Partial<FdnNode> & Pick<FdnNode, 'id' | 'tag'>): FdnNode {
  return { attrs: {}, style: {}, styleStates: {}, children: [], ...partial }
}

// friction §7: the scaffold's one token used to be `#3366CC` — a cool blue,
// in a toolchain whose only real consumer (the boards/ fixtures) is a
// warm-accent design system, so it got deleted on every real project's first
// edit anyway. #B8860B (dark goldenrod) is a warm placeholder instead — still
// a placeholder, still meant to be replaced: a real project should declare
// its own `--color-accent` (and the rest of its palette) in the tokens
// block, this is only here so the skeleton document has SOME token to
// demonstrate `var(--color-accent)` usage with.
const SCAFFOLD_ACCENT_TOKEN = '#B8860B'

/** Exported for tests: the skeleton document a given title produces. */
export function skeletonDocument(title: string): FdnDocument {
  return {
    specVersion: '0.0.1-draft',
    title,
    tokens: { 'color-accent': SCAFFOLD_ACCENT_TOKEN },
    params: [{ name: 'title', type: 'string', default: title }],
    data: [],
    lookups: [],
    states: [{ name: 'default', assignments: {} }],
    viewports: [],
    matrix: [],
    namedStyles: [],
    components: [
      {
        name: 'Card',
        props: [{ name: 'label', type: 'string', default: 'Label' }],
        slots: [],
        body: [
          leafNode({
            id: 'card-root',
            tag: 'div',
            // Longhand only (never shorthand: padding/border-radius/margin/inset)
            // — parse/'s ingestion normalization expands shorthand to longhand,
            // so a hand-built doc using shorthand would fail the
            // parse(project(doc)) === doc fixpoint API.md requires. Writing
            // longhand here keeps the skeleton already-canonical.
            style: {
              'padding-top': '16px',
              'padding-right': '16px',
              'padding-bottom': '16px',
              'padding-left': '16px',
              'border-top-left-radius': '8px',
              'border-top-right-radius': '8px',
              'border-bottom-right-radius': '8px',
              'border-bottom-left-radius': '8px',
            },
            children: [leafNode({ id: 'card-label', tag: 'span', text: '{{ prop.label }}' })],
          }),
        ],
      },
    ],
    annotations: [],
    body: [
      leafNode({ id: 'n1', tag: 'h1', style: { color: 'var(--color-accent)' }, text: '{{ param.title }}' }),
      leafNode({ id: 'n2', tag: 'fdn-use', attrs: { component: 'Card', 'data-fdn-prop-label': 'Hello, Foundation' } }),
    ],
  }
}

/**
 * friction §7 (`--empty` / MCP `empty: true`): just the header + tokens block
 * + an empty `<main>` — no demo param/state/component that gets deleted on
 * the project's first real edit anyway. Still gets the chain-init that makes
 * `skeletonDocument` worth keeping (per the friction log: "its actual value
 * was starting the chain").
 */
export function skeletonDocumentEmpty(title: string): FdnDocument {
  return {
    specVersion: '0.0.1-draft',
    title,
    tokens: { 'color-accent': SCAFFOLD_ACCENT_TOKEN },
    params: [],
    data: [],
    lookups: [],
    states: [],
    viewports: [],
    matrix: [],
    namedStyles: [],
    components: [],
    annotations: [],
    body: [],
  }
}

function toFilePath(name: string): string {
  return name.endsWith('.fdn.html') ? name : `${name}.fdn.html`
}

function titleFromName(name: string): string {
  const base = basename(name).replace(/\.fdn\.html$/, '')
  return base
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w[0]?.toUpperCase() + w.slice(1))
    .join(' ')
}

export async function runNew(args: string[], io: CliIO): Promise<number> {
  const { positionals, flags } = parseArgs(args)
  const name = positionals[0]
  if (!name) {
    io.stderr('usage: foundation new <name> [--empty] [--no-chain] [--author A] [--message M]')
    return 2
  }

  const filePath = toFilePath(name)
  if (existsSync(filePath)) {
    io.stderr(`refusing to overwrite existing file: ${filePath}`)
    return 2
  }

  // friction §7: --empty skips the demo param/state/Card component — just
  // the header + tokens block + empty <main>, no delete-everything step.
  const doc = flags.empty ? skeletonDocumentEmpty(titleFromName(name)) : skeletonDocument(titleFromName(name))
  const check = validateDocument(doc)
  if (!check.valid) {
    io.stderr('internal error: the generated skeleton failed validation:')
    for (const issue of check.issues) io.stderr(`  ${issue.severity} ${issue.code}: ${issue.message}`)
    return 1
  }

  // SPEC 13a-i: mint the document id here (CLI/surface layer — the engine
  // stays randomness-free) and stamp it into the text at the string level
  // (see packages/cli/src/docid.ts for why: FdnDocument has no field for it).
  const docId = randomUUID()
  const text = injectDocIdAttr(projectDocument(doc), docId)
  writeFileSync(filePath, text, 'utf8')
  io.stdout(`wrote ${filePath}`)

  if (!flags['no-chain']) {
    const author = flagString(flags, 'author') ?? defaultAuthor()
    const message = flagString(flags, 'm', 'message') ?? 'init'
    const result = writeChainInit(filePath, doc, { author, message }, io, { docId })
    if (result) io.stdout(`wrote ${result.chainPath} (head ${result.head.hash.slice(0, 12)})`)
  }

  return 0
}
