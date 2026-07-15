import assert from 'node:assert/strict'
import { test } from 'node:test'
import { toDurableAgentMessage } from './durable-agent-message.js'

test('converts tool base64 images to refs before canonical append', async () => {
  const durable = await toDurableAgentMessage({
    role: 'tool',
    toolCallId: 'image-1',
    content: [
      { type: 'text', text: 'generated image' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } },
    ],
  }, {
    async persist() {
      return {
        type: 'image_ref', mediaId: '99', mediaType: 'image/png', description: 'generated image',
      }
    },
    async resolve() { return null },
  })

  assert.deepEqual(durable, {
    role: 'tool',
    toolCallId: 'image-1',
    content: [
      { type: 'text', text: 'generated image' },
      { type: 'image_ref', mediaId: '99', mediaType: 'image/png', description: 'generated image' },
    ],
  })
  assert.doesNotMatch(JSON.stringify(durable), /"type":"base64"/)
})
