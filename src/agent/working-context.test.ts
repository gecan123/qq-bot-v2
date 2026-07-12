import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { AgentMessage } from './agent-context.types.js'
import { buildWorkingContextProjection } from './working-context.js'

function imageResult(id: string, data: string): AgentMessage {
  return {
    role: 'tool',
    toolCallId: id,
    content: [
      { type: 'text', text: `result ${id}` },
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data },
      },
    ],
  }
}

describe('buildWorkingContextProjection', () => {
  test('keeps recent image results and degrades older bytes without mutating the ledger', () => {
    const source: AgentMessage[] = [
      { role: 'user', content: 'start' },
      imageResult('old', 'aaaa'),
      { role: 'assistant', content: '', toolCalls: [] },
      imageResult('new', 'bbbbbb'),
    ]
    const before = structuredClone(source)

    const projection = buildWorkingContextProjection(source, { recentImageToolResults: 1 })

    assert.deepEqual(source, before)
    assert.deepEqual(projection.stats, {
      sourceMessages: 4,
      projectedMessages: 4,
      preservedImages: 1,
      omittedImages: 1,
      omittedBase64Chars: 4,
    })
    const old = projection.messages[1]
    assert.equal(old?.role, 'tool')
    if (old?.role !== 'tool' || typeof old.content === 'string') assert.fail('expected blocks')
    assert.deepEqual(old.content[0], { type: 'text', text: 'result old' })
    assert.deepEqual(old.content[1], {
      type: 'text',
      text: JSON.stringify({
        type: 'working_context_image_omitted',
        mediaType: 'image/png',
        base64Chars: 4,
        durableLedgerRetainsOriginal: true,
      }),
    })
    assert.deepEqual(projection.messages[3], source[3])
  })

  test('zero image retention omits every image while preserving message/tool-result structure', () => {
    const source = [imageResult('one', 'abc'), imageResult('two', 'def')]
    const projection = buildWorkingContextProjection(source, { recentImageToolResults: 0 })

    assert.equal(projection.messages.length, 2)
    assert.deepEqual(projection.messages.map((message) => message.role), ['tool', 'tool'])
    assert.equal(projection.stats.omittedImages, 2)
    assert.equal(projection.stats.preservedImages, 0)
  })
})
