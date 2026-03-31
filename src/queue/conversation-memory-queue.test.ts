import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { createConversationMemoryQueue } from './conversation-memory-queue.js'

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const startedAt = Date.now()

  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('waitFor timeout')
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe('conversation memory queue', () => {
  test('conversation queue delivers mention events to scheduler callback', async () => {
    const delivered: number[] = []
    const queue = createConversationMemoryQueue({
      onMention: async (event) => {
        delivered.push(event.messageId)
      },
    })

    queue.start()
    queue.enqueueMention({ groupId: 1, messageId: 42, senderId: 9, createdAt: Date.now() })

    await waitFor(() => delivered.length === 1)
    assert.deepEqual(delivered, [42])
    queue.stop()
  })

  test('queue preserves enqueue order', async () => {
    const delivered: number[] = []
    const queue = createConversationMemoryQueue({
      onMention: async (event) => {
        delivered.push(event.messageId)
      },
    })

    queue.start()
    queue.enqueueMention({ groupId: 1, messageId: 1, senderId: 9, createdAt: Date.now() })
    queue.enqueueMention({ groupId: 1, messageId: 2, senderId: 9, createdAt: Date.now() })

    await waitFor(() => delivered.length === 2)
    assert.deepEqual(delivered, [1, 2])
    queue.stop()
  })
})
