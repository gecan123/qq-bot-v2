import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { restTool } from './rest.js'
import { InMemoryEventQueue } from '../event-queue.js'
import type { BotEvent } from '../event.js'
import type { ToolContext } from '../tool.js'

function makeCtx(): { ctx: ToolContext; queue: InMemoryEventQueue<BotEvent> } {
  const queue = new InMemoryEventQueue<BotEvent>()
  return { ctx: { eventQueue: queue, roundIndex: 0 }, queue }
}

function groupEvent(overrides: Partial<Extract<BotEvent, { type: 'napcat_message' }>> = {}): BotEvent {
  return {
    type: 'napcat_message',
    messageRowId: 1,
    groupId: 100,
    messageId: 200,
    senderId: 300,
    senderNickname: '群友',
    mentionedSelf: false,
    sentAt: new Date('2026-06-17T08:00:00.000Z'),
    renderedText: 'hello',
    ...overrides,
  }
}

function privateEvent(): BotEvent {
  return {
    type: 'napcat_private_message',
    messageRowId: 2,
    peerId: 400,
    messageId: 500,
    senderId: 400,
    senderNickname: '朋友',
    mentionedSelf: true,
    sentAt: new Date('2026-06-17T08:00:01.000Z'),
    renderedText: '醒醒',
  }
}

describe('rest tool', () => {
  test('schema defaults to 30 seconds', () => {
    const parsed = restTool.schema.safeParse({})
    assert.equal(parsed.success, true)
    const data = parsed.data as { durationSeconds: number }
    assert.equal(data.durationSeconds, 30)
  })

  test('already queued mentioned group message interrupts rest without consuming the event', async () => {
    const { ctx, queue } = makeCtx()
    queue.enqueue(groupEvent({ mentionedSelf: true }))

    const result = await restTool.execute({ durationSeconds: 30 }, ctx)

    assert.match(result.content as string, /\[休息被打断\]/)
    assert.equal(queue.size(), 1)
  })

  test('already queued private message interrupts rest without consuming the event', async () => {
    const { ctx, queue } = makeCtx()
    queue.enqueue(privateEvent())

    const result = await restTool.execute({ durationSeconds: 30 }, ctx)

    assert.match(result.content as string, /\[休息被打断\]/)
    assert.equal(queue.size(), 1)
  })

  test('plain group message does not interrupt rest', async () => {
    const { ctx, queue } = makeCtx()
    queue.enqueue(groupEvent({ mentionedSelf: false }))

    const result = await Promise.race([
      restTool.execute({ durationSeconds: 30 }, ctx).then(() => 'returned' as const),
      tickMicrotasks().then(() => 'pending' as const),
    ])

    assert.equal(result, 'pending')
    assert.equal(queue.size(), 1)
  })
})

function tickMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}
