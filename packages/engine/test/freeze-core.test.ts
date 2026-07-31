import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createChain } from '../src/chain/index.js'
import { freezeDocument, thawFrozen, verifyFrozen } from '../src/freeze/index.js'
import { parseDocument } from '../src/parse/index.js'
import { baseDocument } from './chain-fixtures.js'
import type { ChangeMeta } from '../src/types.js'

const boardsDir = fileURLToPath(new URL('../../../boards/', import.meta.url))

const OPTS = { author: 'user:tormod', engineVersion: '0.1.0' }

describe('freeze / verify / thaw (SPEC D4 + §7)', () => {
  it('freeze -> verify: ok, and the header carries back exactly what was passed in', () => {
    const doc = baseDocument()
    const frozen = freezeDocument(doc, { ...OPTS, message: 'first freeze', chainHead: 'deadbeef' })
    const result = verifyFrozen(frozen)
    expect(result.ok).toBe(true)
    expect(result.header).toEqual({
      spec: doc.specVersion,
      engine: '0.1.0',
      docSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      chainHead: 'deadbeef',
      frozenBy: 'user:tormod',
      message: 'first freeze',
    })
  })

  it('freeze with no chain records chain-head as "none" (chainHead: null)', () => {
    const doc = baseDocument()
    const frozen = freezeDocument(doc, { ...OPTS, chainHead: null })
    const result = verifyFrozen(frozen)
    expect(result.ok).toBe(true)
    expect(result.header?.chainHead).toBe('none')
  })

  it('freeze with chainHead omitted also defaults to "none"', () => {
    const doc = baseDocument()
    const frozen = freezeDocument(doc, OPTS)
    expect(verifyFrozen(frozen).header?.chainHead).toBe('none')
  })

  it('freeze with a real chain head records that envelope hash', () => {
    const doc = baseDocument()
    const meta: ChangeMeta = { author: 'user:tormod', message: 'seed' }
    const chain = createChain(doc, meta)
    const head = chain.head()
    const frozen = freezeDocument(chain.doc(), { ...OPTS, chainHead: head.hash })
    const result = verifyFrozen(frozen)
    expect(result.ok).toBe(true)
    expect(result.header?.chainHead).toBe(head.hash)
  })

  it('the header is exactly one fixed-format comment line on line 1', () => {
    const doc = baseDocument()
    const frozen = freezeDocument(doc, { ...OPTS, message: 'hello world', chainHead: null })
    const headerLine = frozen.split('\n')[0] ?? ''
    expect(headerLine).toMatch(
      /^<!-- fdn-frozen spec=\S+ engine=\S+ doc-sha256=[0-9a-f]{64} chain-head=none frozen-by=\S+ message=hello%20world -->$/,
    )
    // exactly one comment line: the rest of the file is the canonical projection.
    expect(frozen.slice(headerLine.length + 1)).toBe(frozen.split('\n').slice(1).join('\n'))
  })

  it('a single-byte tamper anywhere in the body breaks verification with a reason', () => {
    const doc = baseDocument()
    const frozen = freezeDocument(doc, { ...OPTS, chainHead: null })
    const idx = frozen.indexOf('\n') + 5 // a few bytes into the body, past the header line
    const original = frozen[idx]
    const replacement = original === 'A' ? 'B' : 'A'
    const tampered = frozen.slice(0, idx) + replacement + frozen.slice(idx + 1)
    const result = verifyFrozen(tampered)
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/doc-sha256 mismatch/)
    // header itself is untouched and still parses (mismatch is reported, not swallowed)
    expect(result.header?.docSha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('verifyFrozen never throws on garbage/empty input', () => {
    for (const garbage of ['', 'not a frozen file\njust text', '<!-- fdn-frozen totally wrong -->\nbody']) {
      expect(() => verifyFrozen(garbage)).not.toThrow()
      expect(verifyFrozen(garbage).ok).toBe(false)
    }
  })

  it('a message with spaces (and other reserved chars) round-trips exactly through uri-encoding', () => {
    const doc = baseDocument()
    const message = 'freeze for PR #42: layout + a/b test, "final" v2'
    const frozen = freezeDocument(doc, { ...OPTS, message, chainHead: null })
    // encoded on the wire: no literal spaces inside the header line.
    const headerLine = frozen.split('\n')[0] as string
    expect(headerLine.includes(' final')).toBe(false)
    expect(headerLine).toContain(encodeURIComponent(message))
    const result = verifyFrozen(frozen)
    expect(result.ok).toBe(true)
    expect(result.header?.message).toBe(message)
  })

  it('an empty message round-trips to the empty string', () => {
    const doc = baseDocument()
    const frozen = freezeDocument(doc, { ...OPTS, chainHead: null })
    expect(verifyFrozen(frozen).header?.message).toBe('')
  })

  it('thaw(freeze(doc)) is parse-equal to the original document (real board fixture)', () => {
    const html = readFileSync(`${boardsDir}system-help-center.fdn.html`, 'utf8')
    const { doc } = parseDocument(html)
    const frozen = freezeDocument(doc, { ...OPTS, chainHead: null })
    const { doc: thawed, header } = thawFrozen(frozen)
    expect(thawed).toStrictEqual(doc)
    expect(header.spec).toBe(doc.specVersion)
  })

  it('re-freezing a thawed hand-built fixture stabilizes after one round-trip', () => {
    // baseDocument() (chain-fixtures.ts) is a hand-built FdnDocument, not
    // something that came out of parseDocument — it uses CSS shorthand
    // (`padding: 16px`) in a namedStyle, which parse/'s normalization step
    // expands to longhand. That's a NORMALIZATION difference (parse-time),
    // not a projection non-determinism: project(doc) is byte-deterministic
    // for a GIVEN doc, but thaw() runs the body back through parseDocument,
    // so thaw(freeze(doc)) only equals doc when doc was already canonical
    // (exactly the caveat fixpoint.test.ts documents by only exercising real
    // board fixtures for the strict doc0 === doc1 assertion). What DOES hold
    // for any doc, hand-built or not: once thawed once, the result is
    // canonical, and a second freeze/thaw round-trip is then byte-stable.
    const doc = baseDocument()
    const frozen = freezeDocument(doc, { ...OPTS, message: 'm', chainHead: 'abc123' })
    const { doc: thawed } = thawFrozen(frozen)
    const refrozen1 = freezeDocument(thawed, { ...OPTS, message: 'm', chainHead: 'abc123' })
    const { doc: thawedAgain } = thawFrozen(refrozen1)
    const refrozen2 = freezeDocument(thawedAgain, { ...OPTS, message: 'm', chainHead: 'abc123' })
    expect(refrozen2).toBe(refrozen1)
  })

  it('thawFrozen throws on a structurally malformed header', () => {
    expect(() => thawFrozen('not a header at all\n<html></html>\n')).toThrow()
    expect(() => thawFrozen('no newline at all')).toThrow()
  })

  it('thawFrozen does not require doc-sha256 to match — hand-edited frozen files are legal ingestion (D4)', () => {
    const doc = baseDocument()
    const frozen = freezeDocument(doc, { ...OPTS, chainHead: null })
    const idx = frozen.lastIndexOf('</html>')
    // insert a harmless comment right before the closing tag: still valid,
    // parseable HTML, but the body byte-for-byte no longer matches doc-sha256.
    const tampered = `${frozen.slice(0, idx)}<!-- hand-edited after freeze -->\n${frozen.slice(idx)}`
    expect(verifyFrozen(tampered).ok).toBe(false)
    expect(() => thawFrozen(tampered)).not.toThrow()
  })
})
