/**
 * Hand-built RenderArtifact fixtures for Stage 2 tests — built directly
 * against the RenderArtifact TYPE (packages/importer/src/types.ts), never
 * against src/harness/ (the concurrently-built Stage 1), per the task brief.
 */
import type { FdnProp } from 'foundation-engine'
import type { ClassIndex, RenderArtifact, RenderSample } from '../src/types.js'

export function artifact(overrides: Partial<RenderArtifact> & { name: string; samples: RenderSample[] }): RenderArtifact {
  return {
    propSchema: [],
    classIndex: {},
    themeVars: {},
    unresolvedThemeVars: [],
    provenance: { source: 'fixtures/test.tsx', contentSha256: 'deadbeef' },
    ...overrides,
  }
}

export function prop(name: string, type: FdnProp['type'], extra: Partial<FdnProp> = {}): FdnProp {
  return { name, type, ...extra }
}

export function classIndex(entries: ClassIndex): ClassIndex {
  return entries
}
