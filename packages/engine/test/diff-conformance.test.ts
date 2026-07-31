import { describe, expect, it } from 'vitest'
import { conformanceDiff } from '../src/diff/index.js'
import type { ConformanceReport } from '../src/types.js'

function report(lines: ConformanceReport['lines']): ConformanceReport {
  return { lines }
}

describe('diff: conformanceDiff', () => {
  it('finds lines added in b that were not in a', () => {
    const a = report([{ code: 'off-token-value', severity: 'info', message: 'x' }])
    const b = report([
      { code: 'off-token-value', severity: 'info', message: 'x' },
      { code: 'unused-token', severity: 'info', message: 'y', nodeId: 'n1' },
    ])

    const { added, resolved } = conformanceDiff(a, b)

    expect(added).toEqual([{ code: 'unused-token', severity: 'info', message: 'y', nodeId: 'n1' }])
    expect(resolved).toEqual([])
  })

  it('finds lines resolved (present in a, gone from b)', () => {
    const a = report([{ code: 'param-missing-default', severity: 'warning', message: 'p missing', nodeId: 'n2' }])
    const b = report([])

    const { added, resolved } = conformanceDiff(a, b)

    expect(added).toEqual([])
    expect(resolved).toEqual([{ code: 'param-missing-default', severity: 'warning', message: 'p missing', nodeId: 'n2' }])
  })

  it('keys by (code, nodeId, message) — severity/detail changes alone are neither added nor resolved', () => {
    const a = report([{ code: 'off-token-value', severity: 'info', message: 'm', nodeId: 'n1', detail: { x: 1 } }])
    const b = report([{ code: 'off-token-value', severity: 'warning', message: 'm', nodeId: 'n1', detail: { x: 2 } }])

    const { added, resolved } = conformanceDiff(a, b)

    expect(added).toEqual([])
    expect(resolved).toEqual([])
  })

  it('is a multiset diff: duplicate lines cancel pairwise, not by set membership', () => {
    const a = report([
      { code: 'off-token-value', severity: 'info', message: 'm' },
      { code: 'off-token-value', severity: 'info', message: 'm' },
    ])
    const b = report([{ code: 'off-token-value', severity: 'info', message: 'm' }])

    const { added, resolved } = conformanceDiff(a, b)

    expect(added).toEqual([])
    expect(resolved).toEqual([{ code: 'off-token-value', severity: 'info', message: 'm' }])
  })

  it('empty reports on both sides diff to nothing', () => {
    const { added, resolved } = conformanceDiff(report([]), report([]))
    expect(added).toEqual([])
    expect(resolved).toEqual([])
  })

  it('distinguishes lines that share a message but differ in nodeId', () => {
    const a = report([{ code: 'off-token-value', severity: 'info', message: 'm', nodeId: 'n1' }])
    const b = report([{ code: 'off-token-value', severity: 'info', message: 'm', nodeId: 'n2' }])

    const { added, resolved } = conformanceDiff(a, b)

    expect(added).toEqual([{ code: 'off-token-value', severity: 'info', message: 'm', nodeId: 'n2' }])
    expect(resolved).toEqual([{ code: 'off-token-value', severity: 'info', message: 'm', nodeId: 'n1' }])
  })
})
