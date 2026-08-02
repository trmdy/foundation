/**
 * Minimal structural types for the shapes returned by tailwindcss v4's
 * `DesignSystem.candidatesToAst()` / `.parseCandidate()`. The real types
 * (`AstNode`, `Variant`, `Candidate`) live in tailwindcss's `lib.d.mts` but
 * are NOT part of that module's public `export { ... }` surface, so they
 * can't be imported by name — these are hand-written subsets covering only
 * the fields class-index.ts actually reads, verified empirically against
 * tailwindcss@4.3.3's runtime output (see class-index.ts's module doc).
 */

export interface Declaration {
  kind: 'declaration'
  property: string
  value?: string
}
export interface StyleRule {
  kind: 'rule'
  selector: string
  nodes: AstNode[]
}
export interface AtRule {
  kind: 'at-rule'
  name: string
  params: string
  nodes: AstNode[]
}
export interface Comment {
  kind: 'comment'
  value: string
}
export interface ContextNode {
  kind: 'context'
  nodes: AstNode[]
}
export interface AtRootNode {
  kind: 'at-root'
  nodes: AstNode[]
}

export type AstNode = Declaration | StyleRule | AtRule | Comment | ContextNode | AtRootNode

export type Variant =
  | { kind: 'static'; root: string }
  | { kind: 'functional'; root: string; value: unknown; modifier: unknown }
  | { kind: 'compound'; root: string; modifier: unknown; variant: Variant }
  | { kind: 'arbitrary'; selector: string; relative: boolean }
