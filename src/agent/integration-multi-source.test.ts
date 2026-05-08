/**
 * End-to-end smoke test for MVP-2 multi-source flow:
 *
 *   group event A + private event from peer X + group event B
 *     → render-event labels each correctly
 *     → BotLoopAgent.runOnceForTest drains all 3 into context as 3 user messages
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
import type { BotSnapshotRepo } from './snapshot-repo.js'
import type { PersistedAgentSnapshot } from './agent-context.types.js'
import type { MessageSender } from '../messaging/message-sender.js'
import type { SendNapcatResult } from '../messaging/napcat-sender.js'

interface RecordedSend {
  fn: 'replyToMessage' | 'sendGroupMessage' | 'sendPrivateMessage'
  args: unknown
}

function makeMockSender(): { sender: MessageSender; calls: RecordedSend[] } {
  const calls: RecordedSend[] = []
  const ok: SendNapcatResult = { success: true, attempts: 1, providerMessageId: 99 }
  return {
    calls,
    sender: {
      async replyToMessage(args) {
        calls.push({ fn: 'replyToMessage', args })
        return ok
      },
      async sendGroupMessage(args) {
        calls.push({ fn: 'sendGroupMessage', args })
        return ok
      },
      async sendPrivateMessage(args) {
        calls.push({ fn: 'sendPrivateMessage', args })
        return ok
      },
    },
  }
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

function makeMockSnapshotRepo(): { repo: BotSnapshotRepo; saved: PersistedAgentSnapshot[] } {
  const saved: PersistedAgentSnapshot[] = []
  const repo: BotSnapshotRepo = {
    async load() {
      return null
    },
    async save(input) {
      saved.push(input.snapshot)
    },
  }
  return { repo, saved }
}

describe('MVP-2 integration: mixed group + private events through one agent loop', () => {
  test('three events (group / private / group) render with distinct source labels and reach context as 3 user messages', async () => {
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
              text: '在的',
              replyToMessageId: 1001,
            },
          },
        ],
        usage: { inputTokens: 100, cachedTokens: 80, outputTokens: 20 },
        model: 'mock',
      },
    ])

    const { sender, calls } = makeMockSender()
    const tools = createToolExecutor([
      createSendMessageTool({
        sender,
        groupAmbientDryRun: false,
      }),
    ])

    const { repo } = makeMockSnapshotRepo()
    const agent = createBotLoopAgent({
      systemPrompt: 'integration test',
      context: ctx,
      eventQueue,
      llm,
      tools,
      snapshotRepo: repo,
      renderEvent: renderBotEvent,
    })

    await agent.runOnceForTest()

    const messages = ctx.getSnapshot().messages
    // 3 user (drained events) + 1 assistant + 1 tool result = 5
    assert.equal(messages.length, 5)

    const userMessages = messages.filter((m) => m.role === 'user')
    assert.equal(userMessages.length, 3)
    assert.match(userMessages[0]!.content, /^\[群:阳光厨房 \| 张三\(QQ:100\) \[@bot\]\]/)
    assert.match(userMessages[1]!.content, /^\[私聊 \| Alice\(QQ:10001\)\]/)
    assert.match(userMessages[2]!.content, /^\[群:技术群 \| 李四\(QQ:200\)\]/)

    // The send_message tool should have been called via replyToMessage, scoped to group 111.
    assert.equal(calls.length, 1)
    assert.equal(calls[0]!.fn, 'replyToMessage')
    const args = calls[0]!.args as { groupId: number; replyToMessageId: number }
    assert.equal(args.groupId, 111)
    assert.equal(args.replyToMessageId, 1001)
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
              text: '私聊回复',
              replyToMessageId: 2,
            },
          },
        ],
        usage: { inputTokens: 50, cachedTokens: 40, outputTokens: 10 },
        model: 'mock',
      },
    ])

    const { sender, calls } = makeMockSender()
    const tools = createToolExecutor([
      createSendMessageTool({
        sender,
        groupAmbientDryRun: false,
      }),
    ])

    const { repo } = makeMockSnapshotRepo()
    const agent = createBotLoopAgent({
      systemPrompt: '',
      context: ctx,
      eventQueue,
      llm,
      tools,
      snapshotRepo: repo,
      renderEvent: renderBotEvent,
    })

    await agent.runOnceForTest()

    assert.equal(calls.length, 1)
    assert.equal(calls[0]!.fn, 'sendPrivateMessage')
    const args = calls[0]!.args as { userId: number; text: string; replyToMessageId?: number }
    assert.equal(args.userId, 10001)
    // The text must be the LLM's intended private reply, NOT something from the group event.
    assert.equal(args.text, '私聊回复')
    assert.equal(args.replyToMessageId, 2)
  })
})
