import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { captureIo } from '../src/io.js'
import { runNew } from '../src/commands/new.js'
import { runRender } from '../src/commands/render.js'
import { runDiff } from '../src/commands/diff.js'

/**
 * render/ and diff/ are Wave 2 engine modules the task brief said might not
 * exist yet in this checkout, built concurrently by another agent — render.ts
 * and diff.ts dynamic-import them by a computed path and must degrade
 * gracefully either way. They landed in src/render and src/diff partway
 * through this task, so this file checks which state the checkout is
 * actually in and asserts the matching behavior, rather than hard-coding one
 * branch (see final report for the "ignore concurrent transients" note this
 * corresponds to).
 */
const __dirname = dirname(fileURLToPath(import.meta.url))
const ENGINE_SRC = join(__dirname, '..', '..', 'engine', 'src')
const renderModulePresent = existsSync(join(ENGINE_SRC, 'render', 'index.ts'))
const diffModulePresent = existsSync(join(ENGINE_SRC, 'diff', 'index.ts'))

describe('render command', () => {
  it(
    renderModulePresent
      ? 'renders the skeleton document to PNG + layout JSON when the render module is present'
      : 'prints "render module not available yet" and exits 2 when the render module is absent',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'fdn-cli-render-'))
      const target = join(dir, 'board')
      await runNew([target], captureIo())
      const file = `${target}.fdn.html`
      const outDir = join(dir, 'out')

      const io = captureIo()
      const code = await runRender([file, '-o', outDir], io)

      if (renderModulePresent) {
        expect(code).toBe(0)
        const written = readdirSync(outDir)
        expect(written.some((f) => f.endsWith('.png'))).toBe(true)
        expect(written.some((f) => f.endsWith('.layout.json'))).toBe(true)
      } else {
        expect(code).toBe(2)
        expect(io.err.some((l) => l.includes('render module not available yet'))).toBe(true)
      }

      rmSync(dir, { recursive: true, force: true })
    },
    30000,
  )

  it('missing file argument is a usage error regardless of module availability', async () => {
    const io = captureIo()
    expect(await runRender([], io)).toBe(2)
    expect(io.err.some((l) => l.includes('usage'))).toBe(true)
  })
})

describe('diff command', () => {
  it('always reports the structural (canonical-text) comparison', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fdn-cli-diff-struct-'))
    const targetA = join(dir, 'a')
    const targetB = join(dir, 'b')
    await runNew([targetA], captureIo())
    await runNew([targetB], captureIo())

    const io = captureIo()
    const code = await runDiff([`${targetA}.fdn.html`, `${targetB}.fdn.html`], io)
    expect(code).toBe(0)
    expect(io.out.some((l) => l.startsWith('structural:'))).toBe(true)
    // different names -> different `title`/param default -> not identical
    expect(io.out.some((l) => l.includes('line(s) added'))).toBe(true)

    rmSync(dir, { recursive: true, force: true })
  })

  it('identical files report an identical structural projection', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fdn-cli-diff-identical-'))
    const target = join(dir, 'same')
    await runNew([target], captureIo())
    const file = `${target}.fdn.html`

    const io = captureIo()
    const code = await runDiff([file, file], io)
    expect(code).toBe(0)
    expect(io.out.some((l) => l.includes('canonical projections are identical'))).toBe(true)

    rmSync(dir, { recursive: true, force: true })
  })

  it(
    renderModulePresent && diffModulePresent
      ? 'also reports a visual diff (per state/viewport cell) when render+diff are present'
      : 'notes visual diff is unavailable when render/diff are absent',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'fdn-cli-diff-visual-'))
      const target = join(dir, 'same')
      await runNew([target], captureIo())
      const file = `${target}.fdn.html`

      const io = captureIo()
      const code = await runDiff([file, file], io)
      expect(code).toBe(0)

      if (renderModulePresent && diffModulePresent) {
        expect(io.out.some((l) => l.startsWith('visual:'))).toBe(true)
        expect(io.out.some((l) => l.includes('identical'))).toBe(true)
      } else {
        expect(io.out.some((l) => l.includes('not available yet'))).toBe(true)
      }

      rmSync(dir, { recursive: true, force: true })
    },
    30000,
  )

  it('missing arguments is a usage error', async () => {
    const io = captureIo()
    expect(await runDiff(['only-one.fdn.html'], io)).toBe(2)
  })
})
