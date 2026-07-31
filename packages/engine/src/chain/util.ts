/**
 * Small deterministic helpers for the chain module.
 *
 * Constraint (SPEC D2 + task brief): no Date.now()/Math.random() may leak into
 * document content (timestamps, actor/peer ids, hashes). Peer ids are derived
 * deterministically from author-supplied actor strings, exactly as proven in
 * spikes/chain/src/util.ts, so replays and merges are reproducible.
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

/** Deterministic small positive integer peer id for Loro (fits comfortably in u53). */
export function derivePeerId(actor: string): number {
  const a = fnv1a(actor)
  const b = fnv1a(`${actor}:salt`)
  return a * 0x10000 + (b % 0x10000)
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
 * Deterministic JSON serialization: object keys sorted recursively, so
 * logically-identical values always produce byte-identical JSON — required
 * both for hash determinism and to let Loro's "same value = no-op" map
 * optimization actually fire on unchanged whole-object writes.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value))
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep)
  if (value !== null && typeof value === 'object') {
    const input = value as Record<string, unknown>
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(input).sort()) sorted[key] = sortKeysDeep(input[key])
    return sorted
  }
  return value
}

/** Compare two decimal-string PeerIDs numerically (they can exceed 2^53). */
export function comparePeerIds(a: string, b: string): number {
  if (a === b) return 0
  const ba = BigInt(a)
  const bb = BigInt(b)
  return ba < bb ? -1 : 1
}
