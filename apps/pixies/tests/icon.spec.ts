/**
 * Icon generator tests (test-validation method 3): the tray dot encodes as a
 * valid PNG with the expected dimensions and pixels.
 */
import { inflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { pngFromRgba, spiderDotIcon } from '../src/icon.ts'

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

function readChunks(png: Uint8Array): { type: string; data: Uint8Array }[] {
  expect([...png.slice(0, 8)]).toEqual(PNG_SIGNATURE)
  const chunks: { type: string; data: Uint8Array }[] = []
  let offset = 8
  while (offset < png.byteLength) {
    const view = new DataView(png.buffer, png.byteOffset + offset, 4)
    const length = view.getUint32(0)
    const type = new TextDecoder().decode(png.slice(offset + 4, offset + 8))
    chunks.push({ type, data: png.slice(offset + 8, offset + 8 + length) })
    offset += 12 + length
  }
  return chunks
}

/** Inflate IDAT rows into a per-pixel RGBA view (filter byte 0 only). */
function readPixels(png: Uint8Array, width: number, height: number): Uint8Array {
  const idat = readChunks(png).filter(chunk => chunk.type === 'IDAT')
  const compressed = Buffer.concat(idat.map(chunk => Buffer.from(chunk.data)))
  const raw = inflateSync(compressed)
  const stride = width * 4
  expect(raw.byteLength).toBe(height * (stride + 1))
  const pixels = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    expect(raw[y * (stride + 1)]).toBe(0) // no per-row filter
    pixels.set(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)), y * stride)
  }
  return pixels
}

function pixel(pixels: Uint8Array, width: number, x: number, y: number): number[] {
  const offset = (y * width + x) * 4
  return [
    pixels[offset] ?? 0,
    pixels[offset + 1] ?? 0,
    pixels[offset + 2] ?? 0,
    pixels[offset + 3] ?? 0,
  ]
}

describe('pngFromRgba', () => {
  it('emits a valid PNG header with the declared dimensions', () => {
    const png = pngFromRgba(2, 2, new Uint8Array(16))
    const chunks = readChunks(png)
    const ihdr = chunks.find(chunk => chunk.type === 'IHDR')
    expect(ihdr).toBeDefined()
    const view = new DataView(ihdr!.data.buffer, ihdr!.data.byteOffset, 8)
    expect(view.getUint32(0)).toBe(2)
    expect(view.getUint32(4)).toBe(2)
    expect(chunks.some(chunk => chunk.type === 'IEND')).toBe(true)
  })

  it('rejects invalid dimensions and pixel-buffer lengths', () => {
    expect(() => pngFromRgba(0, 2, new Uint8Array(16))).toThrow(/invalid dimensions/)
    expect(() => pngFromRgba(2, 2, new Uint8Array(4))).toThrow(/pixel buffer must hold/)
  })
})

describe('spiderDotIcon', () => {
  it('draws a filled red dot and transparent corners', () => {
    const size = 16
    const png = spiderDotIcon(size, 3)
    const pixels = readPixels(png, size, size)
    expect(pixel(pixels, size, 8, 8)).toEqual([220, 30, 45, 255])
    expect(pixel(pixels, size, 0, 0)).toEqual([0, 0, 0, 0])
    expect(pixel(pixels, size, 15, 15)).toEqual([0, 0, 0, 0])
  })
})
