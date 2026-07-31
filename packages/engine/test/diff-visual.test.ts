import { describe, expect, it } from 'vitest'
import { PNG } from 'pngjs'
import { visualDiff } from '../src/diff/index.js'

function solidPng(width: number, height: number, rgba: [number, number, number, number]): Uint8Array {
  const png = new PNG({ width, height })
  for (let i = 0; i < width * height; i++) {
    const idx = i * 4
    png.data[idx] = rgba[0]
    png.data[idx + 1] = rgba[1]
    png.data[idx + 2] = rgba[2]
    png.data[idx + 3] = rgba[3]
  }
  return PNG.sync.write(png)
}

function withOnePixel(
  width: number,
  height: number,
  base: [number, number, number, number],
  at: { x: number; y: number },
  changed: [number, number, number, number],
): Uint8Array {
  const png = new PNG({ width, height })
  for (let i = 0; i < width * height; i++) {
    const idx = i * 4
    png.data[idx] = base[0]
    png.data[idx + 1] = base[1]
    png.data[idx + 2] = base[2]
    png.data[idx + 3] = base[3]
  }
  const changedIdx = (at.y * width + at.x) * 4
  png.data[changedIdx] = changed[0]
  png.data[changedIdx + 1] = changed[1]
  png.data[changedIdx + 2] = changed[2]
  png.data[changedIdx + 3] = changed[3]
  return PNG.sync.write(png)
}

describe('diff: visualDiff', () => {
  it('identical images -> identical true, diffPixels 0, no diff png', () => {
    const a = solidPng(4, 4, [255, 0, 0, 255])
    const b = solidPng(4, 4, [255, 0, 0, 255])

    expect(visualDiff(a, b)).toEqual({ identical: true, diffPixels: 0, width: 4, height: 4, diffPng: null })
  })

  it('a single differing pixel -> identical false, diffPixels 1, diff png present', () => {
    const a = solidPng(6, 6, [10, 10, 10, 255])
    const b = withOnePixel(6, 6, [10, 10, 10, 255], { x: 3, y: 2 }, [250, 10, 10, 255])

    const result = visualDiff(a, b)

    expect(result.identical).toBe(false)
    expect(result.diffPixels).toBe(1)
    expect(result.width).toBe(6)
    expect(result.height).toBe(6)
    expect(result.diffPng).not.toBeNull()
  })

  it('dimension mismatch -> identical false, diffPixels is the full pixel area of a, no diff png', () => {
    const a = solidPng(2, 2, [0, 0, 0, 255])
    const b = solidPng(3, 3, [0, 0, 0, 255])

    expect(visualDiff(a, b)).toEqual({ identical: false, diffPixels: 4, width: 2, height: 2, diffPng: null })
  })

  it('is symmetric on dimension mismatch about which argument is "a"', () => {
    const a = solidPng(3, 3, [0, 0, 0, 255])
    const b = solidPng(2, 2, [0, 0, 0, 255])

    expect(visualDiff(a, b)).toEqual({ identical: false, diffPixels: 9, width: 3, height: 3, diffPng: null })
  })
})
