import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sendFeishuDelivery, type FeishuMessageApi } from './feishu-outbound.js'

test('Feishu outbound uses the stable action id and chat id for a text message', async () => {
  const calls: unknown[] = []
  const api: FeishuMessageApi = {
    async uploadImage() { throw new Error('unreachable') },
    async create(input) { calls.push(input); return { code: 0, messageId: 'om_sent' } },
    async reply() { throw new Error('unreachable') },
  }
  const result = await sendFeishuDelivery(api, {
    actionId: '2fc37bfe-5ca1-40b5-8ec5-8e195f5fe787',
    target: { platform: 'feishu', accountId: 'cli_1', kind: 'group', externalId: 'oc_1' },
    text: '你好',
  })
  assert.deepEqual(result, { status: 'sent', providerMessageId: 'om_sent' })
  assert.deepEqual(calls, [{
    receiveId: 'oc_1', receiveIdType: 'chat_id', msgType: 'text',
    content: JSON.stringify({ text: '你好' }), uuid: '2fc37bfe-5ca1-40b5-8ec5-8e195f5fe787',
  }])
})

test('Feishu outbound uploads an image and replies with a rich post containing mention', async () => {
  const replies: unknown[] = []
  const api: FeishuMessageApi = {
    async uploadImage(bytes) { assert.equal(bytes.toString(), 'image'); return 'img_1' },
    async create() { throw new Error('unreachable') },
    async reply(input) { replies.push(input); return { code: 0, messageId: 'om_reply' } },
  }
  const result = await sendFeishuDelivery(api, {
    actionId: 'action-2',
    target: { platform: 'feishu', accountId: 'cli_1', kind: 'private', externalId: 'oc_p2p' },
    text: '请看', imageBytes: Buffer.from('image'), mentionExternalId: 'ou_2',
    replyToExternalId: 'om_parent',
  })
  assert.equal(result.status, 'sent')
  assert.deepEqual(replies, [{
    messageId: 'om_parent', msgType: 'post', uuid: 'action-2',
    content: JSON.stringify({ zh_cn: { title: '', content: [[
      { tag: 'at', user_id: 'ou_2' }, { tag: 'text', text: '请看' },
      { tag: 'img', image_key: 'img_1' },
    ]] } }),
  }])
})

test('Feishu outbound distinguishes an explicit API rejection from ambiguous transport failure', async () => {
  const explicit: FeishuMessageApi = {
    async uploadImage() { throw new Error('unreachable') },
    async create() { return { code: 230013, message: 'bot is not in chat' } },
    async reply() { throw new Error('unreachable') },
  }
  const request = {
    actionId: 'a',
    target: { platform: 'feishu' as const, accountId: 'cli_1', kind: 'group' as const, externalId: 'oc_1' },
    text: 'x',
  }
  assert.deepEqual(await sendFeishuDelivery(explicit, request), {
    status: 'failed', code: '230013', error: 'bot is not in chat',
  })
  const ambiguous: FeishuMessageApi = {
    async uploadImage() { throw new Error('unreachable') },
    async create() { throw new Error('ECONNRESET') },
    async reply() { throw new Error('unreachable') },
  }
  assert.deepEqual(await sendFeishuDelivery(ambiguous, request), {
    status: 'delivery_unknown', code: 'transport_error', error: 'ECONNRESET',
  })
})
