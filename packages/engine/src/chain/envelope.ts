/**
 * The Foundation change envelope (SPEC D2 + resolved open question 1).
 *
 * Loro has no concept of "author" distinct from a numeric peer id, and no
 * change metadata beyond a single `message` string — so every Loro commit
 * packs a JSON-encoded envelope `{author, message, specVersion, prevHash}`
 * into that string (same trick spikes/chain/src/loro.ts used for
 * `{author, message}`). `prevHash` is baked into the commit at authoring
 * time — like a git commit's parent field — so it is immutable history, not
 * something recomputed fresh each read. That is what makes verify()
 * meaningful: corrupting an old change's content changes what that change's
 * bytes hash to, which breaks the (already-recorded) prevHash pointer that a
 * later change bakes in.
 *
 * Hash method (exact bytes hashed): SHA-256 over five parts, NUL-separated
 * to avoid field-concatenation ambiguity:
 *   (prevHash ?? "genesis") + "\0" + author + "\0" + message + "\0"
 *   + specVersion + "\0" + <commit's exported update bytes>
 * The "commit's exported update bytes" are obtained via
 * `doc.export({ mode: 'updates-in-range', spans: [{ id: {peer, counter}, len }] })`
 * for exactly that one Loro Change — see chain.ts `bytesForSpan`. The
 * (peer, counter, len) span is derived once, at commit time, from the
 * version-vector delta between immediately-before and immediately-after the
 * commit (`doc.version()` before vs. after) — this is the
 * "exportFrom/export with version vectors" the task brief asks for: version
 * vectors identify *which* ops belong to this commit, and updates-in-range
 * (keyed by that same peer/counter/len span) re-derives the identical bytes
 * later, deterministically, regardless of which peer or how much later asks.
 */

import { createHash } from 'node:crypto'

export interface PackedEnvelope {
  author: string
  message: string
  specVersion: string
  prevHash: string | null
}

export function encodeEnvelope(env: PackedEnvelope): string {
  return JSON.stringify(env)
}

/** Never throws: a corrupted/foreign message decodes to inert placeholder fields
 *  (so verify() reports it as a broken link downstream, rather than crashing). */
export function decodeEnvelope(raw: string | undefined): PackedEnvelope {
  if (raw === undefined) return { author: 'unknown', message: '', specVersion: '', prevHash: null }
  try {
    const parsed = JSON.parse(raw) as Partial<PackedEnvelope>
    return {
      author: typeof parsed.author === 'string' ? parsed.author : 'unknown',
      message: typeof parsed.message === 'string' ? parsed.message : '',
      specVersion: typeof parsed.specVersion === 'string' ? parsed.specVersion : '',
      prevHash: typeof parsed.prevHash === 'string' ? parsed.prevHash : null,
    }
  } catch {
    return { author: 'unknown', message: raw, specVersion: '', prevHash: null }
  }
}

export function computeEnvelopeHash(
  prevHash: string | null,
  author: string,
  message: string,
  specVersion: string,
  bytes: Uint8Array,
): string {
  const hash = createHash('sha256')
  hash.update(prevHash ?? 'genesis')
  hash.update('\0')
  hash.update(author)
  hash.update('\0')
  hash.update(message)
  hash.update('\0')
  hash.update(specVersion)
  hash.update('\0')
  hash.update(bytes)
  return hash.digest('hex')
}
