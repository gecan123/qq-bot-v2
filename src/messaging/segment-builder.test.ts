import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { buildReplySegments, buildOutboundSegments } from './segment-builder.js'

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

describe('buildOutboundSegments', () => {
  test('text-only', () => {
    const segments = buildOutboundSegments({ text: 'hello' })
    assert.deepEqual(segments, [
      { type: 'text', data: { text: 'hello' } },
    ])
  })

  test('image-only', () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47])
    const segments = buildOutboundSegments({ imageBytes: bytes })
    assert.equal(segments.length, 1)
    assert.equal(segments[0].type, 'image')
    assert.ok((segments[0].data.file as string).startsWith('base64://'))
  })

  test('text + image', () => {
    const bytes = Buffer.from('img')
    const segments = buildOutboundSegments({ text: 'look', imageBytes: bytes })
    assert.equal(segments.length, 2)
    assert.equal(segments[0].type, 'text')
    assert.equal(segments[1].type, 'image')
  })

  test('full: reply + mention + text + image in correct order', () => {
    const bytes = Buffer.from('img')
    const segments = buildOutboundSegments({
      replyToMessageId: 100,
      mentionUserId: 200,
      text: 'check this',
      imageBytes: bytes,
    })
    const types = segments.map((s) => s.type)
    assert.deepEqual(types, ['reply', 'at', 'text', 'image'])
    assert.equal(segments[0].data.id, '100')
    assert.equal(segments[1].data.qq, '200')
    assert.equal(segments[2].data.text, ' check this')
  })

  test('empty input produces empty segments', () => {
    const segments = buildOutboundSegments({})
    assert.deepEqual(segments, [])
  })
})

