import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { ConversationRef } from '../../chat/conversation.js'
import {
  createConversationController,
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
})
