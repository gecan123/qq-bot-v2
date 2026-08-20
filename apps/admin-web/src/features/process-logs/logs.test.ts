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
      { sequence: 1, level: 'info', timestamp: null, scope: null, message: 'INFO [QQ_GATEWAY] connected', metadata: null, detail: null, text: 'INFO [QQ_GATEWAY] connected' },
      { sequence: 2, level: 'warn', timestamp: null, scope: null, message: 'WARN [SCHEDULER_SERVICE] delayed', metadata: null, detail: null, text: 'WARN [SCHEDULER_SERVICE] delayed' },
      { sequence: 3, level: 'unknown', timestamp: null, scope: null, message: 'plain child output', metadata: null, detail: null, text: 'plain child output' },
      { sequence: 4, level: 'error', timestamp: null, scope: null, message: 'ERROR [AGENT] failed', metadata: null, detail: null, text: 'ERROR [AGENT] failed' },
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
      { sequence: 1, level: 'fatal', timestamp: null, scope: null, message: 'FATAL third', metadata: null, detail: null, text: 'FATAL third' },
      { sequence: 2, level: 'debug', timestamp: null, scope: null, message: 'DEBUG fourth', metadata: null, detail: null, text: 'DEBUG fourth' },
    ])
    assert.equal(parsed.leadingPartialLineDropped, true)
    assert.equal(parsed.lineLimitTruncated, true)
  })

  test('drops orphaned multiline fragments before the first complete pino entry in a byte tail', () => {
    const parsed = parseProcessLogTail([
      'partial first line',
      '      "description": "orphaned schema fragment"',
      '    }',
      'INFO [2026-08-20T09:10:11.123+08:00]: [APP] 数据库已连接',
    ].join('\n'), { bytesTruncated: true, limit: 10 })

    assert.deepEqual(parsed.entries.map(entry => entry.message), ['数据库已连接'])
    assert.equal(parsed.leadingPartialLineDropped, true)
  })

  test('parses pino-pretty fields and keeps multiline error details with the parent entry', () => {
    const parsed = parseProcessLogTail([
      'WARN [2026-08-20T09:10:11.123+08:00]: [BOT_LOOP] state_advisor_failed {"observedIdleRounds":3}',
      '    error: "Anthropic API 502"',
      'ERROR [2026-08-20T09:10:12.456+08:00]: [REACT_KERNEL] round_failed {"roundIndex":7}',
      '    err: {',
      '      "message": "boom"',
      '    }',
    ].join('\n'), { bytesTruncated: false, limit: 10 })

    assert.deepEqual(parsed.entries, [
      {
        sequence: 1,
        level: 'warn',
        timestamp: '2026-08-20T09:10:11.123+08:00',
        scope: 'BOT_LOOP',
        message: 'state_advisor_failed',
        metadata: { observedIdleRounds: 3 },
        detail: '    error: "Anthropic API 502"',
        text: [
          'WARN [2026-08-20T09:10:11.123+08:00]: [BOT_LOOP] state_advisor_failed {"observedIdleRounds":3}',
          '    error: "Anthropic API 502"',
        ].join('\n'),
      },
      {
        sequence: 2,
        level: 'error',
        timestamp: '2026-08-20T09:10:12.456+08:00',
        scope: 'REACT_KERNEL',
        message: 'round_failed',
        metadata: { roundIndex: 7 },
        detail: [
          '    err: {',
          '      "message": "boom"',
          '    }',
        ].join('\n'),
        text: [
          'ERROR [2026-08-20T09:10:12.456+08:00]: [REACT_KERNEL] round_failed {"roundIndex":7}',
          '    err: {',
          '      "message": "boom"',
          '    }',
        ].join('\n'),
      },
    ])
  })
})
