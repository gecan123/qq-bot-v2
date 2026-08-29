import assert from 'node:assert/strict'
import { test } from 'node:test'
import { InMemoryEventQueue } from '../event-queue.js'
import type { BotEvent } from '../event.js'
import type { ConversationController } from './conversation.js'
import { createSendMessageTool } from './send-message.js'

const target = {
  platform: 'feishu' as const,
  accountId: 'cli_1',
  kind: 'private' as const,
  externalId: 'oc_owner',
}
const conversations: ConversationController = {
  getCurrent: () => target,
  async resolveCurrent() { return { ok: true, target } },
  async open(next) { return { ok: true, current: next } },
  close() {},
  async list() { return [{ target, displayName: '主人' }] },
}
const ctx = { eventQueue: new InMemoryEventQueue<BotEvent>(), roundIndex: 0 }

test('send_message preserves one action id and returns a confirmed generic effect', async () => {
  const requests: unknown[] = []
  const tool = createSendMessageTool({
    conversations,
    targetPolicy: { async authorize() { return { allowed: true } } },
    delivery: {
      async send(request) {
        requests.push(request)
        return { status: 'sent', providerMessageId: 'om_1' }
      },
    },
    actionId: () => 'dd45c941-f1b8-4026-8f14-72f56adc9083',
    loadReplyMessage: async (rowId) => ({
      rowId,
      eventKind: 'message',
      platform: 'feishu',
      accountId: 'cli_1',
      conversationKind: 'private',
      conversationExternalId: 'oc_owner',
      messageExternalId: 'om_parent',
      senderExternalId: 'ou_owner',
      senderName: '主人',
      senderConversationName: null,
      content: [{ type: 'text', content: '上一条消息' }],
      resolvedText: '上一条消息',
      searchText: '上一条消息',
    }),
  })

  const result = await tool.execute({
    message: ' 收到 ', reply_to: { row_id: 41, expect: 'message' }, work: { state: 'none' },
  }, ctx)

  assert.deepEqual(requests, [{
    actionId: 'dd45c941-f1b8-4026-8f14-72f56adc9083',
    target,
    text: '收到',
    replyToExternalId: 'om_parent',
  }])
  assert.deepEqual(result.effects, [{ type: 'message_sent', target }])
  assert.equal(JSON.parse(result.content as string).status, 'sent')
})

test('send_message rejects an adjacent non-mention before quoting a mentioned-self reply', async () => {
  const qqTarget = {
    platform: 'qq' as const,
    accountId: '3999414673',
    kind: 'group' as const,
    externalId: '476109921',
  }
  const requests: unknown[] = []
  const rows = new Map([
    [7351, {
      rowId: 7351,
      eventKind: 'message',
      platform: 'qq',
      accountId: '3999414673',
      conversationKind: 'group',
      conversationExternalId: '476109921',
      messageExternalId: '95922210',
      senderExternalId: '1249818884',
      senderName: '阿库娅',
      senderConversationName: null,
      content: [{ type: 'at', targetId: '3999414673' }, { type: 'text', content: '你也解读一下' }],
      resolvedText: '@3999414673你也解读一下',
      searchText: '@3999414673你也解读一下',
    }],
    [7353, {
      rowId: 7353,
      eventKind: 'message',
      platform: 'qq',
      accountId: '3999414673',
      conversationKind: 'group',
      conversationExternalId: '476109921',
      messageExternalId: '536543205',
      senderExternalId: '1776150535',
      senderName: '酸橙味软糖🍊',
      senderConversationName: null,
      content: [{ type: 'image', referenceId: '2904' }],
      resolvedText: '[图片#2904]',
      searchText: '[图片#2904]',
    }],
  ])
  const tool = createSendMessageTool({
    conversations: {
      ...conversations,
      getCurrent: () => qqTarget,
      async resolveCurrent() { return { ok: true, target: qqTarget } },
    },
    selfExternalIds: { qq: '3999414673' },
    loadReplyMessage: async (rowId) => rows.get(rowId) ?? null,
    targetPolicy: { async authorize() { return { allowed: true } } },
    delivery: {
      async send(request) {
        requests.push(request)
        return { status: 'sent', providerMessageId: '171057428' }
      },
    },
  })

  const wrong = await tool.execute({
    message: '阿蒙已经解读得很到位了。',
    reply_to: { row_id: 7353, expect: 'mentioned_self' },
    work: { state: 'none' },
  }, ctx)

  assert.deepEqual(JSON.parse(wrong.content as string), {
    ok: false,
    status: 'failed',
    code: 'reply_target_not_mentioned_self',
    error: 'reply target does not structurally mention the bot',
    target: qqTarget,
    replyTo: {
      rowId: 7353,
      senderExternalId: '1776150535',
      senderName: '酸橙味软糖🍊',
      text: '[图片#2904]',
    },
  })
  assert.deepEqual(requests, [])

  const correct = await tool.execute({
    message: '阿蒙已经解读得很到位了。',
    reply_to: { row_id: 7351, expect: 'mentioned_self' },
    work: { state: 'none' },
  }, ctx)

  assert.equal(JSON.parse(correct.content as string).status, 'sent')
  assert.deepEqual(requests, [{
    actionId: JSON.parse(correct.content as string).actionId,
    target: qqTarget,
    text: '阿蒙已经解读得很到位了。',
    replyToExternalId: '95922210',
  }])
})

