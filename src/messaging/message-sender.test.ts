import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { createMessageSender } from './message-sender.js'

describe('messageSender', () => {
  test('replyToMessage becomes dry run when reply dry-run switch is enabled', async () => {
    const calls: Array<{ groupId: number }> = []
    const sender = createMessageSender({
      replyDryRun: true,
      proactiveDryRun: false,
      sendGroupReplyFn: async (groupId) => {
        calls.push({ groupId })
        return { success: true, attempts: 1 }
      },
    })

    const result = await sender.replyToMessage({
      groupId: 1,
      replyToMessageId: 1001,
      mentionUserId: 20,
      text: 'dry run reply',
    })

    assert.deepEqual(calls, [])
    assert.deepEqual(result, { success: true, attempts: 0 })
  })

  test('sendMessage becomes dry run when proactive dry-run switch is enabled', async () => {
    const calls: Array<{ groupId: number }> = []
    const sender = createMessageSender({
      replyDryRun: false,
      proactiveDryRun: true,
      sendGroupReplyFn: async (groupId) => {
        calls.push({ groupId })
        return { success: true, attempts: 1 }
      },
    })

    const result = await sender.sendMessage({
      groupId: 2,
      text: 'plain send',
    })

    assert.deepEqual(calls, [])
    assert.deepEqual(result, { success: true, attempts: 0 })
  })

  test('reply and proactive dry-run switches do not affect each other', async () => {
    const calls: Array<{ groupId: number }> = []
    const sender = createMessageSender({
      replyDryRun: true,
      proactiveDryRun: false,
      sendGroupReplyFn: async (groupId) => {
        calls.push({ groupId })
        return { success: true, attempts: 1 }
      },
    })

    const result = await sender.sendMessage({
      groupId: 3,
      text: 'plain send',
    })

    assert.deepEqual(calls, [{ groupId: 3 }])
    assert.deepEqual(result, { success: true, attempts: 1 })
  })
})
