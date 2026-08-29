import assert from 'node:assert/strict'
import { test } from 'node:test'
import { napcat } from '../bot/napcat.js'
import { sendGroupReply, sendPrivateMessage, type NapcatSegment } from './napcat-sender.js'

test('QQ group egress sends long pure text as node-only folded content', async (t) => {
  const calls: unknown[] = []
  t.mock.method(napcat, 'send_group_msg', async (params: unknown) => {
    calls.push(params)
    return { message_id: 42 }
  })

  const result = await sendGroupReply(20000, [
    { type: 'text', data: { text: '长文本。'.repeat(500) } },
  ])

  assert.deepEqual(result, { success: true, attempts: 1, providerMessageId: 42 })
  const sent = calls[0] as { group_id: number; message: Array<{ type: string }> }
  assert.equal(sent.group_id, 20000)
  assert.ok(sent.message.length > 1)
  assert.ok(sent.message.every((segment) => segment.type === 'node'))
})

test('QQ private egress also folds long pure text', async (t) => {
  const calls: unknown[] = []
  t.mock.method(napcat, 'send_private_msg', async (params: unknown) => {
    calls.push(params)
    return { message_id: 43 }
  })

  await sendPrivateMessage(30000, [
    { type: 'text', data: { text: '长文本。'.repeat(500) } },
  ])

  const sent = calls[0] as { user_id: number; message: Array<{ type: string }> }
  assert.equal(sent.user_id, 30000)
  assert.ok(sent.message.every((segment) => segment.type === 'node'))
})

test('QQ egress preserves reply segments instead of folding mixed content', async (t) => {
  const calls: unknown[] = []
  t.mock.method(napcat, 'send_group_msg', async (params: unknown) => {
    calls.push(params)
    return { message_id: 44 }
  })
  const original: NapcatSegment[] = [
    { type: 'reply', data: { id: '1' } },
    { type: 'text', data: { text: '长文本。'.repeat(500) } },
  ]

  await sendGroupReply(20000, original)

  const sent = calls[0] as { message: unknown[] }
  assert.deepEqual(sent.message, original)
})
