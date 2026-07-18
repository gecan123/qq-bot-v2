import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { QqConversationFocus } from '../agent-context.types.js'
import type { ToolContext } from '../tool.js'
import type { BotEvent } from '../event.js'
import { InMemoryEventQueue } from '../event-queue.js'
import {
  createQqConversationController,
  createQqConversationTool,
  type QqConversationFocusState,
} from './qq-conversation.js'

function makeContext(): ToolContext {
  return { eventQueue: new InMemoryEventQueue<BotEvent>(), roundIndex: 0 }
}

function makeHarness() {
  let focus: QqConversationFocus = null
  let friends = [
    { userId: 2002, nickname: '好友', remark: '主人' },
  ]
  const state: QqConversationFocusState = {
    get: () => focus,
    set: (next) => { focus = next },
  }
  const controller = createQqConversationController({
    state,
    groupIds: [1001],
    loadGroups: async () => [
      { groupId: 9999, groupName: '未监听群' },
      { groupId: 1001, groupName: '测试群', groupRemark: '测试备注' },
    ],
    loadFriends: async () => friends,
  })
  return {
    controller,
    tool: createQqConversationTool(controller),
    getFocus: () => focus,
    removeFriend: () => { friends = [] },
  }
}

function parse(content: unknown): Record<string, unknown> {
  return JSON.parse(content as string) as Record<string, unknown>
}

describe('qq_conversation', () => {
  test('list returns joined monitored groups and current friends with stable targets', async () => {
    const { tool } = makeHarness()

    const result = await tool.execute({ action: 'list' }, makeContext())

    assert.deepEqual(parse(result.content), {
      ok: true,
      action: 'list',
      current: null,
      conversations: [
        {
          target: { type: 'group', groupId: 1001 },
          displayName: '测试备注',
        },
        {
          target: { type: 'private', userId: 2002 },
          displayName: '主人',
        },
      ],
    })
    assert.deepEqual(result.outcome, { ok: true, code: 'observed', progress: true })
    const repeated = await tool.execute({ action: 'list' }, makeContext())
    assert.deepEqual(repeated.outcome, { ok: true, code: 'unchanged', progress: false })
  })

  test('current is null before opening a conversation', async () => {
    const { tool } = makeHarness()

    const result = await tool.execute({ action: 'current' }, makeContext())

    assert.deepEqual(parse(result.content), {
      ok: true,
      action: 'current',
      current: null,
    })
    assert.deepEqual(result.outcome, { ok: true, code: 'observed', progress: true })
    const repeated = await tool.execute({ action: 'current' }, makeContext())
    assert.deepEqual(repeated.outcome, { ok: true, code: 'unchanged', progress: false })
  })

  test('open accepts a joined monitored group and a current friend', async () => {
    const { tool, getFocus } = makeHarness()

    const group = await tool.execute({
      action: 'open',
      target: { type: 'group', groupId: 1001 },
    }, makeContext())
    assert.deepEqual(parse(group.content), {
      ok: true,
      action: 'open',
      current: { type: 'group', groupId: 1001 },
    })
    assert.deepEqual(getFocus(), { type: 'group', groupId: 1001 })

    const friend = await tool.execute({
      action: 'open',
      target: { type: 'private', userId: 2002 },
    }, makeContext())
    assert.deepEqual(parse(friend.content), {
      ok: true,
      action: 'open',
      current: { type: 'private', userId: 2002 },
    })
    assert.deepEqual(getFocus(), { type: 'private', userId: 2002 })
    assert.deepEqual(friend.outcome, { ok: true, code: 'opened', progress: true })

    const repeated = await tool.execute({
      action: 'open',
      target: { type: 'private', userId: 2002 },
    }, makeContext())
    assert.deepEqual(repeated.outcome, { ok: true, code: 'unchanged', progress: false })
  })

  test('open rejects unavailable targets without changing the existing focus', async () => {
    const { controller, tool, getFocus } = makeHarness()
    await controller.open({ type: 'private', userId: 2002 })

    for (const target of [
      { type: 'group' as const, groupId: 9999 },
      { type: 'private' as const, userId: 9999 },
    ]) {
      const result = await tool.execute({ action: 'open', target }, makeContext())
      assert.deepEqual(parse(result.content), {
        ok: false,
        action: 'open',
        code: 'CHAT_TARGET_UNAVAILABLE',
        current: { type: 'private', userId: 2002 },
      })
      assert.deepEqual(getFocus(), { type: 'private', userId: 2002 })
    }
  })

  test('close clears the current focus', async () => {
    const { controller, tool, getFocus } = makeHarness()
    await controller.open({ type: 'group', groupId: 1001 })

    const result = await tool.execute({ action: 'close' }, makeContext())

    assert.deepEqual(parse(result.content), {
      ok: true,
      action: 'close',
      current: null,
    })
    assert.equal(getFocus(), null)
    assert.deepEqual(result.outcome, { ok: true, code: 'closed', progress: true })

    const repeated = await tool.execute({ action: 'close' }, makeContext())
    assert.deepEqual(repeated.outcome, { ok: true, code: 'unchanged', progress: false })
  })

  test('resolveCurrent clears a private focus after the friend disappears', async () => {
    const { controller, getFocus, removeFriend } = makeHarness()
    await controller.open({ type: 'private', userId: 2002 })
    removeFriend()

    assert.deepEqual(await controller.resolveCurrent(), {
      ok: false,
      code: 'CHAT_CONTEXT_STALE',
    })
    assert.equal(getFocus(), null)
    assert.deepEqual(await controller.resolveCurrent(), {
      ok: false,
      code: 'CHAT_CONTEXT_UNAVAILABLE',
    })
  })
})
