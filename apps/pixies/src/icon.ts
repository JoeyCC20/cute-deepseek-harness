/**
 * Deterministic tray-icon PNG generation. No assets on disk: the menu-bar
 * image is drawn and encoded at runtime so a source checkout stays complete.
 * @module @deepseek-ai/dsh-pixies-app/icon
 */

import { deflateSync } from 'node:zlib'

const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function crc32(bytes: Uint8Array): number {
  let crc = 0xffff_ffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) === 1 ? 0xedb8_8320 : 0)
    }
  }
  return (crc ^ 0xffff_ffff) >>> 0
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0)
  const output = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    output.set(part, offset)
    offset += part.byteLength
  }
  return output
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const length = new Uint8Array(4)
  new DataView(length.buffer).setUint32(0, data.byteLength)
  const typeBytes = new TextEncoder().encode(type)
  const body = concat([typeBytes, data])
  const crc = new Uint8Array(4)
  new DataView(crc.buffer).setUint32(0, crc32(body))
  return concat([length, typeBytes, data, crc])
}

/** Encode an RGBA pixel grid as a PNG byte array. */
export function pngFromRgba(width: number, height: number, pixels: Uint8Array): Uint8Array {
  if (width < 1 || height < 1 || !Number.isInteger(width) || !Number.isInteger(height)) {
    throw new Error(`pixies icon: invalid dimensions ${String(width)}x${String(height)}`)
  }
  if (pixels.byteLength !== width * height * 4) {
    throw new Error(`pixies icon: pixel buffer must hold ${String(width * height * 4)} bytes`)
  }
  const stride = width * 4
  const raw = new Uint8Array(height * (stride + 1))
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0 // filter: none
    raw.set(pixels.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1)
  }
  const header = new Uint8Array(13)
  const view = new DataView(header.buffer)
  view.setUint32(0, width)
  view.setUint32(4, height)
  header[8] = 8 // bit depth
  header[9] = 6 // color type RGBA
  return concat([PNG_SIGNATURE, chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', new Uint8Array(0))])
}

const SPIDER_RED: readonly [number, number, number] = [220, 30, 45]

/**
 * Draw the Pixies menu-bar dot: a filled circle, transparent outside.
 * @param size - icon edge length in pixels (a macOS menu-bar icon is 16-18px).
 * @param padding - empty border in pixels inside the square.
 * @returns a PNG byte array for the tray image.
 */
export function spiderDotIcon(size = 16, padding = 3): Uint8Array {
  const radius = (size - padding * 2) / 2
  const center = (size - 1) / 2
  const pixels = new Uint8Array(size * size * 4)
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = x - center
      const dy = y - center
      const offset = (y * size + x) * 4
      if (dx * dx + dy * dy <= radius * radius) {
        pixels[offset] = SPIDER_RED[0]
        pixels[offset + 1] = SPIDER_RED[1]
        pixels[offset + 2] = SPIDER_RED[2]
        pixels[offset + 3] = 255
      }
    }
  }
  return pngFromRgba(size, size, pixels)
}

/** Supersampling factor for the anti-aliased mask icon. */
const MASK_SAMPLES = 4

/** Whether one 100×100 mask-space point belongs to the solid mask silhouette. */
function maskSolid(x: number, y: number): boolean {
  // A tapered head: narrower at the crown, wider at the jaw.
  const radiusX = 25 + 13 * (y / 100)
  const dx = (x - 50) / radiusX
  const dy = (y - 52) / 44
  if (dx * dx + dy * dy > 1) return false
  // Two swept eyes are cut out of the silhouette. macOS template images use
  // only the alpha channel, so transparency (not white) draws the eyes.
  for (const side of [-1, 1] as const) {
    const ex = (x - (50 + side * 15)) / 10.5
    const ey = (y - 44 + side * (x - 50) * 0.22) / 13
    if (ex * ex + ey * ey <= 1) return false
  }
  return true
}

/**
 * Draw an anti-aliased Spider-Man mask as a macOS menu-bar template image.
 * Every opaque pixel is black; the shell marks the native image as a template
 * so macOS light/dark menu bars recolor it. Eyes stay transparent.
 * @param size - icon edge length in pixels (16-18 px for the menu bar).
 * @returns a PNG byte array for the tray image.
 */
export function spiderMaskIcon(size = 16): Uint8Array {
  const pixels = new Uint8Array(size * size * 4)
  const samplesSquared = MASK_SAMPLES * MASK_SAMPLES
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let covered = 0
      for (let sy = 0; sy < MASK_SAMPLES; sy += 1) {
        for (let sx = 0; sx < MASK_SAMPLES; sx += 1) {
          const px = ((x + (sx + 0.5) / MASK_SAMPLES) / size) * 100
          const py = ((y + (sy + 0.5) / MASK_SAMPLES) / size) * 100
          if (maskSolid(px, py)) covered += 1
        }
      }
      const offset = (y * size + x) * 4
      pixels[offset + 3] = Math.round((covered / samplesSquared) * 255)
    }
  }
  return pngFromRgba(size, size, pixels)
}
