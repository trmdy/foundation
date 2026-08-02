import { createHash } from 'node:crypto'

/** sha256 hex digest — used for RenderArtifact.provenance.contentSha256. */
export function sha256Hex(bytes: string | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}
