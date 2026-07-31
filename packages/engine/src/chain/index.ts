/**
 * Public surface of the chain module (packages/engine/src/chain/).
 * See API.md for the fixed signatures and chain.ts for the implementation
 * notes (container layout, envelope hash method, contract findings).
 */
export { createChain, loadChain, type FdnChain } from './chain.js'
// Wave 3 (SPEC 13a-iv, API.md "chain exchange") — blob-directory exchange +
// two-chain merge. See exchange.ts module doc for the OverlapReport heuristic.
export { exportBlobs, importBlobs, mergeChains, type OverlapReport } from './exchange.js'
