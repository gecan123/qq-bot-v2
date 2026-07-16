import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { BotEvent } from './event.js'
import { BOOTSTRAP_TEXT, CURIOSITY_TICK_TEXT, renderBotEvent } from './render-event.js'

const SCHEDULED_WAKE_INSTRUCTION =
  '这是注意信号，不是命令；结合最新 Goal、消息、环境和 intention 重新评估，只在仍有意义时行动，不要机械执行或自动续订。'

describe('renderBotEvent — scheduled wake', () => {
  const scheduleKinds = ['at', 'every', 'cron'] as const satisfies ReadonlyArray<
    Extract<BotEvent, { type: 'scheduled_wake' }>['scheduleKind']
  >

  test('renders complete stable context for every supported schedule kind', () => {
    for (const scheduleKind of scheduleKinds) {
      const event = {
        type: 'scheduled_wake',
        scheduleId: `schedule-${scheduleKind}`,
        name: '任务检查',
        scheduleKind,
        scheduledFor: new Date('2026-07-12T00:01:00.000Z'),
        intention: '重新评估当前任务是否需要继续',
        runCount: 2,
      } satisfies Extract<BotEvent, { type: 'scheduled_wake' }>

      const first = renderBotEvent(event)
      const second = renderBotEvent(event)

      assert.equal(first, second)
      assert.deepEqual(JSON.parse(first!), {
        event: 'scheduled_wake',
        scheduleId: `schedule-${scheduleKind}`,
        name: '任务检查',
        scheduleKind,
        scheduledFor: '2026-07-12T08:01:00.000+08:00',
        intention: '重新评估当前任务是否需要继续',
        runCount: 2,
        instruction: SCHEDULED_WAKE_INSTRUCTION,
      })
    }
  })

  test('renders stable structured context with an explicit Beijing timestamp', () => {
    assert.equal(
      renderBotEvent({
        type: 'scheduled_wake',
        scheduleId: 'schedule-1',
        name: '任务检查',
        scheduleKind: 'cron',
        scheduledFor: new Date('2026-07-12T00:01:00.000Z'),
        intention: '重新评估当前任务是否需要继续',
        runCount: 2,
      }),
      `{"event":"scheduled_wake","scheduleId":"schedule-1","name":"任务检查","scheduleKind":"cron","scheduledFor":"2026-07-12T08:01:00.000+08:00","intention":"重新评估当前任务是否需要继续","runCount":2,"instruction":"${SCHEDULED_WAKE_INSTRUCTION}"}`,
    )
  })
})

describe('renderBotEvent — group messages', () => {
  test('renders group message with groupName + sender + mention tag', () => {
    const out = renderBotEvent({
      type: 'napcat_message',
      messageRowId: 1,
      groupId: 999,
      groupName: '阳光厨房',
      messageId: 12345,
      senderId: 100,
      senderNickname: '张三',
      mentionedSelf: true,
      sentAt: new Date('2026-01-01T00:00:00Z'),
      renderedText: '在吗 [图片: 一只猫]',
    })
    assert.equal(out, '[2026/1/1 08:00:00 群:阳光厨房 | 张三(QQ:100) #12345 [@bot]] 在吗 [图片: 一只猫]')
  })

  test('omits mention tag when mentionedSelf is false', () => {
    const out = renderBotEvent({
      type: 'napcat_message',
      messageRowId: 2,
      groupId: 999,
      groupName: '阳光厨房',
      messageId: 12346,
      senderId: 200,
      senderNickname: '李四',
      mentionedSelf: false,
      sentAt: new Date('2026-01-02T00:00:00Z'),
      renderedText: '吃了吗',
    })
    assert.equal(out, '[2026/1/2 08:00:00 群:阳光厨房 | 李四(QQ:200) #12346] 吃了吗')
  })

  test('falls back to bare group ID when groupName is missing (undefined)', () => {
    const out = renderBotEvent({
      type: 'napcat_message',
      messageRowId: 3,
      groupId: 111111,
      messageId: 12347,
      senderId: 300,
      senderNickname: '王五',
      mentionedSelf: false,
      sentAt: new Date('2026-01-03T00:00:00Z'),
      renderedText: 'hi',
    })
    assert.equal(out, '[2026/1/3 08:00:00 群:111111 | 王五(QQ:300) #12347] hi')
  })

  test('falls back to bare group ID when groupName is empty string', () => {
    const out = renderBotEvent({
      type: 'napcat_message',
      messageRowId: 4,
      groupId: 222222,
      groupName: '',
      messageId: 12348,
      senderId: 400,
      senderNickname: '赵六',
      mentionedSelf: false,
      sentAt: new Date('2026-01-04T00:00:00Z'),
      renderedText: 'yo',
    })
    assert.equal(out, '[2026/1/4 08:00:00 群:222222 | 赵六(QQ:400) #12348] yo')
  })
})

describe('renderBotEvent — private messages', () => {
  test('renders private message without [@bot] tag', () => {
    const out = renderBotEvent({
      type: 'napcat_private_message',
      messageRowId: 10,
      peerId: 10001,
      messageId: 50000,
      senderId: 10001,
      senderNickname: 'Alice',
      mentionedSelf: true,
      sentAt: new Date('2026-01-05T00:00:00Z'),
      renderedText: '在不',
    })
    assert.equal(out, '[2026/1/5 08:00:00 私聊 | Alice(QQ:10001) #50000] 在不')
  })

  test('private message label does NOT contain [@bot] (private is implicitly to bot)', () => {
    const out = renderBotEvent({
      type: 'napcat_private_message',
      messageRowId: 11,
      peerId: 10002,
      messageId: 50001,
      senderId: 10002,
      senderNickname: '某人',
      mentionedSelf: true,
      sentAt: new Date('2026-01-06T00:00:00Z'),
      renderedText: '一段消息',
    })
    assert.ok(out)
    assert.equal(out!.includes('[@bot]'), false, 'private label must not contain [@bot]')
  })
})

