import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { parseStrictNonNegativeInteger, parseStrictPositiveInteger, requireEnv } from './env.js'

describe('config env primitives', () => {
  test('critical integer parsers reject malformed configured values', () => {
    assert.throws(() => parseStrictPositiveInteger('PORT', 'oops', 10), /Invalid PORT/)
    assert.throws(() => parseStrictPositiveInteger('PORT', '0', 10), /Invalid PORT/)
    assert.throws(() => parseStrictNonNegativeInteger('DAYS', '-1', 10), /Invalid DAYS/)
  })

  test('required values fail with their environment name', () => {
    assert.throws(() => requireEnv({}, 'DATABASE_URL'), /DATABASE_URL/)
  })
})
