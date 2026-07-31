/**
 * Small deterministic helpers shared by both adapters.
 *
 * Constraint from the spike brief: no Date.now()/Math.random() may leak into
 * document content (timestamps, actor/peer ids). Both Loro and Automerge want
 * a numeric/hex identity for the local replica; we derive it deterministically
 * from the author-supplied actor name so re-running the spike is reproducible.
 */

/** FNV-1a 32-bit hash, good enough for deterministic id derivation (not crypto). */
function fnv1a(input: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/** Deterministic small positive integer peer id for Loro (fits comfortably in u64). */
export function derivePeerId(actor: string): number {
  // Combine two hashes to widen the space a bit while staying a safe integer.
  const a = fnv1a(actor)
  const b = fnv1a(`${actor}:salt`)
  return a * 0x10000 + (b % 0x10000)
}

/** Deterministic even-length hex string for Automerge actor ids. */
export function deriveHexActor(actor: string): string {
  const a = fnv1a(actor).toString(16).padStart(8, '0')
  const b = fnv1a(`${actor}:2`).toString(16).padStart(8, '0')
  const c = fnv1a(`${actor}:3`).toString(16).padStart(8, '0')
  const d = fnv1a(`${actor}:4`).toString(16).padStart(8, '0')
  return `${a}${b}${c}${d}`
}

/** A monotonic, deterministic clock for change timestamps (never Date.now()). */
export class DeterministicClock {
  private t = 0
  next(): number {
    this.t += 1
    return this.t
  }
}

/**
 * Seeded PRNG (mulberry32) — used by perf.ts to pick which node/index to
 * operate on next. Deterministic given a fixed seed, unlike Math.random().
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function percentile(sortedAscending: number[], p: number): number {
  if (sortedAscending.length === 0) return 0
  const idx = Math.min(sortedAscending.length - 1, Math.floor((p / 100) * sortedAscending.length))
  return sortedAscending[idx] as number
}
