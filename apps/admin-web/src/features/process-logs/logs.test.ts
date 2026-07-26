import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import {
  parseProcessLogTail,
  processLogSourceSchema,
} from './logs.js'

describe('process logs', () => {
  test('accepts only the fixed process source allowlist', () => {
    assert.equal(processLogSourceSchema.safeParse('agent-core').success, true)
    assert.equal(processLogSourceSchema.safeParse('../../.env').success, false)
    assert.equal(processLogSourceSchema.safeParse('/tmp/other.log').success, false)
  })

  test('strips terminal colors, classifies levels, and preserves chronological order', () => {
    const parsed = parseProcessLogTail([
      '\u001B[32mINFO\u001B[39m [QQ_GATEWAY] connected',
      'WARN [SCHEDULER_SERVICE] delayed',
      'plain child output',
      'ERROR [AGENT] failed',
    ].join('\n'), { bytesTruncated: false, limit: 10 })

    assert.deepEqual(parsed.entries, [
      { sequence: 1, level: 'info', text: 'INFO [QQ_GATEWAY] connected' },
      { sequence: 2, level: 'warn', text: 'WARN [SCHEDULER_SERVICE] delayed' },
      { sequence: 3, level: 'unknown', text: 'plain child output' },
      { sequence: 4, level: 'error', text: 'ERROR [AGENT] failed' },
    ])
    assert.equal(parsed.leadingPartialLineDropped, false)
    assert.equal(parsed.lineLimitTruncated, false)
  })

  test('drops a partial first line after a bounded tail read and caps returned lines', () => {
    const parsed = parseProcessLogTail(
      ['partial remainder', 'INFO second', 'FATAL third', 'DEBUG fourth'].join('\n'),
      { bytesTruncated: true, limit: 2 },
    )

    assert.deepEqual(parsed.entries, [
      { sequence: 1, level: 'fatal', text: 'FATAL third' },
      { sequence: 2, level: 'debug', text: 'DEBUG fourth' },
    ])
    assert.equal(parsed.leadingPartialLineDropped, true)
    assert.equal(parsed.lineLimitTruncated, true)
  })
})
