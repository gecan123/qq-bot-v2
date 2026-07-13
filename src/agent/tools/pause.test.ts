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

const intention = {
  preferredIndex: 0,
  immediateDirections: [
    '查一篇具体论文的最新进展',
    '用现有行情工具复核 SOL 观察记录',
    '回看 journal 里的未完阅读线索',
    '只读检查一个最近改动的模块',
    '整理一条近期市场判断及失效条件',
    '挑一篇群友新文章读完第一节',
  ],
}

describe('pause tool', () => {
  test('schema only accepts rest action', () => {
    assert.equal(pauseTool.schema.safeParse({ action: 'wait' }).success, false)
    assert.equal(pauseTool.schema.safeParse({ action: 'rest' }).success, false)

    const rest = pauseTool.schema.safeParse({ action: 'rest', reason: '现在确实想短暂放空', intention })
    assert.equal(rest.success, true)
    assert.equal((rest.data as { durationSeconds: number }).durationSeconds, 60)
    assert.equal(pauseTool.schema.safeParse({
      action: 'rest',
      reason: '短暂放空',
      intention: { ...intention, preferredIndex: 6 },
    }).success, false)
    assert.equal(pauseTool.schema.safeParse({
      action: 'rest',
      reason: '短暂放空',
      intention: {
        ...intention,
        immediateDirections: ['重复方向', '重复方向', '第三个方向', '第四个方向', '第五个方向', '第六个方向'],
      },
    }).success, false)
    assert.equal(pauseTool.schema.safeParse({
      action: 'rest',
      reason: '短暂放空',
      intention: {
        ...intention,
        immediateDirections: ['等 zzz 私聊', ...intention.immediateDirections.slice(1)],
      },
    }).success, false)
    assert.equal(pauseTool.schema.safeParse({
      action: 'rest',
      reason: '短暂放空',
      intention: {
        ...intention,
        immediateDirections: ['看竞技场群回复', ...intention.immediateDirections.slice(1)],
      },
    }).success, false)
    assert.equal(pauseTool.schema.safeParse({
      action: 'rest',
      reason: '短暂放空',
      intention,
      durationSeconds: 29,
    }).success, false)
    assert.equal(pauseTool.schema.safeParse({
      action: 'rest',
      reason: '短暂放空',
      intention,
      durationSeconds: 1_801,
    }).success, false)
  })

  test('description no longer advertises wait or idle hints', () => {
    const tool = createPauseTool()
    assert.doesNotMatch(tool.description, /action=wait|空闲提示|长时间无事件/)
  })

  test('description prioritizes finding something to do after rest', () => {
    const tool = createPauseTool()
    assert.match(tool.description, /醒来后先执行 preferredIndex/)
    assert.match(tool.description, /没有实际尝试前不要立刻再次休息/)
  })

  test('description frames intention as flexible options', () => {
    const tool = createPauseTool()
    assert.match(tool.description, /immediateDirections 必须恰好列 6 个/)
    assert.match(tool.description, /改选其他方向、合并几个或改道/)
    assert.match(tool.description, /外部消息不是行动方向/)
    assert.match(tool.description, /不与做自己的事冲突/)
    assert.match(tool.description, /现在无需等待任何人就能开始/)
    assert.match(tool.description, /继续看.*占位句/)
    assert.match(tool.description, /不是“今天全部完成”.*不要回顾已完成清单.*醒来后真能开始的新方向/)
  })

  test('action=rest delegates to rest behavior', async () => {
    const { ctx, queue } = makeCtx()
    queue.enqueue(privateEvent())

    const result = await pauseTool.execute({
      action: 'rest',
      durationSeconds: 30,
      reason: '刚完成一段集中阅读，想短暂放空',
      intention,
    }, ctx)

    const content = JSON.parse(result.content as string) as {
      ok: boolean
      status: string
      durationSeconds: number
      elapsedMs: number
      restReason: string
      resumePlan: {
        preferredIndex: number
        preferredDirection: string
        immediateDirections: string[]
        instruction: string
      }
    }
    assert.deepEqual({ ...content, elapsedMs: 0 }, {
      ok: true,
      status: 'interrupted',
      durationSeconds: 30,
      elapsedMs: 0,
      restReason: '刚完成一段集中阅读，想短暂放空',
      resumePlan: {
        preferredIndex: intention.preferredIndex,
        preferredDirection: intention.immediateDirections[intention.preferredIndex],
        immediateDirections: intention.immediateDirections,
        instruction: `现在先实际执行 immediateDirections[${intention.preferredIndex}]: ${intention.immediateDirections[intention.preferredIndex]}; 外部消息可能随时到来并切换注意力, 与此同时照常推进自己的事. 可以按新情况改选其他 immediateDirections, 但没有实际尝试前不要再次休息.`,
      },
    })
    assert.equal(Number.isInteger(content.elapsedMs), true)
    assert.equal(content.elapsedMs >= 0, true)
    assert.equal(content.elapsedMs < 100, true)
    assert.deepEqual(result.outcome, { ok: true, code: 'interrupted' })
    assert.deepEqual(result.effects, [{ type: 'pause', status: 'interrupted' }])
    assert.equal(queue.size(), 1)
  })
})
