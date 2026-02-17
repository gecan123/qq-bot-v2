import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { computeMediaHash } from './media-hash.js'

describe('computeMediaHash', () => {
  test('returns same hash for identical content', () => {
    const a = Buffer.from('abc')
    const b = Buffer.from('abc')

    assert.equal(computeMediaHash(a), computeMediaHash(b))
  })

  test('returns different hash for different content', () => {
    const a = Buffer.from('abc')
    const b = Buffer.from('abd')

    assert.notEqual(computeMediaHash(a), computeMediaHash(b))
  })
})
