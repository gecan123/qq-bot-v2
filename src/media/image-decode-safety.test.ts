import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  ImageDecodeSafetyError,
  MAX_IMAGE_DECODE_DIMENSION,
  MAX_IMAGE_DECODE_PIXELS,
  readSafeImageMetadata,
} from './image-decode-safety.js'

function svg(width: number, height: number): Buffer {
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="red"/></svg>`)
}

describe('image decode safety', () => {
  test('accepts ordinary images', async () => {
    const metadata = await readSafeImageMetadata(svg(1_920, 1_080))

    assert.equal(metadata.width, 1_920)
    assert.equal(metadata.height, 1_080)
  })

  test('rejects an image whose edge exceeds the configured limit', async () => {
    await assert.rejects(
      () => readSafeImageMetadata(svg(MAX_IMAGE_DECODE_DIMENSION + 1, 100)),
      (error: unknown) => error instanceof ImageDecodeSafetyError
        && error.code === 'image_dimension_limit_exceeded',
    )
  })

  test('rejects an image whose decoded pixel count exceeds the configured limit', async () => {
    const side = Math.floor(Math.sqrt(MAX_IMAGE_DECODE_PIXELS)) + 1

    await assert.rejects(
      () => readSafeImageMetadata(svg(side, side)),
      (error: unknown) => error instanceof ImageDecodeSafetyError
        && error.code === 'image_pixel_limit_exceeded',
    )
  })
})
