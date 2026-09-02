import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { ConversationRef } from '../../chat/conversation.js'
import { InMemoryEventQueue } from '../event-queue.js'
import type { BotEvent } from '../event.js'
import {
  createConversationController,
  createConversationTool,
  type ConversationFocusState,
} from './conversation.js'

describe('conversation focus', () => {
  test('opens only directory-backed QQ or Feishu conversations explicitly', async () => {
    let focus: ConversationRef | null = null
    const state: ConversationFocusState = {
      get: () => focus,
      set: (next) => { focus = next },
    }
    const qq = {
      platform: 'qq' as const,
      accountId: '10000',
      kind: 'group' as const,
      externalId: '20000',
    }
    const feishu = {
      platform: 'feishu' as const,
      accountId: 'cli_1',
      kind: 'private' as const,
      externalId: 'oc_owner',
    }
    const controller = createConversationController({
      state,
      loadConversations: async () => [
        { target: qq, displayName: 'QQ群' },
        { target: feishu, displayName: '主人' },
      ],
    })

    assert.equal(controller.getCurrent(), null)
    assert.deepEqual(await controller.open(feishu), { ok: true, current: feishu })
    assert.deepEqual(controller.getCurrent(), feishu)
    assert.deepEqual(await controller.open({ ...qq, externalId: 'not-allowed' }), {
      ok: false,
      code: 'CHAT_TARGET_UNAVAILABLE',
      current: feishu,
    })
    assert.deepEqual(controller.getCurrent(), feishu)
  })

  test('parks instead of retrying when close finds no active focus', async () => {
    let focus: ConversationRef | null = null
    const controller = createConversationController({
      state: {
        get: () => focus,
        set: (next) => { focus = next },
      },
      loadConversations: async () => [],
    })
    const tool = createConversationTool(controller)
    assert.match(tool.description, /close 只清除会话焦点.*不停止 Runtime/)

    const result = await tool.execute({ action: 'close' }, {
      eventQueue: new InMemoryEventQueue<BotEvent>(),
      roundIndex: 1,
    })

    assert.deepEqual(JSON.parse(result.content as string), {
      ok: true,
      action: 'close',
      current: null,
    })
    assert.deepEqual(result.outcome, {
      ok: true,
      code: 'unchanged',
      progress: false,
      continuation: 'wait_attention',
    })
  })

  test('focus changes control continuation without counting as work progress', async () => {
    let focus: ConversationRef | null = null
    const target = {
      platform: 'qq' as const,
      accountId: '10000',
      kind: 'private' as const,
      externalId: '20000',
    }
    const tool = createConversationTool(createConversationController({
      state: { get: () => focus, set: (next) => { focus = next } },
      loadConversations: async () => [{ target, displayName: '主人' }],
    }))
    const ctx = { eventQueue: new InMemoryEventQueue<BotEvent>(), roundIndex: 1 }

    assert.deepEqual((await tool.execute({ action: 'open', target }, ctx)).outcome, {
      ok: true, code: 'opened', progress: false, continuation: 'immediate',
    })
    assert.deepEqual((await tool.execute({ action: 'close' }, ctx)).outcome, {
      ok: true, code: 'closed', progress: false, continuation: 'wait_attention',
    })
  })
})
