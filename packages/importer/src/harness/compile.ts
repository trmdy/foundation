/**
 * Compile step — API.md Wave 4 Stage 1, item 1:
 * "esbuild-bundle the source .tsx (jsx automatic, react external-or-bundled
 *  — your call, deterministic), resolving imports from the component's own
 *  directory/package context. No network (esbuild offline; any http import
 *  = legible error)."
 *
 * Choice made (documented): react + react-dom/server.node are BUNDLED into
 * the same output as the component (not left external). This makes the
 * artifact self-contained for the vm sandbox (harness/sandbox.ts) — one
 * script, no runtime module resolution, so the sandbox's `require` can be
 * a small allowlist of Node builtins rather than a full loader. The
 * synthetic entry ("shim") imports the target component with a RELATIVE
 * specifier from a file esbuild treats as living next to the source, so
 * esbuild's normal node_modules resolution walks up from the component's
 * OWN directory — its own package context, not this package's — exactly
 * as required. Only this shim's own `react`/`react-dom` imports resolve
 * against foundation-importer's pinned versions (documented finding: a
 * component with its own, incompatible react version in its own
 * node_modules would still render against the importer's pinned react-dom;
 * out of scope for Stage 1's own fixtures, which all live in this package).
 */
import * as esbuild from 'esbuild'
import path from 'node:path'
import { HarnessError } from '../errors.js'

export interface CompiledBundle {
  code: string
}

export async function compileComponent(
  sourcePath: string,
  exportedName: string,
  isDefaultExport: boolean,
): Promise<CompiledBundle> {
  const absSource = path.resolve(sourcePath)
  const resolveDir = path.dirname(absSource)
  const baseName = path.basename(absSource)
  const importClause = isDefaultExport
    ? `import Component from './${baseName}'`
    : `import { ${exportedName} as Component } from './${baseName}'`

  const shim = [
    `import { renderToStaticMarkup } from 'react-dom/server.node'`,
    `import { createElement } from 'react'`,
    importClause,
    `export function __render(props) {`,
    `  return renderToStaticMarkup(createElement(Component, props || {}))`,
    `}`,
    '',
  ].join('\n')

  let result: esbuild.BuildResult
  try {
    result = await esbuild.build({
      stdin: { contents: shim, resolveDir, sourcefile: 'fdn-import-shim.tsx', loader: 'tsx' },
      bundle: true,
      write: false,
      format: 'cjs',
      platform: 'node',
      target: 'es2022',
      jsx: 'automatic',
      jsxImportSource: 'react',
      define: { 'process.env.NODE_ENV': '"production"' },
      absWorkingDir: resolveDir,
      logLevel: 'silent',
      legalComments: 'none',
      sourcemap: false,
    })
  } catch (err) {
    throw new HarnessError('compile-error', describeEsbuildFailure(err), { cause: err })
  }

  const file = result.outputFiles?.[0]
  if (!file) throw new HarnessError('compile-error', 'esbuild produced no output for the component bundle')
  return { code: file.text }
}

function describeEsbuildFailure(err: unknown): string {
  const failure = err as esbuild.BuildFailure
  const texts = (failure.errors ?? []).map((e) => e.text)
  const joined = texts.length > 0 ? texts.join('; ') : String(err)
  const networked = /https?:\/\//.test(joined)
  return networked
    ? `network import is not permitted (esbuild runs offline, no network ever): ${joined}`
    : `esbuild compile failed: ${joined}`
}
