import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { createMentionDispatcher } from './dispatcher.js'
import type { ParsedSegment } from '../types/message-segments.js'

describe('mention dispatcher', () => {
  test('dispatcher enqueues mention event when message contains @self', () => {
    const events: Array<{ groupId: number; messageId: number; senderId: number; createdAt: number }> = []
    const dispatcher = createMentionDispatcher({
      selfNumber: 123456,
      queue: {
        enqueueMention(event) {
          events.push(event)
        },
        start() {},
        stop() {},
      },
    })

    const dispatched = dispatcher.dispatchIfMentioned({
      groupId: 1,
      messageId: 42,
      senderId: 9,
      createdAt: 123,
      segments: [{ type: 'at', targetId: '123456' }],
    })

    assert.equal(dispatched, true)
    assert.deepEqual(events, [{ groupId: 1, messageId: 42, senderId: 9, createdAt: 123 }])
  })

  test('dispatcher ignores messages without @self', () => {
    const events: Array<{ groupId: number; messageId: number; senderId: number; createdAt: number }> = []
    const dispatcher = createMentionDispatcher({
      selfNumber: 123456,
      queue: {
        enqueueMention(event) {
          events.push(event)
        },
        start() {},
        stop() {},
      },
    })

    const dispatched = dispatcher.dispatchIfMentioned({
      groupId: 1,
      messageId: 42,
      senderId: 9,
      createdAt: 123,
      segments: [{ type: 'at', targetId: '999999' } satisfies ParsedSegment],
    })

    assert.equal(dispatched, false)
    assert.deepEqual(events, [])
  })
})
