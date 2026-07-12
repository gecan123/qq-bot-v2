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
    assert.equal((rest.data as { durationSeconds: number }).durationSeconds, 60)
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
    assert.match(tool.description, /醒来后优先按 intention 选择并尝试/)
    assert.match(tool.description, /没有实际尝试前不要立刻再次休息/)
  })

  test('description frames intention as flexible options', () => {
    const tool = createPauseTool()
    assert.match(tool.description, /4 到 8 个具体可执行方向/)
    assert.match(tool.description, /选择并尝试一个、合并几个或改道/)
    assert.match(tool.description, /不要只列等待外部消息/)
    assert.match(tool.description, /至少两个能立即用现有工具开始/)
    assert.match(tool.description, /继续看.*占位句/)
    assert.match(tool.description, /不是“今天全部完成”.*不要回顾已完成清单.*醒来后真能开始的新方向/)
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
      resumeGuidance: string
    }
    assert.deepEqual({ ...content, elapsedMs: 0 }, {
      ok: true,
      status: 'interrupted',
      durationSeconds: 30,
      elapsedMs: 0,
      intention: '醒来后继续整理群聊线索',
      resumeGuidance: '醒来后先从 intention 里选择并尝试一个具体方向; 没有实际尝试前不要立刻再次休息.',
    })
    assert.equal(Number.isInteger(content.elapsedMs), true)
    assert.equal(content.elapsedMs >= 0, true)
    assert.equal(content.elapsedMs < 100, true)
    assert.deepEqual(result.outcome, { ok: true, code: 'interrupted' })
    assert.deepEqual(result.effects, [{ type: 'pause' }])
    assert.equal(queue.size(), 1)
  })
})
