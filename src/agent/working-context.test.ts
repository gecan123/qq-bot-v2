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
  test('hydrates every durable image ref in native mode without changing the ledger', async () => {
    const source: DurableAgentMessage[] = [
      { role: 'tool', toolCallId: 'old', content: [imageRef('1', 'old image')] },
      { role: 'tool', toolCallId: 'new', content: [imageRef('2', 'new image')] },
    ]
    const resolved: string[] = []
    const projection = await buildWorkingContextProjection(source, {
      imageInputMode: 'native',
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

    assert.deepEqual(resolved, ['1', '2'])
    assert.equal(JSON.stringify(projection.messages).match(/"type":"base64"/g)?.length, 2)
    assert.doesNotMatch(JSON.stringify(source), /"type":"base64"/)
    assert.deepEqual(projection.stats, {
      sourceMessages: 2, projectedMessages: 2, hydratedImages: 2, omittedImages: 0, unavailableImages: 0,
    })
  })

  test('projects every image ref to stable persisted descriptions in description mode without reading bytes', async () => {
    const source: DurableAgentMessage[] = [
      { role: 'tool', toolCallId: 'old', content: [imageRef('1', 'old image')] },
      { role: 'tool', toolCallId: 'new', content: [imageRef('2')] },
    ]
    let resolveCalls = 0
    const projection = await buildWorkingContextProjection(source, {
      imageInputMode: 'description',
      imageRefs: {
        async persist() { throw new Error('not used') },
        async resolve() { resolveCalls++; throw new Error('description mode must not read bytes') },
      },
    })

    assert.equal(resolveCalls, 0)
    const firstMessage = projection.messages[0]!
    assert.equal(firstMessage.role, 'tool')
    assert.ok(Array.isArray(firstMessage.content))
    assert.deepEqual(JSON.parse((firstMessage.content[0] as { type: 'text'; text: string }).text), {
      type: 'working_context_image_omitted',
      reason: 'agent_image_mode_description',
      mediaId: '1',
      mediaType: 'image/png',
      description: 'old image',
    })
    assert.doesNotMatch(JSON.stringify(projection.messages), /"type":"image"/)
    assert.deepEqual(projection.stats, {
      sourceMessages: 2, projectedMessages: 2, hydratedImages: 0, omittedImages: 2, unavailableImages: 0,
    })
  })

  test('renders a deterministic marker with persisted metadata when an image ref is unavailable', async () => {
    const source: DurableAgentMessage[] = [{
      role: 'tool', toolCallId: 'missing', content: [imageRef('404', 'persisted description')],
    }]
    const options = {
      imageInputMode: 'native' as const,
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
