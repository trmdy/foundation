/**
 * foundation-importer — Stage 1/Stage 2 intermediate artifact (API.md "Wave 4
 * — component importer"). Defined HERE, independently of src/harness/ (the
 * concurrent Stage 1 build), per the task brief: Stage 2 builds against the
 * RenderArtifact TYPE, never against harness code. This file is the
 * FIXED-CONTRACT shape lifted verbatim from API.md's Stage 1 signature block.
 *
 * CONTRACT FINDING (varied, pairwise probes) — RECONCILED with Stage 1 mid-build:
 * API.md types `RenderSample.varied` as `string | undefined` — one prop name,
 * or the baseline. The prose right below it also requires "a small pairwise
 * probe set for enum×boolean pairs" for the composed-variant/interaction
 * check, which needs TWO prop names per probe sample; the given type cannot
 * express that directly. This module originally invented its own convention
 * (comma-joined, alphabetically sorted). Stage 1 (packages/importer/src/
 * harness/samples.ts) independently invented "<a>+<b>" (plus-joined, enum
 * prop first) and asserted API.md states this literally — it does not: a
 * full-text grep of API.md's Wave 4 section at the time of this note finds no
 * "<a>+<b>" or "+"-joined example anywhere in the file, so BOTH sides
 * independently guessed at an undocumented format, not just this one. Noted
 * for precision, not blame. Since Stage 1 is the actual PRODUCER of this
 * field, interaction.ts's probe detector matches what it actually emits
 * ("+"-joined) as the primary form, with the original ","-joined form kept
 * as a defensive fallback — see project/interaction.ts's pairwiseProps().
 */
import type { FdnProp } from 'foundation-engine'

export type StateVariant = 'hover' | 'focus' | 'active' | 'disabled'

export interface RenderSample {
  /** Which prop was varied from defaults for this sample; undefined = the
   *  baseline (defaults + sentinel strings). See the module-doc CONTRACT
   *  FINDING above for the pairwise-probe convention this module assumes. */
  varied?: string
  props: Record<string, unknown>
  html: string
}

export interface ClassIndexEntry {
  /** Declarations for the class used with no variant prefix. */
  base: Record<string, string>
  /** Declarations for `hover:<class>` / `focus:<class>` / … forms, when the
   *  artifact's samples actually used that prefixed form. */
  states?: Partial<Record<StateVariant, Record<string, string>>>
  /** Variant prefixes seen on this base utility that could not be resolved
   *  (e.g. `md:`, `dark:`, stacked variants) — informational; see
   *  project/style.ts for how Stage 2 treats these. */
  unsupported?: string[]
}

/**
 * CONTRACT FINDING (classIndex keying): API.md types this as
 * `Record<string, {...}>` without naming what the string key IS. Two readings
 * are plausible: (a) the literal class token as it appears in html
 * ("hover:bg-blue-500"), or (b) the base utility name with variant prefixes
 * stripped ("bg-blue-500"), with `states` holding the prefixed forms that
 * resolved and `unsupported` naming the prefixes that didn't. Reading (a)
 * cannot actually populate `states`/`unsupported` per-entry (a single literal
 * token has at most one variant, never a family of them), so this module
 * adopts reading (b) — key = base utility name, prefix-stripped — as the only
 * one the shape is internally consistent under. Stage 1 must key classIndex
 * this way for project/style.ts's resolution to work; flagged as a seam.
 */
export type ClassIndex = Record<string, ClassIndexEntry>

export interface RenderArtifact {
  name: string
  propSchema: FdnProp[]
  samples: RenderSample[]
  classIndex: ClassIndex
  /**
   * Follow-up wave ("Tailwind theme vars become Foundation tokens on
   * import"): every `var(--x)` referenced (directly or transitively) by
   * any declaration in `classIndex`, resolved against the design system's
   * compiled theme and keyed WITHOUT the leading `--` — the same
   * convention `FdnDocument.tokens` uses, so this merges into `doc.tokens`
   * verbatim. See harness/class-index.ts's `resolveThemeVars` module doc
   * for why this exists: without it, an imported component's declarations
   * reference custom properties nothing in the target document ever
   * defines, so bake/validate report zero issues but the component renders
   * unstyled (wrong color, no rounding, wrong size — whatever the
   * unresolved var() was supposed to supply).
   */
  themeVars: Record<string, string>
  /** `--name` (with the leading dashes) of every var() reference collected
   *  above that has NO resolvable theme definition (e.g. Tailwind's own
   *  `--tw-leading`/`--tw-font-weight` cascade-plumbing vars, which are SET
   *  by a utility class's own declaration, not defined in the theme) —
   *  left out of `themeVars`; reported at projection time
   *  (import-unresolved-theme-var), never treated as a failure (D1:
   *  report, never reject). */
  unresolvedThemeVars: string[]
  provenance: { source: string; contentSha256: string }
}
