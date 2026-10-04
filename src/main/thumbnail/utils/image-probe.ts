import * as fs from 'fs'

export interface ImageDimensions {
  width: number
  height: number
  format: 'png' | 'jpeg' | 'webp' | 'unknown'
}

export function probeImageDimensions(buffer: Buffer): ImageDimensions | null {
  if (!buffer || buffer.length < 24) return null

  // PNG: Signature 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    const width = buffer.readUInt32BE(16)
    const height = buffer.readUInt32BE(20)
    return { width, height, format: 'png' }
  }

  // JPEG: Starts with FF D8
  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2
    while (offset < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset++
        continue
      }
      const marker = buffer[offset + 1]

      // Start of Frame markers containing dimensions:
      // SOF0 (0xC0), SOF1 (0xC1), SOF2 (0xC2), SOF3 (0xC3),
      // SOF5 (0xC5), SOF6 (0xC6), SOF7 (0xC7), SOF9 (0xC9),
      // SOF10 (0xCA), SOF11 (0xCB), SOF13 (0xCD), SOF14 (0xCE), SOF15 (0xCF)
      if (
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf)
      ) {
        if (offset + 8 < buffer.length) {
          const height = buffer.readUInt16BE(offset + 5)
          const width = buffer.readUInt16BE(offset + 7)
          return { width, height, format: 'jpeg' }
        }
      }

      // Next marker
      if (offset + 3 < buffer.length) {
        const length = buffer.readUInt16BE(offset + 2)
        offset += 2 + length
      } else {
        break
      }
    }
  }

  // WebP: RIFF ... WEBP
  if (
    buffer.slice(0, 4).toString('ascii') === 'RIFF' &&
    buffer.slice(8, 12).toString('ascii') === 'WEBP'
  ) {
    // VP8 chunk
    if (buffer.slice(12, 16).toString('ascii') === 'VP8 ') {
      const width = buffer.readUInt16LE(26) & 0x3fff
      const height = buffer.readUInt16LE(28) & 0x3fff
      return { width, height, format: 'webp' }
    }
    // VP8L (lossless)
    if (buffer.slice(12, 16).toString('ascii') === 'VP8L') {
      const b1 = buffer[21]
      const b2 = buffer[22]
      const b3 = buffer[23]
      const b4 = buffer[24]
      const width = 1 + (((b2 & 0x3f) << 8) | b1)
      const height = 1 + (((b4 & 0xf) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6))
      return { width, height, format: 'webp' }
    }
    // VP8X (extended)
    if (buffer.slice(12, 16).toString('ascii') === 'VP8X') {
      const width = 1 + buffer.readUIntLE(24, 3)
      const height = 1 + buffer.readUIntLE(27, 3)
      return { width, height, format: 'webp' }
    }
  }

  return null
}

export function probeImageFile(filePath: string): ImageDimensions | null {
  if (!fs.existsSync(filePath)) return null
  const stat = fs.statSync(filePath)
  if (stat.size === 0) return null

  // Read first 64KB which is enough to find headers/SOF
  const fd = fs.openSync(filePath, 'r')
  const readLen = Math.min(stat.size, 65536)
  const buffer = Buffer.alloc(readLen)
  try {
    fs.readSync(fd, buffer, 0, readLen, 0)
    return probeImageDimensions(buffer)
  } finally {
    fs.closeSync(fd)
  }
}

export const probeImageFileDimensions = probeImageFile
