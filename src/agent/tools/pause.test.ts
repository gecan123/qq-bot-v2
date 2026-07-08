import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { createPauseTool, pauseTool } from './pause.js'
import { InMemoryEventQueue } from '../event-queue.js'
import type { BotEvent } from '../event.js'
import type { ToolContext } from '../tool.js'

function makeCtx(): { ctx: ToolContext; queue: InMemoryEventQueue<BotEvent> } {
  const queue = new InMemoryEventQueue<BotEvent>()
  return { ctx: { eventQueue: queue, roundIndex: 0 }, queue }
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

describe('pause tool', () => {
  test('schema only accepts rest action', () => {
    assert.equal(pauseTool.schema.safeParse({ action: 'wait' }).success, false)
    assert.equal(pauseTool.schema.safeParse({ action: 'rest' }).success, false)

    const rest = pauseTool.schema.safeParse({ action: 'rest', intention: '醒来后继续看论文' })
    assert.equal(rest.success, true)
    assert.equal((rest.data as { durationSeconds: number }).durationSeconds, 300)
    assert.equal(pauseTool.schema.safeParse({
      action: 'rest',
      intention: '继续想',
      durationSeconds: 29,
    }).success, false)
    assert.equal(pauseTool.schema.safeParse({
      action: 'rest',
      intention: '继续想',
      durationSeconds: 1_801,
    }).success, false)
  })

  test('description no longer advertises wait or idle hints', () => {
    const tool = createPauseTool()
    assert.doesNotMatch(tool.description, /action=wait|空闲提示|长时间无事件/)
  })

  test('description prioritizes finding something to do after rest', () => {
    const tool = createPauseTool()
    assert.match(tool.description, /醒来后优先找事做/)
    assert.match(tool.description, /仍然没有真实锚点或任务时才继续休息/)
  })

  test('action=rest delegates to rest behavior', async () => {
    const { ctx, queue } = makeCtx()
    queue.enqueue(privateEvent())

    const result = await pauseTool.execute({
      action: 'rest',
      durationSeconds: 30,
      intention: '醒来后继续整理群聊线索',
    }, ctx)

    const content = JSON.parse(result.content as string) as {
      ok: boolean
      status: string
      durationSeconds: number
      elapsedMs: number
      intention: string
    }
    assert.deepEqual({ ...content, elapsedMs: 0 }, {
      ok: true,
      status: 'interrupted',
      durationSeconds: 30,
      elapsedMs: 0,
      intention: '醒来后继续整理群聊线索',
    })
    assert.equal(Number.isInteger(content.elapsedMs), true)
    assert.equal(content.elapsedMs >= 0, true)
    assert.equal(content.elapsedMs < 100, true)
    assert.deepEqual(result.outcome, { ok: true, code: 'interrupted' })
    assert.deepEqual(result.control, { type: 'pause' })
    assert.equal(queue.size(), 1)
  })
})
