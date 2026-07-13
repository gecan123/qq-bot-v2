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
  primaryDirection: '查一篇具体论文的最新进展并读摘要',
  alternativeDirection: '挑一篇群友新文章读完第一节',
}

describe('pause tool', () => {
  test('schema only accepts rest action', () => {
    assert.equal(pauseTool.schema.safeParse({ action: 'wait' }).success, false)
    assert.equal(pauseTool.schema.safeParse({ action: 'rest' }).success, false)

    const rest = pauseTool.schema.safeParse({ action: 'rest', reason: '现在确实想短暂放空', intention })
    assert.equal(rest.success, true)
    assert.equal((rest.data as { durationSeconds: number }).durationSeconds, 60)
    assert.equal((rest.data as { confirmed: boolean }).confirmed, false)
    assert.equal(pauseTool.schema.safeParse({
      action: 'rest',
      reason: '短暂放空',
      intention: { ...intention, alternativeDirection: intention.primaryDirection },
    }).success, false)
    assert.equal(pauseTool.schema.safeParse({
      action: 'rest',
      reason: '短暂放空',
      intention: {
        ...intention,
        primaryDirection: '等 zzz 私聊',
      },
    }).success, false)
    assert.equal(pauseTool.schema.safeParse({
      action: 'rest',
      reason: '短暂放空',
      intention: {
        ...intention,
        primaryDirection: '检查SOL价格',
      },
    }).success, false)
    assert.equal(pauseTool.schema.safeParse({
      action: 'rest',
      reason: '短暂放空',
      intention: {
        ...intention,
        primaryDirection: '整理memory',
      },
    }).success, false)
    assert.equal(pauseTool.schema.safeParse({
      action: 'rest',
      reason: '短暂放空',
      intention: { ...intention, primaryDirection: '浏览HN' },
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
      durationSeconds: 301,
    }).success, false)
  })

  test('description no longer advertises wait or idle hints', () => {
    const tool = createPauseTool()
    assert.doesNotMatch(tool.description, /action=wait|空闲提示|长时间无事件/)
  })

  test('description prioritizes finding something to do after rest', () => {
    const tool = createPauseTool()
    assert.match(tool.description, /alternative_available/)
    assert.match(tool.description, /confirmed=true/)
    assert.match(tool.description, /没有实际尝试醒后方向前不要立刻再次休息/)
  })

  test('description frames intention as two concrete directions', () => {
    const tool = createPauseTool()
    assert.match(tool.description, /primaryDirection.*alternativeDirection/)
    assert.match(tool.description, /不要制造六项菜单/)
    assert.match(tool.description, /机械盯行情/)
    assert.match(tool.description, /未来时点再看行情用 schedule/)
    assert.match(tool.description, /不是“今天全部完成”/)
  })

  test('action=rest delegates to rest behavior', async () => {
    const { ctx, queue } = makeCtx()
    queue.enqueue(privateEvent())

    const result = await pauseTool.execute({
      action: 'rest',
      durationSeconds: 30,
      confirmed: false,
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
        primaryDirection: string
        alternativeDirection: string
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
        primaryDirection: intention.primaryDirection,
        alternativeDirection: intention.alternativeDirection,
        instruction: `现在先实际执行 primaryDirection 的第一步: ${intention.primaryDirection}; 若现场情况变化或它已失去吸引力, 改做 alternativeDirection: ${intention.alternativeDirection}. 没有实际尝试前不要再次休息.`,
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
