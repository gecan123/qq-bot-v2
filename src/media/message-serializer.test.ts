import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ParsedSegment } from '../types/message-segments.js'
import { serializeForLLM } from './message-serializer.js'

test('serializeForLLM includes structured forward content', () => {
  const segments: ParsedSegment[] = [{
    type: 'forward',
    forwardId: 'forward-1',
    items: [{
      senderId: '101',
      senderName: 'Alice',
      content: [{ type: 'text', content: 'hello' }],
    }],
  }]

  assert.equal(
    serializeForLLM(segments),
    '[合并转发消息]\nAlice(101): hello\n[转发结束]',
  )
})