test('send_message reports delivery_unknown without claiming an effect', async () => {
  const tool = createSendMessageTool({
    conversations,
    targetPolicy: { async authorize() { return { allowed: true } } },
    delivery: { async send() { return { status: 'delivery_unknown', code: 'timeout' } } },
    actionId: () => 'b8ff2ab8-df0a-47d6-b7d8-1510dfeccfa5',
  })
  const result = await tool.execute({ message: 'hello', work: { state: 'none' } }, ctx)
  assert.equal(JSON.parse(result.content as string).status, 'delivery_unknown')
  assert.equal(result.effects, undefined)
  assert.equal(result.outcome?.ok, false)
})

test('send_message preserves QQ music validation rules', () => {
  const tool = createSendMessageTool({
    conversations,
    targetPolicy: { async authorize() { return { allowed: true } } },
    delivery: { async send() { return { status: 'sent' } } },
  })
  assert.equal(tool.schema.safeParse({
    music: { platform: '163' }, work: { state: 'none' },
  }).success, false)
  assert.equal(tool.schema.safeParse({
    music: {
      platform: 'custom', url: 'https://music.example/a',
      image: 'https://music.example/a.png', title: 'A',
    },
    work: { state: 'none' },
  }).success, true)
})

test('send_message accepts one bounded long work and rejects oversized text', () => {
  const tool = createSendMessageTool({
    conversations,
    targetPolicy: { async authorize() { return { allowed: true } } },
    delivery: { async send() { return { status: 'sent' } } },
  })
  assert.equal(tool.schema.safeParse({
    message: '长'.repeat(20_000), work: { state: 'none' },
  }).success, true)
  assert.equal(tool.schema.safeParse({
    message: '长'.repeat(20_001), work: { state: 'none' },
  }).success, false)
  assert.match(tool.description, /完整长文本必须一次提交.*自动分段折叠/s)
})

test('send_message diagnoses a failed QQ group delivery as muted', async () => {
  const qqTarget = {
    platform: 'qq' as const, accountId: '10000', kind: 'group' as const, externalId: '123',
  }
  const tool = createSendMessageTool({
    conversations: {
      ...conversations,
      getCurrent: () => qqTarget,
      async resolveCurrent() { return { ok: true, target: qqTarget } },
    },
    targetPolicy: { async authorize() { return { allowed: true } } },
    delivery: { async send() { return { status: 'failed', code: 'send_failed' } } },
    groupMuteInspector: {
      async inspect() { return { muted: true, mutedUntil: '2026-08-21T12:00:00+08:00' } },
    },
  })
  const result = await tool.execute({ message: 'hello', work: { state: 'none' } }, ctx)
  assert.deepEqual(JSON.parse(result.content as string), {
    ok: false,
    actionId: JSON.parse(result.content as string).actionId,
    status: 'failed',
    target: qqTarget,
    mode: 'ambient',
    providerMessageId: null,
    code: 'group_muted',
    error: 'QQ group is muted until 2026-08-21T12:00:00+08:00',
  })
})
