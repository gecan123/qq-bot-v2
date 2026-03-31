import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { buildReplySegments } from './segment-builder.js'

describe('buildReplySegments', () => {
  test('reply builder prepends reply and at segments', () => {
    const segments = buildReplySegments({
      replyToMessageId: 123,
      mentionUserId: 456,
      text: '你好',
    })

    assert.equal(segments[0]?.type, 'reply')
    assert.deepEqual(segments[0]?.data, { id: '123' })
    assert.equal(segments[1]?.type, 'at')
    assert.deepEqual(segments[1]?.data, { qq: '456' })
    assert.equal(segments[2]?.type, 'text')
    assert.deepEqual(segments[2]?.data, { text: ' 你好' })
  })

  test('builder may omit at segment for plain reply', () => {
    const segments = buildReplySegments({
      replyToMessageId: 123,
      text: '你好',
    })

    assert.equal(segments.length, 2)
    assert.equal(segments[0]?.type, 'reply')
    assert.equal(segments[1]?.type, 'text')
    assert.deepEqual(segments[1]?.data, { text: '你好' })
  })
})

