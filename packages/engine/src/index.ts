/**
 * foundation-engine — public API surface (integrator-owned wiring).
 * Modules stay import-light: render/serve pull in playwright/http lazily via
 * their own entry points; importing the root never starts a browser.
 */
export * from './types.js'
export { parseDocument } from './parse/index.js'
export { validateDocument } from './validate/index.js'
export { projectDocument } from './project/index.js'
export { bakeDocument } from './bake/index.js'
export { createChain, loadChain, mintAnnotationId } from './chain/index.js'
export type { FdnChain } from './chain/index.js'
// Wave 3 (SPEC 13a-iv, API.md "chain exchange") — additive barrel export only;
// implementation lives entirely in src/chain/ (see exchange.ts).
export { exportBlobs, importBlobs, mergeChains } from './chain/index.js'
export type { OverlapReport } from './chain/index.js'
export { freezeDocument, verifyFrozen, thawFrozen } from './freeze/index.js'
