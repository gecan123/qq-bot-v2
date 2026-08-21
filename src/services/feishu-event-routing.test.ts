import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  ConversationWorkQueue,
  classifyFeishuReceive,
  feishuGatewayHealth,
} from './feishu-event-routing.js'

test('classifies a repeated receive payload with a newer update time as an edit fact', () => {
  assert.deepEqual(classifyFeishuReceive({
    eventId: undefined, messageId: 'om_1', createTime: '1000', updateTime: '2000',
  }), { eventKind: 'edit', eventExternalId: 'edit:om_1:2000' })
  assert.deepEqual(classifyFeishuReceive({
    eventId: 'evt_1', messageId: 'om_1', createTime: '1000', updateTime: '1000',
  }), { eventKind: 'message', eventExternalId: 'evt_1' })
})

test('conversation work queue preserves order within a chat without blocking another chat', async () => {
  const queue = new ConversationWorkQueue()
  const order: string[] = []
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  queue.schedule('a', async () => { order.push('a1-start'); await gate; order.push('a1-end') })
  queue.schedule('a', async () => { order.push('a2') })
  queue.schedule('b', async () => { order.push('b1') })
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(order, ['a1-start', 'b1'])
  release()
  await queue.drain()
  assert.deepEqual(order, ['a1-start', 'b1', 'a1-end', 'a2'])
})

test('Feishu health is unavailable while the WebSocket is disconnected', () => {
  assert.deepEqual(feishuGatewayHealth(false, 'ou_bot'), {
    status: 503,
    body: { ok: false, connected: false, botOpenId: 'ou_bot' },
  })
  assert.deepEqual(feishuGatewayHealth(true, 'ou_bot'), {
    status: 200,
    body: { ok: true, connected: true, botOpenId: 'ou_bot' },
  })
})
