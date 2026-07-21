import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { BotEvent } from './event.js'
import { BOOTSTRAP_TEXT, CURIOSITY_TICK_TEXT, renderBotEvent } from './render-event.js'

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
        event: 'notification',
        id: `schedule:schedule-${scheduleKind}:2`,
        source: { type: 'schedule', scheduleId: `schedule-${scheduleKind}` },
        kind: 'schedule_due',
        priority: 'normal',
        delivery: 'interrupt',
        groupKey: `schedule:schedule-${scheduleKind}`,
        count: 1,
        occurredAt: '2026-07-12T08:01:00.000+08:00',
        open: {
          tool: 'schedule',
          args: {
            action: 'get_occurrence',
            scheduleId: `schedule-${scheduleKind}`,
            runCount: 2,
          },
        },
        data: {
          name: '任务检查',
          scheduleKind,
          scheduledFor: '2026-07-12T08:01:00.000+08:00',
          runCount: 2,
        },
      })
      assert.doesNotMatch(first!, /重新评估当前任务是否需要继续/)
    }
  })

  test('renders stable structured context with an explicit Beijing timestamp', () => {
    const rendered = renderBotEvent({
        type: 'scheduled_wake',
        scheduleId: 'schedule-1',
        name: '任务检查',
        scheduleKind: 'cron',
        scheduledFor: new Date('2026-07-12T00:01:00.000Z'),
        intention: '重新评估当前任务是否需要继续',
        runCount: 2,
      })
    const payload = JSON.parse(rendered!)
    assert.equal(payload.occurredAt, '2026-07-12T08:01:00.000+08:00')
    assert.deepEqual(payload.open, {
      tool: 'schedule',
      args: { action: 'get_occurrence', scheduleId: 'schedule-1', runCount: 2 },
    })
  })
})

describe('renderBotEvent — group messages', () => {
  test('renders a metadata-only interrupt notification for a mention', () => {
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
    const payload = JSON.parse(out!)
    assert.equal(payload.event, 'notification')
    assert.equal(payload.delivery, 'interrupt')
    assert.equal(payload.priority, 'high')
    assert.equal(payload.data.qqSource.groupName, '阳光厨房')
    assert.doesNotMatch(out!, /在吗|一只猫|张三/)
  })

  test('renders a passive metadata notification for an ordinary group message', () => {
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
    const payload = JSON.parse(out!)
    assert.equal(payload.delivery, 'passive')
    assert.equal(payload.priority, 'normal')
    assert.doesNotMatch(out!, /吃了吗|李四/)
  })
})

describe('renderBotEvent — private messages', () => {
  test('renders a metadata-only interrupt notification', () => {
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
    const payload = JSON.parse(out!)
    assert.equal(payload.delivery, 'interrupt')
    assert.deepEqual(payload.open, {
      tool: 'inbox',
      args: { action: 'read', source: 'private', peerId: 10001, afterRowId: 9 },
    })
    assert.doesNotMatch(out!, /在不|50000/)
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
      event: 'notification',
      id: 'background_task:task-7:completed',
      source: { type: 'background_task', taskId: 'task-7', toolName: 'generate_image' },
      kind: 'background_task_completed',
      priority: 'normal',
      delivery: 'interrupt',
      groupKey: 'background_task:task-7',
      count: 1,
      open: { tool: 'background_task', args: { action: 'get', taskId: 'task-7' } },
      data: { status: 'completed', elapsedMs: 1234 },
    })
    assert.doesNotMatch(first!, /生成犬娘图片|图片已生成/)
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
