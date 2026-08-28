import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { describeActivityTrigger } from './activity-trigger.js'
import type { BotEvent } from './event.js'

function chatEvent(input: {
  platform: 'qq' | 'feishu'
  kind: 'group' | 'private'
  mentionedSelf?: boolean
  eventKind?: 'message' | 'edit' | 'recall'
}): Extract<BotEvent, { type: 'chat_message' }> {
  return {
    type: 'chat_message',
    eventKind: input.eventKind ?? 'message',
    messageRowId: 1,
    conversation: {
      platform: input.platform,
      accountId: input.platform === 'qq' ? '10000' : 'cli_a',
      kind: input.kind,
      externalId: input.kind === 'group' ? 'oc_1' : 'ou_1',
    },
    conversationName: '测试会话',
    messageExternalId: 'message-1',
    senderExternalId: 'sender-1',
    senderName: 'Alice',
    mentionedSelf: input.mentionedSelf ?? input.kind === 'private',
    sentAt: new Date('2026-07-20T08:00:00.000Z'),
    renderedText: 'hello',
  }
}

describe('describeActivityTrigger', () => {
  test('describes canonical Feishu private attention with a platform-neutral target', () => {
    assert.deepEqual(describeActivityTrigger([chatEvent({ platform: 'feishu', kind: 'private' })]), {
      kind: 'private_message',
      label: '收到 Alice 的私聊',
      target: { platform: 'feishu', accountId: 'cli_a', kind: 'private', externalId: 'ou_1' },
    })
  })

  test('describes canonical QQ group mention', () => {
    assert.deepEqual(describeActivityTrigger([
      chatEvent({ platform: 'qq', kind: 'group', mentionedSelf: true }),
    ]), {
      kind: 'group_mention',
      label: '测试会话 中有人提到了 Agent',
      target: { platform: 'qq', accountId: '10000', kind: 'group', externalId: 'oc_1' },
    })
  })

  test('does not mislabel a passive ordinary group event as a mention', () => {
    assert.equal(describeActivityTrigger([
      chatEvent({ platform: 'feishu', kind: 'group', mentionedSelf: false }),
    ]), null)
  })
})
