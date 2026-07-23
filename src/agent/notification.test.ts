import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { BotEvent } from './event.js'
import { shouldQueueChatEvent } from './event.js'
import {
  isAttentionEvent,
  notificationRoutingForEvent,
  renderNotificationEnvelope,
} from './notification.js'

describe('notification envelope', () => {
  test('rejects invalid envelope counts', () => {
    const input = {
      id: 'background_task:bg-1:completed',
      source: { type: 'background_task', taskId: 'bg-1' },
      kind: 'background_task_completed',
      priority: 'normal' as const,
      delivery: 'interrupt' as const,
      groupKey: 'background_task:bg-1',
      count: 1,
      open: { tool: 'background_task', args: { action: 'get', taskId: 'bg-1' } },
    }
    assert.throws(
      () => renderNotificationEnvelope({ ...input, count: 0 }),
      /positive safe integer/,
    )
  })

  test('separates importance from interruption', () => {
    const ordinaryGroup = {
      type: 'napcat_message',
      messageRowId: 1,
      groupId: 2,
      messageId: 3,
      senderId: 4,
      senderNickname: 'sender',
      mentionedSelf: false,
      sentAt: new Date('2026-07-22T00:00:00Z'),
      renderedText: 'body',
    } satisfies BotEvent
    const completedTask = {
      type: 'background_task_completed',
      taskId: 'bg-1',
      toolName: 'fetch_content',
      description: 'body',
      elapsedMs: 1,
      ok: true,
      summary: 'body',
    } satisfies BotEvent

    assert.deepEqual(notificationRoutingForEvent(ordinaryGroup), {
      priority: 'normal',
      delivery: 'passive',
    })
    assert.deepEqual(notificationRoutingForEvent(completedTask), {
      priority: 'normal',
      delivery: 'interrupt',
    })
    assert.equal(isAttentionEvent(ordinaryGroup), false)
    assert.equal(isAttentionEvent(completedTask), true)
    assert.equal(isAttentionEvent({ type: 'wake' }), true)
    assert.equal(shouldQueueChatEvent(ordinaryGroup, new Set()), false)
    assert.equal(shouldQueueChatEvent(ordinaryGroup, new Set([2])), true)
  })
})
