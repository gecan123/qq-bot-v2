import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  buildIdleTickUserMessage,
  parseGroupIdFromSceneId,
  startIdleThread,
} from './idle-thread.js'
import type { InnerJournalEntry } from '../world-model/inner-journal-store.js'

describe('parseGroupIdFromSceneId', () => {
  test('parses qq_group:123 to 123', () => {
    assert.equal(parseGroupIdFromSceneId('qq_group:123'), 123)
  })

  test('rejects qq_private scene id', () => {
    assert.equal(parseGroupIdFromSceneId('qq_private:42'), null)
  })

  test('rejects forum scene id', () => {
    assert.equal(parseGroupIdFromSceneId('forum:hn'), null)
  })

  test('rejects malformed group id', () => {
    assert.equal(parseGroupIdFromSceneId('qq_group:abc'), null)
  })
})

describe('buildIdleTickUserMessage', () => {
  test('empty journal: minimal prompt', () => {
    const result = buildIdleTickUserMessage([])
    assert.match(result, /\[内省时刻\]/)
    assert.equal(result.includes('你最近的私下笔记'), false)
  })

  test('with journal entries: includes timestamps and content', () => {
    const entries: InnerJournalEntry[] = [
      {
        id: 1,
        sceneId: 'qq_group:1',
        content: 'Alice 今天回得很短',
        sourceEventIds: [],
        createdAt: new Date('2026-05-01T12:34:00.000Z'),
      },
      {
        id: 2,
        sceneId: 'qq_group:1',
        content: '想问她最近忙什么',
        sourceEventIds: [],
        createdAt: new Date('2026-05-01T13:00:00.000Z'),
      },
    ]
    const result = buildIdleTickUserMessage(entries)
    assert.match(result, /Alice 今天回得很短/)
    assert.match(result, /想问她最近忙什么/)
    assert.match(result, /2026-05-01T12:34/)
  })
})

describe('startIdleThread kill switch', () => {
  test('intervalMs <= 0: no timers', () => {
    const timers = startIdleThread({
      groupIds: [1, 2],
      intervalMs: 0,
    })
    assert.equal(timers.length, 0)
  })

  test('groupIds empty: no timers', () => {
    const timers = startIdleThread({
      groupIds: [],
      intervalMs: 60_000,
    })
    assert.equal(timers.length, 0)
  })

  test('intervalMs > 0 and groupIds non-empty: returns 2 timers (initial + interval)', () => {
    const timers = startIdleThread({
      groupIds: [1],
      intervalMs: 60_000,
      initialDelayMs: 30_000,
    })
    assert.equal(timers.length, 2)
    // 立即清理避免影响其它测试
    for (const t of timers) {
      clearTimeout(t)
      clearInterval(t)
    }
  })
})