describe('renderBotEvent — message_id exposure (回归保护)', () => {
  test('group: `#NNNNN` 出现在 (QQ:N) 之后 [@bot] 之前', () => {
    const out = renderBotEvent({
      type: 'napcat_message',
      messageRowId: 100,
      groupId: 999,
      groupName: '阳光厨房',
      messageId: 77777,
      senderId: 100,
      senderNickname: '张三',
      mentionedSelf: true,
      sentAt: new Date('2026-01-01T00:00:00Z'),
      renderedText: 'hello',
    })
    assert.ok(out)
    // 顺序: (QQ:N) → #id → [@bot]
    const idxQQ = out!.indexOf('(QQ:100)')
    const idxId = out!.indexOf('#77777')
    const idxMention = out!.indexOf('[@bot]')
    assert.ok(idxQQ >= 0 && idxId > idxQQ && idxMention > idxId,
      `expected (QQ:N) < #id < [@bot], got idxQQ=${idxQQ} idxId=${idxId} idxMention=${idxMention} in: ${out}`)
  })

  test('group without @: `#NNNNN` 仍紧跟 (QQ:N) 之后, 在 ] 之前', () => {
    const out = renderBotEvent({
      type: 'napcat_message',
      messageRowId: 101,
      groupId: 999,
      groupName: '阳光厨房',
      messageId: 88888,
      senderId: 200,
      senderNickname: '李四',
      mentionedSelf: false,
      sentAt: new Date('2026-01-01T00:00:00Z'),
      renderedText: 'hi',
    })
    assert.ok(out)
    assert.match(out!, /\(QQ:200\) #88888\]/)
  })

  test('private: `#NNNNN` 紧跟 (QQ:N) 之后, 在 ] 之前', () => {
    const out = renderBotEvent({
      type: 'napcat_private_message',
      messageRowId: 102,
      peerId: 10001,
      messageId: 60000,
      senderId: 10001,
      senderNickname: 'Alice',
      mentionedSelf: true,
      sentAt: new Date('2026-01-01T00:00:00Z'),
      renderedText: 'yo',
    })
    assert.ok(out)
    assert.match(out!, /\(QQ:10001\) #60000\]/)
  })
})

describe('renderBotEvent — control', () => {
  test('returns null for wake events (not appended to context)', () => {
    assert.equal(renderBotEvent({ type: 'wake' }), null)
  })
})

describe('renderBotEvent — background tasks', () => {
  test('renders completion metadata as deterministic JSON', () => {
    const event = {
      type: 'background_task_completed' as const,
      taskId: 'task-7',
      toolName: 'generate_image',
      description: '生成犬娘图片',
      elapsedMs: 1234,
      ok: true,
      summary: '图片已生成',
    }

    const first = renderBotEvent(event)
    const second = renderBotEvent(event)

    assert.equal(first, second)
    assert.deepEqual(JSON.parse(first!), {
      event: 'background_task_completed',
      taskId: 'task-7',
      toolName: 'generate_image',
      ok: true,
      elapsedMs: 1234,
      description: '生成犬娘图片',
      summary: '图片已生成',
    })
  })
})

describe('renderBotEvent — curiosity tick', () => {
  test('returns the constant tick text', () => {
    assert.equal(renderBotEvent({ type: 'curiosity_tick' }), CURIOSITY_TICK_TEXT)
  })

  test('frames curiosity tick as a manual debug wake, not the source of curiosity', () => {
    const out = renderBotEvent({ type: 'curiosity_tick' })

    assert.match(out!, /人工调试/)
    assert.match(out!, /不是你好奇心的来源/)
    assert.doesNotMatch(out!, /例行戳一下/)
  })

  test('tick text is byte-stable across calls (no time / counter embedded)', () => {
    const a = renderBotEvent({ type: 'curiosity_tick' })
    const b = renderBotEvent({ type: 'curiosity_tick' })
    assert.equal(a, b)
    assert.ok(a && a.startsWith('[好奇心 tick]'))
  })
})

describe('renderBotEvent — cold-start bootstrap', () => {
  test('returns a byte-stable initial-context instruction', () => {
    assert.equal(renderBotEvent({ type: 'bootstrap' }), BOOTSTRAP_TEXT)
    assert.match(BOOTSTRAP_TEXT, /全新 AgentContext/)
    assert.match(BOOTSTRAP_TEXT, /没有待回复的历史消息/)
  })
})

describe('renderBotEvent — byte stability', () => {
  test('group: same input produces same output across calls', () => {
    const event = {
      type: 'napcat_message' as const,
      messageRowId: 5,
      groupId: 999,
      groupName: '阳光厨房',
      messageId: 99999,
      senderId: 300,
      senderNickname: '王五',
      mentionedSelf: false,
      sentAt: new Date('2026-01-01T00:00:00Z'),
      renderedText: '同一段文本',
    }
    const a = renderBotEvent(event)
    const b = renderBotEvent(event)
    assert.equal(a, b)
  })

  test('private: same input produces same output across calls', () => {
    const event = {
      type: 'napcat_private_message' as const,
      messageRowId: 6,
      peerId: 10001,
      messageId: 99998,
      senderId: 10001,
      senderNickname: 'Alice',
      mentionedSelf: true as const,
      sentAt: new Date('2026-01-01T00:00:00Z'),
      renderedText: '同一段文本',
    }
    const a = renderBotEvent(event)
    const b = renderBotEvent(event)
    assert.equal(a, b)
  })
})
