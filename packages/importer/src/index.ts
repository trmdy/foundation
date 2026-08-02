/**
 * foundation-importer — public entry point (API.md "Wave 4 — component
 * importer", Stage 1). Stage 2 (src/project/) is built concurrently against
 * the RenderArtifact shape in ./types.js directly; this barrel re-exports
 * the same types for external consumers (CLI, tests) plus harvestComponent
 * itself.
 */
export { harvestComponent } from './harness/index.js'
export type { HarvestComponentOptions } from './harness/index.js'
export { HarnessError } from './errors.js'
export type { HarnessErrorCode } from './errors.js'
export type { RenderArtifact, RenderSample, ClassIndex, ClassIndexEntry, StateVariant } from './types.js'

// Stage 2 (src/project/) — built independently against the RenderArtifact
// type above, per API.md's fixed intermediate-artifact contract.
export { projectArtifact } from './project/index.js'
export type { ProjectOptions, ProjectResult } from './project/index.js'
