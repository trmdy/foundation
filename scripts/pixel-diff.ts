#!/usr/bin/env -S tsx
/**
 * pixel-diff.ts — thin CLI over foundation-engine's diff/index.ts visualDiff
 * for scripts/design-qa.sh. `foundation diff` (packages/cli/src/commands/
 * diff.ts) takes two *documents* and re-renders both internally; the nightly
 * QA script already has yesterday's and today's PNGs on disk and just wants
 * a pixel count between two known files, so this calls the engine's pure,
 * synchronous visualDiff(a, b) directly instead of re-rendering.
 *
 * usage: tsx scripts/pixel-diff.ts <a.png> <b.png>
 * prints one line of JSON: { identical, diffPixels, width, height }
 * exit 0 always when both files read and parse as PNGs (a diff, even a
 * large one, is not a script failure); exit 2 on usage/read error.
 */
import { readFileSync } from 'node:fs'
import { visualDiff } from '../packages/engine/src/diff/index.js'

const [, , aPath, bPath] = process.argv

if (!aPath || !bPath) {
  console.error('usage: tsx scripts/pixel-diff.ts <a.png> <b.png>')
  process.exit(2)
}

let a: Buffer
let b: Buffer
try {
  a = readFileSync(aPath)
  b = readFileSync(bPath)
} catch (err) {
  console.error(`could not read input file(s): ${err instanceof Error ? err.message : String(err)}`)
  process.exit(2)
}

try {
  const result = visualDiff(a, b)
  // diffPng bytes are dropped from stdout — design-qa.sh only needs the
  // pixel count, and any real diff (not just two different matrix states
  // being compared by mistake) can be MB-scale of JSON otherwise.
  const { diffPng: _diffPng, ...summary } = result
  console.log(JSON.stringify(summary))
} catch (err) {
  console.error(`visualDiff failed: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(2)
}
