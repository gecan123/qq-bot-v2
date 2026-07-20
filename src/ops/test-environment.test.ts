import assert from 'node:assert/strict'
import { isAbsolute, relative } from 'node:path'
import { test } from 'node:test'

test('isolates file-backed observability from repository logs', () => {
  assert.equal(process.env.LOG_FILE_ENABLED, 'false')

  for (const name of [
    'BOT_TOKEN_USAGE_LOG_PATH',
    'BOT_TOOL_CALL_LOG_PATH',
    'BOT_FETCH_LOG_PATH',
  ] as const) {
    const path = process.env[name]
    assert.equal(typeof path, 'string', `${name} must be configured by the test preload`)
    assert.equal(isAbsolute(path!), true, `${name} must use an absolute temporary path`)
    assert.equal(relative(process.cwd(), path!).startsWith('logs/'), false)
  }
})
