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
  })

  const result = await tool.execute({
    message: ' 收到 ', reply_to: 'om_parent', work: { state: 'none' },
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
