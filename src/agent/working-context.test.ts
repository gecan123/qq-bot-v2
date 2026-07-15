import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { DurableAgentMessage, ToolResultImageRefBlock } from './agent-context.types.js'
import { buildWorkingContextProjection } from './working-context.js'

function imageRef(mediaId: string, description?: string): ToolResultImageRefBlock {
  return {
    type: 'image_ref', mediaId, mediaType: 'image/png', ...(description ? { description } : {}),
  }
}

describe('buildWorkingContextProjection', () => {
  test('hydrates only recent image-result messages without changing durable refs', async () => {
    const source: DurableAgentMessage[] = [
      { role: 'tool', toolCallId: 'old', content: [imageRef('1', 'old image')] },
      { role: 'tool', toolCallId: 'new', content: [imageRef('2', 'new image')] },
    ]
    const resolved: string[] = []
    const projection = await buildWorkingContextProjection(source, {
      recentImageToolResults: 1,
      imageRefs: {
        async persist() { throw new Error('not used') },
        async resolve(ref) {
          resolved.push(ref.mediaId)
          return {
            type: 'image',
            source: { type: 'base64', media_type: ref.mediaType, data: 'aW1hZ2U=' },
          }
        },
      },
    })

    assert.deepEqual(resolved, ['2'])
    assert.match(JSON.stringify(projection.messages[0]), /working_context_image_omitted/)
    const oldMessage = projection.messages[0]!
    assert.equal(oldMessage.role, 'tool')
    assert.ok(Array.isArray(oldMessage.content))
    assert.deepEqual(JSON.parse((oldMessage.content[0] as { type: 'text'; text: string }).text), {
      type: 'working_context_image_omitted',
      mediaId: '1',
      mediaType: 'image/png',
      description: 'old image',
    })
    assert.match(JSON.stringify(projection.messages[1]), /"type":"base64"/)
    assert.doesNotMatch(JSON.stringify(source), /"type":"base64"/)
    assert.deepEqual(projection.stats, {
      sourceMessages: 2, projectedMessages: 2, hydratedImages: 1, omittedImages: 1, unavailableImages: 0,
    })
  })

  test('renders a deterministic marker with persisted metadata when a recent ref is unavailable', async () => {
    const source: DurableAgentMessage[] = [{
      role: 'tool', toolCallId: 'missing', content: [imageRef('404', 'persisted description')],
    }]
    const options = {
      imageRefs: {
        async persist() { throw new Error('not used') },
        async resolve() { return null },
      },
    }
    const first = await buildWorkingContextProjection(source, options)
    const second = await buildWorkingContextProjection(source, options)

    assert.deepEqual(first.messages, second.messages)
    const rendered = JSON.stringify(first.messages)
    assert.match(rendered, /working_context_image_unavailable/)
    assert.match(rendered, /persisted description/)
    const message = first.messages[0]!
    assert.equal(message.role, 'tool')
    assert.ok(Array.isArray(message.content))
    assert.equal(
      JSON.parse((message.content[0] as { type: 'text'; text: string }).text).mediaId,
      '404',
    )
    assert.equal(first.stats.unavailableImages, 1)
  })
})
