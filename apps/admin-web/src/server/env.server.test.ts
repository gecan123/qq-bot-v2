import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { parseAdminServerEnv } from './env.server.js'

describe('parseAdminServerEnv', () => {
  test('accepts a PostgreSQL database URL', () => {
    const databaseUrl = 'postgresql://user:pass@localhost:5432/db'

    assert.deepEqual(parseAdminServerEnv({ DATABASE_URL: databaseUrl }), {
      DATABASE_URL: databaseUrl,
    })
  })

  test('rejects a missing database URL without exposing input details', () => {
    assert.throws(
      () => parseAdminServerEnv({}),
      /Admin Web server configuration is invalid/,
    )
  })

  test('rejects a non-PostgreSQL URL without exposing its password', () => {
    const secret = 'supersecret'

    assert.throws(
      () => parseAdminServerEnv({ DATABASE_URL: `mysql://user:${secret}@localhost/db` }),
      error => {
        assert.ok(error instanceof Error)
        assert.match(error.message, /Admin Web server configuration is invalid/)
        assert.doesNotMatch(error.message, new RegExp(secret))
        return true
      },
    )
  })
})
