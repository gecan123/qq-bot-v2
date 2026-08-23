import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { parseLoopbackHttpOrigin } from './loopback-origin.js'

describe('parseLoopbackHttpOrigin', () => {
  test('normalizes supported loopback origins', () => {
    assert.equal(parseLoopbackHttpOrigin('TEST_URL', 'http://localhost:1234/'), 'http://localhost:1234')
    assert.equal(parseLoopbackHttpOrigin('TEST_URL', 'http://[::1]:1234'), 'http://[::1]:1234')
  })

  test('rejects remote, credentialed and path URLs', () => {
    for (const value of [
      'https://127.0.0.1:1234',
      'http://example.com:1234',
      'http://user:pass@127.0.0.1:1234',
      'http://127.0.0.1:1234/path',
    ]) {
      assert.throws(() => parseLoopbackHttpOrigin('TEST_URL', value), /TEST_URL/)
    }
  })

  test('can require an explicit port', () => {
    assert.throws(
      () => parseLoopbackHttpOrigin('TEST_URL', 'http://127.0.0.1', { requirePort: true }),
      /explicit port/,
    )
  })
})
