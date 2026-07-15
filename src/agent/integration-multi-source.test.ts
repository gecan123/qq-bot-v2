/**
 * End-to-end smoke test for MVP-2 multi-source flow:
 *
 *   group event A + private event from peer X + group event B
 *     → render-event labels each correctly
 *     → all QQ messages become priority-aware inbox notifications
 *     → LLM (mocked) produces a send_message tool call targeted at the right source
 *     → tool execution runs the send_message tool with whitelist validation
 *     → group/private cross-source events do NOT leak into each other
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { createAgentContext } from './agent-context.js'
import { InMemoryEventQueue } from './event-queue.js'
import type { BotEvent } from './event.js'
import { renderBotEvent } from './render-event.js'
import { createBotLoopAgent } from './bot-loop-agent.js'
import { createToolExecutor } from './tool.js'
import { createSendMessageTool } from './tools/send-message.js'
import type { LlmClient, LlmCallOutput } from './llm-client.js'
import { createTestAgentLedger } from './test-support/agent-ledger.js'
import type { MessageSender } from '../messaging/message-sender.js'
import type { SendNapcatResult } from '../messaging/napcat-sender.js'
import type { SendTargetPolicy } from './send-target-policy.js'

interface RecordedSend {
  fn: 'sendSegments'
  args: unknown
}

function makeMockSender(): { sender: MessageSender; calls: RecordedSend[] } {
  const calls: RecordedSend[] = []
  const ok: SendNapcatResult = { success: true, attempts: 1, providerMessageId: 99 }
  return {
    calls,
    sender: {
      async sendSegments(args) {
        calls.push({ fn: 'sendSegments', args })
        return ok
      },
    },
  }
}

const allowAllTargets: SendTargetPolicy = {
  async authorize() {
    return { allowed: true }
  },
}

function makeMockLlm(outputs: LlmCallOutput[]): LlmClient {
  let i = 0
  return {
    async chat() {
      const next = outputs[i] ?? outputs[outputs.length - 1]
      i++
      if (!next) throw new Error('mock LLM ran out of scripted outputs')
      return next
    },
  }
}

describe('MVP-2 integration: mixed group + private events through one agent loop', () => {
  test('three events render as distinct mailbox notifications and a successful send appends its handled marker', async () => {
    const ctx = createAgentContext()
    const eventQueue = new InMemoryEventQueue<BotEvent>()

    eventQueue.enqueue({
      type: 'napcat_message',
      messageRowId: 1,
      groupId: 111,
      groupName: '阳光厨房',
      messageId: 1001,
      senderId: 100,
      senderNickname: '张三',
      mentionedSelf: true,
      sentAt: new Date('2026-05-04T01:00:00Z'),
      renderedText: '在吗',
    })
    eventQueue.enqueue({
      type: 'napcat_private_message',
      messageRowId: 2,
      peerId: 10001,
      messageId: 2001,
      senderId: 10001,
      senderNickname: 'Alice',
      mentionedSelf: true,
      sentAt: new Date('2026-05-04T01:00:01Z'),
      renderedText: '私聊问个事',
    })
    eventQueue.enqueue({
      type: 'napcat_message',
      messageRowId: 3,
      groupId: 222,
      groupName: '技术群',
      messageId: 1002,
      senderId: 200,
      senderNickname: '李四',
      mentionedSelf: false,
      sentAt: new Date('2026-05-04T01:00:02Z'),
      renderedText: '今天天气好',
    })

    // LLM responds: emit a single send_message targeted at group 111 (replying to 张三)
    const llm = makeMockLlm([
      {
        content: '思考: 张三 @ 我了, 回他.',
        toolCalls: [
          {
            id: 'tc1',
            name: 'send_message',
            args: {
              target: { type: 'group', groupId: 111 },
              mode: 'reply',
              text: '在的',
              replyToMessageId: 1001,
            },
          },
        ],
        usage: { inputTokens: 100, cachedTokens: 80, outputTokens: 20 },
        model: 'mock',
        contextWindowTokens: 200_000,
      },
    ])

    const { sender, calls } = makeMockSender()
    const tools = createToolExecutor([
      createSendMessageTool({
        sender,
        targetPolicy: allowAllTargets,
      }),
    ])

    const ledger = createTestAgentLedger()
    const agent = createBotLoopAgent({
      systemPrompt: 'integration test',
      context: ctx,
      eventQueue,
      llm,
      tools,
      ledgerRepo: ledger.repo,
      ledgerLoader: ledger.loader,
      renderEvent: renderBotEvent,
      eventDebounceMs: 0,
    })

    await agent.runOnceForTest()

    const messages = ctx.getSnapshot().messages
    assert.deepEqual(messages.map((message) => message.role), [
      'user',
      'user',
      'user',
      'assistant',
      'tool',
      'user',
    ])

    const notificationMessages = messages.slice(0, 3)
    assert.ok(notificationMessages.every((message) => message.role === 'user'))
    const notifications = notificationMessages.map((message) => JSON.parse(message.content))
    assert.deepEqual(notifications.map(({ mailbox, priority }) => ({ mailbox, priority })), [
      { mailbox: 'qq_group:111', priority: 'high' },
      { mailbox: 'qq_private:10001', priority: 'high' },
      { mailbox: 'qq_group:222', priority: 'normal' },
    ])
    assert.equal(notifications[0]!.source.groupName, '阳光厨房')
    assert.equal(notifications[1]!.source.senderName, 'Alice')
    assert.equal(notifications[2]!.source.groupName, '技术群')
    assert.doesNotMatch(notificationMessages.map((message) => message.content).join('\n'), /在吗|私聊问个事|今天天气好/)

    const handledMarker = messages[5]
    assert.ok(handledMarker?.role === 'user')
    assert.deepEqual(JSON.parse(handledMarker.content), {
      event: 'mailbox_handled',
      mailbox: 'qq_group:111',
      throughRowId: 1,
    })

    // The send_message tool should have used the unified segment sender, scoped to group 111.
    assert.equal(calls.length, 1)
    assert.equal(calls[0]!.fn, 'sendSegments')
    const args = calls[0]!.args as { target: { type: string; groupId: number }; segments: Array<{ type: string; data: Record<string, unknown> }> }
    assert.deepEqual(args.target, { type: 'group', groupId: 111 })
    assert.equal(args.segments[0]?.type, 'reply')
    assert.equal(args.segments[0]?.data.id, '1001')
  })

  test('private target reaches sendPrivateMessage; group event in same batch does not leak into the private send', async () => {
    const ctx = createAgentContext()
    const eventQueue = new InMemoryEventQueue<BotEvent>()
    eventQueue.enqueue({
      type: 'napcat_message',
      messageRowId: 1,
      groupId: 111,
      groupName: '群A',
      messageId: 1,
      senderId: 100,
      senderNickname: 'GroupUser',
      mentionedSelf: false,
      sentAt: new Date(),
      renderedText: '群里有人说话',
    })
    eventQueue.enqueue({
      type: 'napcat_private_message',
      messageRowId: 2,
      peerId: 10001,
      messageId: 2,
      senderId: 10001,
      senderNickname: 'Alice',
      mentionedSelf: true,
      sentAt: new Date(),
      renderedText: '私聊问问题',
    })

    const llm = makeMockLlm([
      {
        content: '',
        toolCalls: [
          {
            id: 'tc1',
            name: 'send_message',
            args: {
              target: { type: 'private', userId: 10001 },
              mode: 'reply',
              text: '私聊回复',
              replyToMessageId: 2,
            },
          },
        ],
        usage: { inputTokens: 50, cachedTokens: 40, outputTokens: 10 },
        model: 'mock',
        contextWindowTokens: 200_000,
      },
    ])

    const { sender, calls } = makeMockSender()
    const tools = createToolExecutor([
      createSendMessageTool({
        sender,
        targetPolicy: allowAllTargets,
      }),
    ])

    const ledger = createTestAgentLedger()
    const agent = createBotLoopAgent({
      systemPrompt: '',
      context: ctx,
      eventQueue,
      llm,
      tools,
      ledgerRepo: ledger.repo,
      ledgerLoader: ledger.loader,
      renderEvent: renderBotEvent,
      eventDebounceMs: 0,
    })

    await agent.runOnceForTest()

    assert.equal(calls.length, 1)
    assert.equal(calls[0]!.fn, 'sendSegments')
    const args = calls[0]!.args as { target: { type: string; userId: number }; segments: Array<{ type: string; data: Record<string, unknown> }> }
    assert.deepEqual(args.target, { type: 'private', userId: 10001 })
    // The text must be the LLM's intended private reply, NOT something from the group event.
    assert.equal(args.segments[1]?.data.text, '私聊回复')
    assert.equal(args.segments[0]?.data.id, '2')
  })
})
