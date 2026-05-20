import test from 'node:test'
import assert from 'node:assert/strict'

import { STICKER_POOL_PREFIX } from './sticker-pool.js'

test('STICKER_POOL_PREFIX is the expected value', () => {
  assert.equal(STICKER_POOL_PREFIX, '[你的表情包]')
})
