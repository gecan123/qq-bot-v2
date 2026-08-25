import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { compressForContext } from './compress-for-context.js'

function svg(width: number, height: number): Buffer {
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="blue"/></svg>`)
}

describe('compressForContext image safety', () => {
  test('creates a bounded JPEG preview for an ordinary image', async () => {
    const result = await compressForContext(svg(1_920, 1_080))

    assert.ok(result)
    assert.equal(result.mediaType, 'image/jpeg')
    assert.ok(result.byteSize > 0)
  })

  test('refuses to decode an image above the maximum edge', async () => {
    const result = await compressForContext(svg(8_193, 100))

    assert.equal(result, null)
  })
})
