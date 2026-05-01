import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { createMessageSender } from './message-sender.js'

describe('messageSender', () => {
  test('replyToMessage becomes dry run when reply dry-run switch is enabled', async () => {
    const calls: Array<{ groupId: number }> = []
    const sender = createMessageSender({
      replyDryRun: true,
      sendDryRun: false,
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
      sendDryRun: true,
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
      sendDryRun: false,
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

  test('sendPrivateMessage uses reply dry-run switch and private transport', async () => {
    const calls: Array<{ userId: number }> = []
    const sender = createMessageSender({
      replyDryRun: false,
      sendDryRun: true,
      sendGroupReplyFn: async () => {
        throw new Error('sendGroupReplyFn should not send private replies')
      },
      sendPrivateMessageFn: async (userId) => {
        calls.push({ userId })
        return { success: true, attempts: 1, providerMessageId: 9001 }
      },
    })

    assert.ok(sender.sendPrivateMessage)
    const result = await sender.sendPrivateMessage({
      userId: 20,
      text: 'private reply',
    })

    assert.deepEqual(calls, [{ userId: 20 }])
    assert.deepEqual(result, { success: true, attempts: 1, providerMessageId: 9001 })
  })
})
