import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { captureIo } from '../src/io.js'
import { runCli } from '../src/main.js'
import { runValidate } from '../src/commands/validate.js'
import { runInspect } from '../src/commands/inspect.js'

describe('CLI exit codes', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fdn-cli-exit-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('no command prints usage and exits 2', async () => {
    const io = captureIo()
    expect(await runCli([], io)).toBe(2)
    expect(io.out.join('\n')).toContain('usage: foundation')
  })

  it('--help prints usage and exits 0', async () => {
    const io = captureIo()
    expect(await runCli(['--help'], io)).toBe(0)
  })

  it('unknown command exits 2', async () => {
    const io = captureIo()
    expect(await runCli(['bogus'], io)).toBe(2)
    expect(io.err.some((l) => l.includes('unknown command'))).toBe(true)
  })

  it('validate on a document with a genuine error exits 1', async () => {
    const file = join(dir, 'broken.fdn.html')
    // an fdn-use referencing an undeclared component is a hard validation error.
    writeFileSync(
      file,
      `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"></head>
<body>
<fdn-doc hidden data-fdn-spec-version="0.0.1-draft"></fdn-doc>
<main>
<fdn-use component="DoesNotExist"></fdn-use>
</main>
</body>
</html>
`,
      'utf8',
    )
    const io = captureIo()
    const code = await runValidate([file], io)
    expect(code).toBe(1)
    expect(io.out.some((l) => l.includes('error'))).toBe(true)
  })

  it('inspect exit code matches validation status', async () => {
    const file = join(dir, 'broken2.fdn.html')
    writeFileSync(
      file,
      `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"></head>
<body>
<fdn-doc hidden data-fdn-spec-version="0.0.1-draft"></fdn-doc>
<main>
<fdn-use component="DoesNotExist"></fdn-use>
</main>
</body>
</html>
`,
      'utf8',
    )
    const io = captureIo()
    expect(await runInspect([file], io)).toBe(1)
    expect(io.out.some((l) => l === 'valid: false')).toBe(true)
  })

  it('missing-file commands exit 2 rather than throwing', async () => {
    const missing = join(dir, 'nope.fdn.html')
    for (const cmd of ['inspect', 'validate', 'ingest', 'bake']) {
      const io = captureIo()
      const code = await runCli([cmd, missing], io)
      expect(code, `${cmd} should exit 2 on a missing file`).toBe(2)
    }
  })
})
