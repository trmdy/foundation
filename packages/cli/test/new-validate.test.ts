import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { captureIo } from '../src/io.js'
import { runNew } from '../src/commands/new.js'
import { runValidate } from '../src/commands/validate.js'
import { runInspect } from '../src/commands/inspect.js'

describe('foundation new -> validate roundtrip', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fdn-cli-new-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('writes a skeleton that parses, validates clean, and exits 0', async () => {
    const target = join(dir, 'my-board')
    const io = captureIo()

    const newCode = await runNew([target], io)
    expect(newCode).toBe(0)
    expect(existsSync(`${target}.fdn.html`)).toBe(true)
    expect(io.out.some((l) => l.includes('wrote'))).toBe(true)

    const validateIo = captureIo()
    const validateCode = await runValidate([`${target}.fdn.html`], validateIo)
    expect(validateCode).toBe(0)
    expect(validateIo.out.some((l) => l.includes('no issues'))).toBe(true)
  })

  it('the skeleton has one param, one state, one component, and a tokens block', async () => {
    const target = join(dir, 'another-board')
    await runNew([target], captureIo())
    const text = readFileSync(`${target}.fdn.html`, 'utf8')
    expect(text).toContain('<fdn-param ')
    expect(text).toContain('<fdn-state ')
    expect(text).toContain('<fdn-component ')
    expect(text).toContain(':root {')

    const inspectIo = captureIo()
    const code = await runInspect([`${target}.fdn.html`], inspectIo)
    expect(code).toBe(0)
    expect(inspectIo.out.some((l) => l === 'params: 1')).toBe(true)
    expect(inspectIo.out.some((l) => l === 'states: 1')).toBe(true)
    expect(inspectIo.out.some((l) => l === 'components: 1')).toBe(true)
    expect(inspectIo.out.some((l) => l === 'valid: true')).toBe(true)
  })

  it('refuses to overwrite an existing file (usage error, exit 2)', async () => {
    const target = join(dir, 'dup-board')
    expect(await runNew([target], captureIo())).toBe(0)
    const io = captureIo()
    const code = await runNew([target], io)
    expect(code).toBe(2)
    expect(io.err.some((l) => l.includes('refusing to overwrite'))).toBe(true)
  })

  it('missing name argument is a usage error (exit 2)', async () => {
    const io = captureIo()
    const code = await runNew([], io)
    expect(code).toBe(2)
    expect(io.err.some((l) => l.includes('usage'))).toBe(true)
  })
})
