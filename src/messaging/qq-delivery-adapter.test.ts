import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { MessageSender } from './message-sender.js'
import { createQqDeliveryAdapter } from './qq-delivery-adapter.js'

test('QQ delivery adapter maps a generic group reply to NapCat segments', async () => {
  const calls: Parameters<MessageSender['sendSegments']>[0][] = []
  const sender: MessageSender = {
    async sendSegments(input) {
      calls.push(input)
      return { success: true, attempts: 1, providerMessageId: 42 }
    },
  }

  const result = await createQqDeliveryAdapter(sender).send({
    actionId: '36a18044-b44d-4cab-b907-c9f986bd146a',
    target: { platform: 'qq', accountId: '10000', kind: 'group', externalId: '20000' },
    text: '收到',
    replyToExternalId: '41',
    mentionExternalId: '30000',
  })

  assert.deepEqual(result, { status: 'sent', providerMessageId: '42' })
  assert.deepEqual(calls, [{
    target: { type: 'group', groupId: 20000 },
    segments: [
      { type: 'reply', data: { id: '41' } },
      { type: 'at', data: { qq: '30000' } },
      { type: 'text', data: { text: ' 收到' } },
    ],
  }])
})

test('QQ delivery adapter rejects malformed reply and mention identifiers', async () => {
  const sender: MessageSender = {
    async sendSegments() {
      assert.fail('malformed identifiers must not be sent')
    },
  }
  const adapter = createQqDeliveryAdapter(sender)
  const base = {
    actionId: '36a18044-b44d-4cab-b907-c9f986bd146a',
    target: { platform: 'qq' as const, accountId: '10000', kind: 'group' as const, externalId: '20000' },
    text: '收到',
  }

  assert.deepEqual(await adapter.send({ ...base, replyToExternalId: 'not-a-message' }), {
    status: 'failed', code: 'invalid_reply_id', error: 'QQ reply identifier must be a positive integer',
  })
  assert.deepEqual(await adapter.send({ ...base, mentionExternalId: 'not-a-user' }), {
    status: 'failed', code: 'invalid_mention_id', error: 'QQ mention identifier must be a positive integer',
  })
})
