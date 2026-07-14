import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { createBotLoopAgent } from './bot-loop-agent.js'
import { createAgentContext } from './agent-context.js'
import { InMemoryEventQueue } from './event-queue.js'
import type { BotEvent } from './event.js'
import type { LlmClient, LlmCallOutput } from './llm-client.js'
import type { ToolExecutionResult, ToolExecutor } from './tool.js'
import type { BotSnapshotRepo } from './snapshot-repo.js'
import type { PersistedAgentSnapshot } from './agent-context.types.js'
import type { MailboxCursors } from './mailbox.js'
import { renderBotEvent } from './render-event.js'
import { createInMemoryGoalStore } from './goal-store.js'
import {
  createEmptyMailboxContinuityState,
  MAILBOX_LIGHT_COMPENSATION_AFTER_MS,
  recordMailboxDisclosure,
  type MailboxContinuityState,
} from './mailbox-continuity.js'

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

function validSummary(content = '保留关键历史。'): string {
  return [
    '## 讨论过的话题',
    content,
    '',
    '## 群友信息',
    '',
    '## 我的承诺和状态',
    '',
    '## 工具调用结果',
    '',
    '## 情绪和氛围',
  ].join('\n')
}

function makeScheduledWake(): Extract<BotEvent, { type: 'scheduled_wake' }> {
  return {
    type: 'scheduled_wake',
    scheduleId: 'schedule-1',
    name: '回看线索',
    scheduleKind: 'at',
    scheduledFor: new Date('2026-07-13T09:00:00.000Z'),
    intention: '重新判断这条线索是否值得继续',
    runCount: 1,
  }
}

function makeMockTools(impl: Record<string, () => Promise<ToolExecutionResult>> = {}): ToolExecutor {
  const noop = async () => ({ content: 'ok' })
  return {
    list: () => [],
    async execute(call) {
      const fn = impl[call.name] ?? noop
      return fn()
    },
  }
}

function makeMockSnapshotRepo(): {
  repo: BotSnapshotRepo
  saved: PersistedAgentSnapshot[]
  savedCursors: Array<MailboxCursors | undefined>
  savedLastWakeAt: Array<Date | null>
  savedContinuity: Array<MailboxContinuityState | undefined>
} {
  const saved: PersistedAgentSnapshot[] = []
  const savedCursors: Array<MailboxCursors | undefined> = []
  const savedLastWakeAt: Array<Date | null> = []
  const savedContinuity: Array<MailboxContinuityState | undefined> = []
  const repo: BotSnapshotRepo = {
    async load() {
      return null
    },
    async save(input) {
      saved.push(input.snapshot)
      savedCursors.push((input as typeof input & { mailboxCursors?: MailboxCursors }).mailboxCursors)
      savedLastWakeAt.push(input.lastWakeAt)
      savedContinuity.push(input.mailboxContinuity == null
        ? undefined
        : structuredClone(input.mailboxContinuity))
    },
  }
  return { repo, saved, savedCursors, savedLastWakeAt, savedContinuity }
}

// Note: 'send_group_message' references in fixtures below are intentionally retained as the
// historical (MVP-1) tool name, mirroring how persisted bot snapshots from before the MVP-2
// rename look on disk. New code calls the tool 'send_message' (see src/agent/tools/send-message.ts);
// already-persisted history stays as-is (red line 5: byte stability of historical turns).
describe('BotLoopAgent.runOnceForTest', () => {
  test('flush persists the current context without running an LLM round', async () => {
    const ctx = createAgentContext()
    ctx.appendUserMessage('durable before shutdown')
    const { repo, saved } = makeMockSnapshotRepo()
    const agent = createBotLoopAgent({
      systemPrompt: '',
      context: ctx,
      eventQueue: new InMemoryEventQueue<BotEvent>(),
      llm: makeMockLlm([]),
      tools: makeMockTools(),
      snapshotRepo: repo,
      renderEvent: renderBotEvent,
      eventDebounceMs: 0,
    })

    await agent.flush()

    assert.deepEqual(saved, [ctx.exportPersistedSnapshot()])
  })

  test('appends and persists a handled marker after a confirmed private send', async () => {
    const ctx = createAgentContext()
    ctx.appendUserMessage(
      '{"event":"inbox_update","mailbox":"qq_private:9001","throughRowId":88}',
    )
    const { repo, saved } = makeMockSnapshotRepo()
    const agent = createBotLoopAgent({
      systemPrompt: '',
      context: ctx,
      eventQueue: new InMemoryEventQueue<BotEvent>(),
      llm: makeMockLlm([{
        content: '',
        toolCalls: [{ id: 'send-1', name: 'send_message', args: { text: '收到' } }],
        usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 5 },
        model: 'mock',
      }]),
      tools: makeMockTools({
        send_message: async () => ({
          content: '{"ok":true,"status":"sent"}',
          effects: [{ type: 'message_sent', target: { type: 'private', userId: 9001 } }],
        }),
      }),
      snapshotRepo: repo,
      renderEvent: renderBotEvent,
      eventDebounceMs: 0,
    })

    await agent.runOnceForTest()

    const marker = '{"event":"mailbox_handled","mailbox":"qq_private:9001","throughRowId":88}'
    assert.deepEqual(ctx.getSnapshot().messages.at(-1), { role: 'user', content: marker })
    assert.deepEqual(saved.at(-1)?.messages.at(-1), { role: 'user', content: marker })
  })

  test('closes a durable inbox cursor when the confirmed send happens in a later step', async () => {
    const ctx = createAgentContext()
    ctx.appendUserMessage(
      '{"event":"inbox_update","mailbox":"qq_private:9001","throughRowId":88}',
    )
    const { repo } = makeMockSnapshotRepo()
    const agent = createBotLoopAgent({
      systemPrompt: '',
      context: ctx,
      eventQueue: new InMemoryEventQueue<BotEvent>(),
      llm: makeMockLlm([
        {
          content: '',
          toolCalls: [{ id: 'inbox-1', name: 'inbox', args: { peerId: 9001 } }],
          usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 5 },
          model: 'mock',
        },
        {
          content: '',
          toolCalls: [{ id: 'send-1', name: 'send_message', args: { text: '稍后回复' } }],
          usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 5 },
          model: 'mock',
        },
      ]),
      tools: makeMockTools({
        inbox: async () => ({ content: '{"ok":true,"messages":[]}' }),
        send_message: async () => ({
          content: '{"ok":true,"status":"sent"}',
          effects: [{ type: 'message_sent', target: { type: 'private', userId: 9001 } }],
        }),
      }),
      snapshotRepo: repo,
      renderEvent: renderBotEvent,
      eventDebounceMs: 0,
    })

    await agent.runOnceForTest()
    assert.equal(
      ctx.getSnapshot().messages.some(
        (message) => message.role === 'user' && message.content.includes('mailbox_handled'),
      ),
      false,
    )

    await agent.runOnceForTest()

    assert.deepEqual(ctx.getSnapshot().messages.at(-1), {
      role: 'user',
      content: '{"event":"mailbox_handled","mailbox":"qq_private:9001","throughRowId":88}',
    })
  })

  test('does not append a handled marker when send_message has no confirmed effect', async () => {
    const ctx = createAgentContext()
    ctx.appendUserMessage(
      '{"event":"inbox_update","mailbox":"qq_private:9001","throughRowId":88}',
    )
    const { repo } = makeMockSnapshotRepo()
    const agent = createBotLoopAgent({
      systemPrompt: '',
      context: ctx,
      eventQueue: new InMemoryEventQueue<BotEvent>(),
      llm: makeMockLlm([{
        content: '',
        toolCalls: [{ id: 'send-1', name: 'send_message', args: { text: '收到' } }],
        usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 5 },
        model: 'mock',
      }]),
      tools: makeMockTools({
        send_message: async () => ({ content: '{"ok":false,"status":"failed"}' }),
      }),
      snapshotRepo: repo,
      renderEvent: renderBotEvent,
      eventDebounceMs: 0,
    })

    await agent.runOnceForTest()

    assert.equal(
      ctx.getSnapshot().messages.some(
        (message) => message.role === 'user' && message.content.includes('mailbox_handled'),
      ),
      false,
    )
  })

  test('does not close a pending mailbox when the confirmed send targets another private chat', async () => {
    const ctx = createAgentContext()
    ctx.appendUserMessage(
      '{"event":"inbox_update","mailbox":"qq_private:9001","throughRowId":88}',
    )
    const { repo } = makeMockSnapshotRepo()
    const agent = createBotLoopAgent({
      systemPrompt: '',
      context: ctx,
      eventQueue: new InMemoryEventQueue<BotEvent>(),
      llm: makeMockLlm([{
        content: '',
        toolCalls: [{ id: 'send-1', name: 'send_message', args: { text: '发给别人' } }],
        usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 5 },
        model: 'mock',
      }]),
      tools: makeMockTools({
        send_message: async () => ({
          content: '{"ok":true,"status":"sent"}',
          effects: [{ type: 'message_sent', target: { type: 'private', userId: 9002 } }],
        }),
      }),
      snapshotRepo: repo,
      renderEvent: renderBotEvent,
      eventDebounceMs: 0,
    })

    await agent.runOnceForTest()

    assert.equal(
      ctx.getSnapshot().messages.some(
        (message) => message.role === 'user' && message.content.includes('mailbox_handled'),
      ),
      false,
    )
  })

  test('appends one handled marker for duplicate confirmed sends to the same target in one round', async () => {
    const ctx = createAgentContext()
    ctx.appendUserMessage(
      '{"event":"inbox_update","mailbox":"qq_private:9001","throughRowId":88}',
    )
    const { repo } = makeMockSnapshotRepo()
    const agent = createBotLoopAgent({
      systemPrompt: '',
      context: ctx,
      eventQueue: new InMemoryEventQueue<BotEvent>(),
      llm: makeMockLlm([{
        content: '',
        toolCalls: [
          { id: 'send-1', name: 'send_message', args: { text: '第一段' } },
          { id: 'send-2', name: 'send_message', args: { text: '第二段' } },
        ],
        usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 5 },
        model: 'mock',
      }]),
      tools: makeMockTools({
        send_message: async () => ({
          content: '{"ok":true,"status":"sent"}',
          effects: [{ type: 'message_sent', target: { type: 'private', userId: 9001 } }],
        }),
      }),
      snapshotRepo: repo,
      renderEvent: renderBotEvent,
      eventDebounceMs: 0,
    })

    await agent.runOnceForTest()

    const marker = '{"event":"mailbox_handled","mailbox":"qq_private:9001","throughRowId":88}'
    assert.equal(
      ctx.getSnapshot().messages.filter(
        (message) => message.role === 'user' && message.content === marker,
      ).length,
      1,
    )
  })

  test('drains mentioned group events as high-priority mailbox notifications, runs LLM, executes tools', async () => {
    const ctx = createAgentContext()
    const eventQueue = new InMemoryEventQueue<BotEvent>()
    eventQueue.enqueue({
      type: 'napcat_message',
      messageRowId: 1,
      groupId: 999,
      messageId: 12345,
      senderId: 100,
      senderNickname: '张三',
      mentionedSelf: true,
      sentAt: new Date('2026-01-01T00:00:00Z'),
      renderedText: 'hello',
    })

    const llm = makeMockLlm([
      {
        content: '思考',
        toolCalls: [{ id: 'c1', name: 'send_group_message', args: { text: '在' } }],
        usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 5 },
        model: 'mock',
      },
    ])

    let toolExecuted = false
    const tools = makeMockTools({
      send_group_message: async () => {
        toolExecuted = true
        return { content: '{"ok":true,"status":"sent"}' }
      },
    })

    const { repo, saved } = makeMockSnapshotRepo()

    const agent = createBotLoopAgent({
      systemPrompt: 'you are a bot',
      context: ctx,
      eventQueue,
      llm,
      tools,
      snapshotRepo: repo,
      renderEvent: async (event) => {
        if (event.type !== 'napcat_message') return null
        return `[${event.senderNickname}] hello`
      },
      eventDebounceMs: 0,
    })

    await agent.runOnceForTest()

    const messages = ctx.getSnapshot().messages
    assert.equal(messages.length, 3, 'user + assistant + tool')
    assert.equal(messages[0]?.role, 'user')
    if (messages[0]?.role === 'user') {
      const notification = JSON.parse(messages[0].content)
      assert.equal(notification.mailbox, 'qq_group:999')
      assert.equal(notification.priority, 'high')
      assert.doesNotMatch(messages[0].content, /hello/)
    }
    assert.equal(messages[1]?.role, 'assistant')
    if (messages[1]?.role === 'assistant') {
      assert.equal(messages[1].content, '', 'new assistant text must not enter durable AgentContext')
    }
    assert.equal(messages[2]?.role, 'tool')
    assert.equal(toolExecuted, true)
    assert.equal(saved.length, 2, 'snapshot persisted twice (pre-round + post-round)')
  })

  test('adds one prior-message compensation after a durable two-hour mailbox gap', async () => {
    const ctx = createAgentContext()
    const eventQueue = new InMemoryEventQueue<BotEvent>()
    const firstAt = new Date('2026-01-01T00:00:00Z')
    eventQueue.enqueue({
      type: 'napcat_private_message',
      messageRowId: 30,
      peerId: 9001,
      messageId: 20_030,
      senderId: 9001,
      senderNickname: 'Alice',
      mentionedSelf: true,
      sentAt: new Date(firstAt.getTime() + MAILBOX_LIGHT_COMPENSATION_AFTER_MS),
      renderedText: 'follow up',
    })
    const continuity = createEmptyMailboxContinuityState()
    recordMailboxDisclosure(continuity, 'qq_private:9001', firstAt.getTime())
    const { repo, savedContinuity } = makeMockSnapshotRepo()
    const agent = createBotLoopAgent({
      systemPrompt: '',
      context: ctx,
      eventQueue,
      llm: makeMockLlm([{
        content: '',
        toolCalls: [],
        usage: { inputTokens: 100, cachedTokens: 0, outputTokens: 0 },
        model: 'mock',
      }]),
      tools: makeMockTools(),
      snapshotRepo: repo,
      initialMailboxContinuity: continuity,
      renderEvent: renderBotEvent,
      eventDebounceMs: 0,
    })

    await agent.runOnceForTest()

    const notification = ctx.getSnapshot().messages[0]
    assert.equal(notification?.role, 'user')
    if (notification?.role === 'user') {
      const payload = JSON.parse(notification.content)
      assert.equal(payload.readArgs.contextBefore, 1)
    }
    assert.equal(savedContinuity.at(-1)?.roundSeq, 1)
    assert.equal(savedContinuity.at(-1)?.mailboxes['qq_private:9001']?.lastMessageAtMs,
      firstAt.getTime() + MAILBOX_LIGHT_COMPENSATION_AFTER_MS)
  })

  test('wake events drain without appending to context', async () => {
    const ctx = createAgentContext()
    const eventQueue = new InMemoryEventQueue<BotEvent>()
    eventQueue.enqueue({ type: 'wake' })
    eventQueue.enqueue({ type: 'wake' })

    const llm = makeMockLlm([
      {
        content: '',
        toolCalls: [],
        usage: { inputTokens: 0, cachedTokens: 0, outputTokens: 0 },
        model: 'mock',
      },
    ])

    const { repo } = makeMockSnapshotRepo()
    const agent = createBotLoopAgent({
      systemPrompt: '',
      context: ctx,
      eventQueue,
      llm,
      tools: makeMockTools(),
      snapshotRepo: repo,
      renderEvent: () => null,
      eventDebounceMs: 0,
    })

    await agent.runOnceForTest()
    assert.equal(ctx.getSnapshot().messages.length, 0, 'wake events must not enter context')
  })

  test('life journal hook receives bounded round delta after successful round', async () => {
    const ctx = createAgentContext()
    ctx.appendUserMessage('existing durable history')
    const eventQueue = new InMemoryEventQueue<BotEvent>()
    eventQueue.enqueue({
      type: 'napcat_message',
      messageRowId: 1,
      groupId: 999,
      messageId: 12345,
      senderId: 100,
      senderNickname: '张三',
      mentionedSelf: true,
      sentAt: new Date('2026-01-01T00:00:00Z'),
      renderedText: 'hello',
    })
    const received: PersistedAgentSnapshot['messages'][] = []
    const { repo } = makeMockSnapshotRepo()
    const agent = createBotLoopAgent({
      systemPrompt: 'you are a bot',
      context: ctx,
      eventQueue,
      llm: makeMockLlm([{
        content: '',
        toolCalls: [{ id: 'c1', name: 'send_message', args: { text: '在' } }],
        usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 5 },
        model: 'mock',
      }]),
      tools: makeMockTools({
        send_message: async () => ({ content: '{"ok":true,"status":"sent"}' }),
      }),
      snapshotRepo: repo,
      renderEvent: renderBotEvent,
      eventDebounceMs: 0,
      lifeJournal: {
        async recordRound({ messages }) {
          received.push(messages)
          return { ok: true, wroteJournal: true, updatedAgenda: false }
        },
      },
    })

    await agent.runOnceForTest()

    assert.equal(received.length, 1)
    assert.equal(received[0]!.some((message) => message.role === 'user'), true)
    assert.equal(
      received[0]!.some((message) => message.role === 'user' && message.content === 'existing durable history'),
      false,
    )
    assert.equal(received[0]!.some((message) => message.role === 'tool'), true)
  })

  test('life journal failure does not throw and does not prevent compaction', async () => {
    const ctx = createAgentContext()
    ctx.appendUserMessage('older history')
    const eventQueue = new InMemoryEventQueue<BotEvent>()
    eventQueue.enqueue({ type: 'curiosity_tick' })
    let summarized = false
    const { repo, saved } = makeMockSnapshotRepo()
    const agent = createBotLoopAgent({
      systemPrompt: '',
      context: ctx,
      eventQueue,
      llm: makeMockLlm([{
        content: '',
        toolCalls: [{ id: 'c1', name: 'lookup', args: {} }],
        usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 5 },
        model: 'mock',
      }]),
      tools: makeMockTools({
        lookup: async () => ({ content: 'tool result' }),
      }),
      snapshotRepo: repo,
      renderEvent: renderBotEvent,
      eventDebounceMs: 0,
      compactOptions: {
        triggerTokens: 1,
        keepRatio: 0.1,
        summarize: async () => {
          summarized = true
          return validSummary()
        },
      },
      lifeJournal: {
        async recordRound() {
          throw new Error('journal failed')
        },
      },
    })

    await agent.runOnceForTest()

    assert.equal(summarized, true)
    const lastSaved = saved.at(-1)
    assert.deepEqual(
      lastSaved,
      ctx.exportPersistedSnapshot(),
      'the snapshot saved at the end of the step must include compaction output',
    )
    const head = lastSaved?.messages[0]
    assert.equal(head?.role, 'user')
    if (head?.role === 'user') {
      assert.match(head.content, /^\[历史摘要\]/)
    }
  })

  test('context overflow forces one compaction, saves it, and retries the LLM round once', async () => {
    const ctx = createAgentContext()
    ctx.appendUserMessage('old-0')
    ctx.appendUserMessage('old-1')
    ctx.appendUserMessage('old-2')
    ctx.appendUserMessage('old-3')
    const eventQueue = new InMemoryEventQueue<BotEvent>()
    eventQueue.enqueue({ type: 'curiosity_tick' })
    let chatCalls = 0
    const llm: LlmClient = {
      async chat() {
        chatCalls += 1
        if (chatCalls === 1) {
          throw Object.assign(new Error('prompt too long'), { kind: 'context_overflow' })
        }
        return {
          content: '',
          toolCalls: [],
          usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 0 },
          model: 'mock',
        }
      },
    }
    const { repo, saved } = makeMockSnapshotRepo()
    const agent = createBotLoopAgent({
      systemPrompt: '',
      context: ctx,
      eventQueue,
      llm,
      tools: makeMockTools(),
      snapshotRepo: repo,
      renderEvent: renderBotEvent,
      eventDebounceMs: 0,
      compactOptions: {
        triggerTokens: 100_000,
        keepRatio: 0.2,
        summarize: async ({ history }) => validSummary(`recovered ${history.length}`),
      },
    })

    await agent.runOnceForTest()

    assert.equal(chatCalls, 2)
    assert.equal(saved.length, 3, 'pre-round, recovery-compacted, post-round snapshots')
    const messages = ctx.getSnapshot().messages
    assert.equal(messages[0]?.role, 'user')
    if (messages[0]?.role === 'user') assert.match(messages[0].content, /^\[历史摘要\][\s\S]*recovered /)
    assert.equal(messages.some((message) => message.role === 'assistant'), false)
    assert.deepEqual(saved.at(-1), ctx.exportPersistedSnapshot())
  })

  test('context overflow recovery is bounded to one compaction attempt per round', async () => {
    const ctx = createAgentContext()
    for (let i = 0; i < 5; i += 1) ctx.appendUserMessage(`old-${i}`)
    const eventQueue = new InMemoryEventQueue<BotEvent>()
    eventQueue.enqueue({ type: 'curiosity_tick' })
    let chatCalls = 0
    let summarizeCalls = 0
    const { repo } = makeMockSnapshotRepo()
    const agent = createBotLoopAgent({
      systemPrompt: '',
      context: ctx,
      eventQueue,
      llm: {
        async chat() {
          chatCalls += 1
          throw Object.assign(new Error('still too long'), { kind: 'context_overflow' })
        },
      },
      tools: makeMockTools(),
      snapshotRepo: repo,
      renderEvent: renderBotEvent,
      eventDebounceMs: 0,
      compactOptions: {
        keepRatio: 0.2,
        summarize: async () => {
          summarizeCalls += 1
          return validSummary()
        },
      },
    })

    await assert.rejects(() => agent.runOnceForTest(), /still too long/)
    assert.equal(chatCalls, 2)
    assert.equal(summarizeCalls, 1)
  })

  test('context overflow preserves the provider error and context when recovery summarization fails', async () => {
    const ctx = createAgentContext()
    for (let i = 0; i < 5; i += 1) ctx.appendUserMessage(`old-${i}`)
    let beforeRecovery = ctx.getSnapshot()
    const eventQueue = new InMemoryEventQueue<BotEvent>()
    eventQueue.enqueue({ type: 'curiosity_tick' })
    let chatCalls = 0
    let summarizeCalls = 0
    const { repo } = makeMockSnapshotRepo()
    const agent = createBotLoopAgent({
      systemPrompt: '',
      context: ctx,
      eventQueue,
      llm: {
        async chat() {
          chatCalls++
          if (chatCalls === 1) {
            beforeRecovery = ctx.getSnapshot()
            throw Object.assign(new Error('prompt too long'), { kind: 'context_overflow' })
          }
          return {
            content: '',
            toolCalls: [],
            usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 0 },
            model: 'mock',
          }
        },
      },
      tools: makeMockTools(),
      snapshotRepo: repo,
      renderEvent: renderBotEvent,
      eventDebounceMs: 0,
      compactOptions: {
        keepRatio: 0.2,
        summarize: async () => {
          summarizeCalls++
          throw new Error('summarizer unavailable')
        },
      },
    })

    await assert.rejects(() => agent.runOnceForTest(), /prompt too long/)
    assert.equal(chatCalls, 1)
    assert.equal(summarizeCalls, 1)
    assert.deepEqual(ctx.getSnapshot(), beforeRecovery)
  })

  test('checkpoints text-only truncated output and continues without replaying partial tool calls', async () => {
    const ctx = createAgentContext()
    const eventQueue = new InMemoryEventQueue<BotEvent>()
    eventQueue.enqueue({ type: 'curiosity_tick' })
    const seenMessages: PersistedAgentSnapshot['messages'][] = []
    let chatCalls = 0
    let toolExecutions = 0
    const llm: LlmClient = {
      async chat(input) {
        seenMessages.push(input.messages)
        chatCalls++
        if (chatCalls <= 2) {
          return {
            content: chatCalls === 1 ? 'first partial' : 'second partial',
            toolCalls: [],
            usage: { inputTokens: 10, cachedTokens: 5, outputTokens: 8 },
            model: 'mock',
            stopReason: 'max_tokens',
          }
        }
        return {
          content: '',
          toolCalls: [{ id: 'done-1', name: 'done', args: {} }],
          usage: { inputTokens: 12, cachedTokens: 6, outputTokens: 2 },
          model: 'mock',
          stopReason: 'tool_use',
        }
      },
    }
    const { repo, saved } = makeMockSnapshotRepo()
    const agent = createBotLoopAgent({
      systemPrompt: '',
      context: ctx,
      eventQueue,
      llm,
      tools: makeMockTools({
        done: async () => {
          toolExecutions++
          return { content: '{"ok":true}' }
        },
      }),
      snapshotRepo: repo,
      renderEvent: renderBotEvent,
      eventDebounceMs: 0,
    })

    await agent.runOnceForTest()

    assert.equal(chatCalls, 3)
    assert.equal(toolExecutions, 1)
    assert.equal(saved.length, 3, 'pre-round, continuation checkpoint, post-round')
    assert.equal(
      seenMessages[2]?.some(
        (message) => message.role === 'assistant' && message.content === 'second partial',
      ),
      true,
    )
    const messages = ctx.getSnapshot().messages
    const partial = messages.find(
      (message) => message.role === 'assistant' && message.content === 'second partial',
    )
    assert.ok(partial)
    assert.equal(
      messages.some(
        (message) => message.role === 'assistant' && message.content === 'first partial',
      ),
      false,
      'the first same-request retry is not durable',
    )
    assert.equal(messages.at(-1)?.role, 'tool')
  })

  test('life journal does not append review output to AgentContext', async () => {
    const ctx = createAgentContext()
    const eventQueue = new InMemoryEventQueue<BotEvent>()
    eventQueue.enqueue({ type: 'curiosity_tick' })
    const { repo } = makeMockSnapshotRepo()
    const agent = createBotLoopAgent({
      systemPrompt: '',
      context: ctx,
      eventQueue,
      llm: makeMockLlm([{
        content: '',
        toolCalls: [],
        usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 0 },
        model: 'mock',
      }]),
      tools: makeMockTools(),
      snapshotRepo: repo,
      renderEvent: renderBotEvent,
      eventDebounceMs: 0,
      lifeJournal: {
        async recordRound() {
          return { ok: true, wroteJournal: true, updatedAgenda: true, secret: 'must not enter context' }
        },
      },
    })

    await agent.runOnceForTest()

    assert.equal(JSON.stringify(ctx.getSnapshot().messages).includes('must not enter context'), false)
  })

  test('life journal hook is not called when wake events run no round', async () => {
    const ctx = createAgentContext()
    const eventQueue = new InMemoryEventQueue<BotEvent>()
    eventQueue.enqueue({ type: 'wake' })
    let called = false
    const { repo } = makeMockSnapshotRepo()
    const agent = createBotLoopAgent({
      systemPrompt: '',
      context: ctx,
      eventQueue,
      llm: makeMockLlm([{
        content: '',
        toolCalls: [],
        usage: { inputTokens: 0, cachedTokens: 0, outputTokens: 0 },
        model: 'mock',
      }]),
      tools: makeMockTools(),
      snapshotRepo: repo,
      renderEvent: renderBotEvent,
      eventDebounceMs: 0,
      lifeJournal: {
        async recordRound() {
          called = true
        },
      },
    })

    await agent.runOnceForTest()

    assert.equal(called, false)
  })

  test('replaces ambient group bodies with metadata notification and persists source cursors', async () => {
    const ctx = createAgentContext()
    const eventQueue = new InMemoryEventQueue<BotEvent>()
    eventQueue.enqueue({
      type: 'napcat_message',
      messageRowId: 41,
      groupId: 999,
      groupName: '环境群',
      messageId: 12341,
      senderId: 100,
      senderNickname: '路人甲',
      mentionedSelf: false,
      sentAt: new Date('2026-07-03T00:00:00Z'),
      renderedText: 'AMBIENT_BODY_MUST_NOT_ENTER_CONTEXT',
    })
    eventQueue.enqueue({
      type: 'napcat_message',
      messageRowId: 43,
      groupId: 999,
      groupName: '环境群',
      messageId: 12343,
      senderId: 101,
      senderNickname: '路人乙',
      mentionedSelf: false,
      sentAt: new Date('2026-07-03T00:00:01Z'),
      renderedText: 'SECOND_AMBIENT_BODY_MUST_NOT_ENTER_CONTEXT',
    })

    const llm = makeMockLlm([{
      content: '',
      toolCalls: [],
      usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 0 },
      model: 'mock',
    }])
    const { repo, savedCursors } = makeMockSnapshotRepo()
    const agent = createBotLoopAgent({
      systemPrompt: '',
      context: ctx,
      eventQueue,
      llm,
      tools: makeMockTools(),
      snapshotRepo: repo,
      renderEvent: (event) => event.type === 'napcat_message' ? event.renderedText : null,
      eventDebounceMs: 0,
    })

    await agent.runOnceForTest()

    const userMessages = ctx.getSnapshot().messages.filter((message) => message.role === 'user')
    assert.equal(userMessages.length, 1)
    const notification = JSON.parse(userMessages[0]!.content)
    assert.equal(notification.source.groupName, '环境群')
    assert.equal(notification.count, 2)
    assert.doesNotMatch(userMessages[0]!.content, /AMBIENT_BODY/)
    assert.deepEqual(savedCursors, [
      { 'qq_group:999': 43 },
      { 'qq_group:999': 43 },
    ])
  })

  test('replaces private bodies with one metadata notification per peer and persists cursors', async () => {
    const ctx = createAgentContext()
    const eventQueue = new InMemoryEventQueue<BotEvent>()
    const enqueuePrivate = (rowId: number, peerId: number, text: string) => {
      eventQueue.enqueue({
        type: 'napcat_private_message',
        messageRowId: rowId,
        peerId,
        messageId: 20_000 + rowId,
        senderId: peerId,
        senderNickname: peerId === 9001 ? 'Alice' : 'Bob',
        mentionedSelf: true,
        sentAt: new Date(`2026-07-03T00:02:${String(rowId).padStart(2, '0')}Z`),
        renderedText: text,
      })
    }
    enqueuePrivate(51, 9001, 'PRIVATE_ONE')
    enqueuePrivate(52, 9002, 'PRIVATE_OTHER')
    enqueuePrivate(53, 9001, 'PRIVATE_TWO')

    const llm = makeMockLlm([{
      content: '',
      toolCalls: [],
      usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 0 },
      model: 'mock',
    }])
    const { repo, savedCursors } = makeMockSnapshotRepo()
    const agent = createBotLoopAgent({
      systemPrompt: '',
      context: ctx,
      eventQueue,
      llm,
      tools: makeMockTools(),
      snapshotRepo: repo,
      renderEvent: (event) => event.type === 'napcat_private_message' ? event.renderedText : null,
      eventDebounceMs: 0,
    })

    await agent.runOnceForTest()

    const userMessages = ctx.getSnapshot().messages.filter((message) => message.role === 'user')
    assert.equal(userMessages.length, 2)
    assert.deepEqual(userMessages.map((message) => JSON.parse(message.content).mailbox), [
      'qq_private:9001',
      'qq_private:9002',
    ])
    assert.doesNotMatch(userMessages.map((message) => message.content).join('\n'), /PRIVATE_/)
    assert.deepEqual(savedCursors.at(-1), {
      'qq_private:9001': 53,
      'qq_private:9002': 52,
    })
  })

  test('appends backlog metadata events and advances their source cursor', async () => {
    const ctx = createAgentContext()
    const eventQueue = new InMemoryEventQueue<BotEvent>()
    eventQueue.enqueue({
      type: 'mailbox_backlog',
      mailboxKey: 'qq_group:999',
      priority: 'normal',
      source: { type: 'group', groupId: 999, groupName: '积压群' },
      count: 230,
      firstRowId: 1_000,
      throughRowId: 1_500,
      recentAfterRowId: 1_430,
      senderCount: 12,
      timeRange: {
        from: new Date('2026-07-03T00:00:00Z'),
        to: new Date('2026-07-03T02:00:00Z'),
      },
    })

    const { repo, savedCursors } = makeMockSnapshotRepo()
    const agent = createBotLoopAgent({
      systemPrompt: '',
      context: ctx,
      eventQueue,
      llm: makeMockLlm([{
        content: '',
        toolCalls: [],
        usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 0 },
        model: 'mock',
      }]),
      tools: makeMockTools(),
      snapshotRepo: repo,
      renderEvent: renderBotEvent,
      eventDebounceMs: 0,
    })

    await agent.runOnceForTest()

    const userMessages = ctx.getSnapshot().messages.filter((message) => message.role === 'user')
    assert.equal(userMessages.length, 1)
    const notification = JSON.parse(userMessages[0]!.content)
    assert.equal(notification.mode, 'backlog')
    assert.equal(notification.mailbox, 'qq_group:999')
    assert.equal(notification.throughRowId, 1_500)
    assert.deepEqual(notification.latestReadArgs, {
      action: 'read',
      source: 'group',
      groupId: 999,
      afterRowId: 1_430,
      limit: 50,
    })
    assert.deepEqual(savedCursors, [
      { 'qq_group:999': 1_500 },
      { 'qq_group:999': 1_500 },
    ])
  })

  test('preserves the restored legacy wake boundary across non-message rounds', async () => {
    const ctx = createAgentContext()
    const eventQueue = new InMemoryEventQueue<BotEvent>()
    eventQueue.enqueue({ type: 'curiosity_tick' })
    const restoredWakeAt = new Date('2026-07-02T12:00:00Z')
    const { repo, savedLastWakeAt } = makeMockSnapshotRepo()
    const agent = createBotLoopAgent({
      systemPrompt: '',
      context: ctx,
      eventQueue,
      llm: makeMockLlm([{
        content: '',
        toolCalls: [],
        usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 0 },
        model: 'mock',
      }]),
      tools: makeMockTools(),
      snapshotRepo: repo,
      initialLastWakeAt: restoredWakeAt,
      renderEvent: () => '[好奇心 tick]',
      eventDebounceMs: 0,
    })

    await agent.runOnceForTest()

    assert.deepEqual(savedLastWakeAt, [restoredWakeAt, restoredWakeAt])
  })

  test('does not rerun the LLM when a redelivered message is already behind its source cursor', async () => {
    const ctx = createAgentContext()
    ctx.appendUserMessage('existing durable history')
    const eventQueue = new InMemoryEventQueue<BotEvent>()
    eventQueue.enqueue({
      type: 'napcat_message',
      messageRowId: 10,
      groupId: 999,
      messageId: 12345,
      senderId: 100,
      senderNickname: 'duplicate',
      mentionedSelf: true,
      sentAt: new Date('2026-07-03T00:00:00Z'),
      renderedText: 'must be ignored',
    })
    let llmCalled = false
    const { repo, saved } = makeMockSnapshotRepo()
    const agent = createBotLoopAgent({
      systemPrompt: '',
      context: ctx,
      eventQueue,
      llm: {
        async chat() {
          llmCalled = true
          throw new Error('LLM must not run for cursor-filtered redelivery')
        },
      },
      tools: makeMockTools(),
      snapshotRepo: repo,
      initialMailboxCursors: { 'qq_group:999': 10 },
      renderEvent: () => 'must not render',
      eventDebounceMs: 0,
    })

    await agent.runOnceForTest()

    assert.equal(llmCalled, false)
    assert.equal(saved.length, 0)
    assert.deepEqual(ctx.getSnapshot().messages, [{ role: 'user', content: 'existing durable history' }])
  })

  test('空队列等待外部事件时只保活进程, 不注入空闲事件', async () => {
    const ctx = createAgentContext()
    const eventQueue = new InMemoryEventQueue<BotEvent>()
    const llm: LlmClient = {
      async chat() {
        throw new Error('LLM should not run while there are no events')
      },
    }
    const { repo } = makeMockSnapshotRepo()
    let opened = 0
    let closed = 0

    const agent = createBotLoopAgent({
      systemPrompt: '',
      context: ctx,
      eventQueue,
      llm,
      tools: makeMockTools(),
      snapshotRepo: repo,
      renderEvent: () => null,
      eventDebounceMs: 0,
      keepAlive: {
        open() {
          opened++
          return {
            close() {
              closed++
            },
          }
        },
      },
    })

    const startPromise = agent.start()
    await new Promise((resolve) => setTimeout(resolve, 20))

    assert.equal(opened, 1)
    assert.equal(closed, 0)
    assert.equal(eventQueue.size(), 0, 'waiting must not enqueue wake/idle events')
    assert.equal(ctx.getSnapshot().messages.length, 0)

    await agent.stop()
    await startPromise

    assert.equal(closed, 1)
  })

  test('LLM call 非 send_message tool 后立即跑下一轮消化 result', async () => {
    // 双轮意图: round 1 LLM call reddit → tool result 进 context → 主循环立即跑 round 2 →
    // LLM 看到 result 决定 send_message → 真发出去. 但 send_message 之后不再继续空转,
    // 避免同一批入站消息被重复回复.
    const ctx = createAgentContext()
    const eventQueue = new InMemoryEventQueue<BotEvent>()
    eventQueue.enqueue({
      type: 'napcat_message',
      messageRowId: 1,
      groupId: 999,
      messageId: 12345,
      senderId: 100,
      senderNickname: '张三',
      mentionedSelf: true,
      sentAt: new Date('2026-01-01T00:00:00Z'),
      renderedText: 'hello',
    })

    let llmCallCount = 0
    let agent: ReturnType<typeof createBotLoopAgent>
    const llm: LlmClient = {
      async chat() {
        llmCallCount++
        if (llmCallCount === 1) {
          return {
            content: '让我看看 reddit 有啥',
            toolCalls: [{ id: 'c1', name: 'reddit', args: { action: 'list', subreddit: 'technology' } }],
            usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 5 },
            model: 'mock',
          }
        }
        if (llmCallCount === 2) {
          return {
            content: '看到了, 分享一下',
            toolCalls: [{ id: 'c2', name: 'send_message', args: {} }],
            usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 5 },
            model: 'mock',
          }
        }
        // 如果 send_message 后仍继续跑, 这里会 stop; 正常情况下不会走到这里.
        return {
          content: '',
          toolCalls: [{ id: 'c3', name: 'rest', args: { durationSeconds: 30 } }],
          usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 5 },
          model: 'mock',
        }
      },
    }

    let sendMessageCalled = false
    const tools = makeMockTools({
      reddit: async () => ({ content: '[reddit] r/programming top: foo bar' }),
      send_message: async () => {
        sendMessageCalled = true
        return { content: '{"ok":true,"status":"sent"}' }
      },
      rest: async () => {
        await agent.stop()
        return { content: '[休息结束] 已休息约 30 秒。' }
      },
    })
    const { repo } = makeMockSnapshotRepo()

    agent = createBotLoopAgent({
      systemPrompt: 'you are a bot',
      context: ctx,
      eventQueue,
      llm,
      tools,
      snapshotRepo: repo,
      renderEvent: async (event) => {
        if (event.type !== 'napcat_message') return null
        return `[${event.senderNickname}] hello`
      },
      eventDebounceMs: 0,
    })

    const startPromise = agent.start()
    await new Promise((resolve) => setTimeout(resolve, 100))

    // 双轮意图贯通: LLM 至少跑了 2 次, send_message 真的执行了
    assert.ok(llmCallCount >= 2, `expected LLM ≥2 calls, got ${llmCallCount}`)
    assert.equal(sendMessageCalled, true, 'send_message 拿到 reddit result 后真发出去了')
    await agent.stop()

    await startPromise
  })

  test('send_message 成功后继续下一轮, 由 pause 决定何时休息', async () => {
    const ctx = createAgentContext()
    const eventQueue = new InMemoryEventQueue<BotEvent>()
    eventQueue.enqueue({
      type: 'napcat_message',
      messageRowId: 1,
      groupId: 999,
      messageId: 12345,
      senderId: 100,
      senderNickname: '张三',
      mentionedSelf: true,
      sentAt: new Date('2026-01-01T00:00:00Z'),
      renderedText: 'hello',
    })

    let llmCallCount = 0
    let agent: ReturnType<typeof createBotLoopAgent>
    const llm: LlmClient = {
      async chat() {
        llmCallCount++
        if (llmCallCount === 1) {
          return {
            content: '',
            toolCalls: [{ id: 'c1', name: 'send_message', args: { text: '在' } }],
            usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 5 },
            model: 'mock',
          }
        }
        return {
          content: '',
          toolCalls: [{
            id: 'c2',
            name: 'pause',
            args: {
              action: 'rest',
              durationSeconds: 300,
              reason: '完成一段活动后短暂放空',
              intention: {
                primaryDirection: '继续自己的研究并验证下一条证据',
                alternativeDirection: '挑一篇群友文章读第一节',
              },
            },
          }],
          usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 5 },
          model: 'mock',
        }
      },
    }

    let sendMessageCount = 0
    let pauseCalled = false
    const tools = makeMockTools({
      send_message: async () => {
        sendMessageCount++
        return { content: '{"ok":true,"status":"sent"}' }
      },
      pause: async () => {
        pauseCalled = true
        await agent.stop()
        return { content: '[休息结束] 继续: 醒来后继续自己的研究' }
      },
    })
    const { repo } = makeMockSnapshotRepo()

    agent = createBotLoopAgent({
      systemPrompt: 'you are a bot',
      context: ctx,
      eventQueue,
      llm,
      tools,
      snapshotRepo: repo,
      renderEvent: async (event) => {
        if (event.type !== 'napcat_message') return null
        return `[${event.senderNickname}] hello`
      },
      eventDebounceMs: 0,
    })

    const startPromise = agent.start()
    try {
      await new Promise((resolve) => setTimeout(resolve, 50))

      assert.equal(llmCallCount, 2, 'send_message 只是动作, 成功后仍应由 Agent 选择下一步')
      assert.equal(sendMessageCount, 1)
      assert.equal(pauseCalled, true)
    } finally {
      await agent.stop()
      await startPromise
    }
  })

  test('pause effect resets consecutive-round guard without parsing result content', async () => {
    const ctx = createAgentContext()
    const eventQueue = new InMemoryEventQueue<BotEvent>()
    eventQueue.enqueue({ type: 'curiosity_tick' })
    let llmCallCount = 0
    const llm: LlmClient = {
      async chat() {
        llmCallCount++
        return {
          content: '',
          toolCalls: [{ id: `pause-${llmCallCount}`, name: 'pause', args: {} }],
          usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 1 },
          model: 'mock',
        }
      },
    }
    let agent: ReturnType<typeof createBotLoopAgent>
    let pauseCallCount = 0
    let cooldownWaits = 0
    const tools = makeMockTools({
      pause: async () => {
        pauseCallCount++
        if (pauseCallCount === 2) await agent.stop()
        return {
          content: JSON.stringify({ ok: true, status: 'elapsed' }),
          outcome: { ok: true, code: 'elapsed' },
          effects: [{ type: 'pause' }],
        }
      },
    })
    const { repo } = makeMockSnapshotRepo()
    agent = createBotLoopAgent({
      systemPrompt: '',
      context: ctx,
      eventQueue,
      llm,
      tools,
      snapshotRepo: repo,
      renderEvent: renderBotEvent,
      eventDebounceMs: 0,
      autonomy: {
        maxConsecutiveRounds: 1,
        cooldownMs: 60_000,
        now: () => new Date('2026-07-06T00:00:00.000Z'),
        async waitForAttentionOrTimeout() {
          cooldownWaits++
          await agent.stop()
          return 'elapsed'
        },
      },
    })

    await agent.start()

    assert.equal(pauseCallCount, 2)
    assert.equal(llmCallCount, 2)
    assert.equal(cooldownWaits, 0)
  })

  test('appends and immediately persists one reminder after a naturally completed rest', async () => {
    const ctx = createAgentContext()
    ctx.appendUserMessage('older history')
    const eventQueue = new InMemoryEventQueue<BotEvent>()
    eventQueue.enqueue({ type: 'curiosity_tick' })
    const { repo, saved } = makeMockSnapshotRepo()
    const agent = createBotLoopAgent({
      systemPrompt: '',
      context: ctx,
      eventQueue,
      llm: makeMockLlm([{
        content: '',
        toolCalls: [{ id: 'pause-1', name: 'pause', args: {} }],
        usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 2 },
        model: 'mock',
      }]),
      tools: makeMockTools({
        pause: async () => ({
          content: JSON.stringify({
            ok: true,
            status: 'elapsed',
            resumePlan: {
              primaryDirection: '读一篇具体论文',
              alternativeDirection: '复核一条已有研究假设',
            },
          }),
          effects: [{ type: 'pause', status: 'elapsed' }],
        }),
      }),
      snapshotRepo: repo,
      renderEvent: renderBotEvent,
      eventDebounceMs: 0,
      compactOptions: {
        triggerTokens: 1,
        keepRatio: 0.1,
        summarize: async () => validSummary('rest 前的历史'),
      },
      autonomy: {
        now: () => new Date('2026-07-13T08:00:00.000Z'),
      },
    })

    await agent.runOnceForTest()

    const messages = ctx.getSnapshot().messages
    const last = messages.at(-1)
    assert.equal(last?.role, 'user')
    if (last?.role === 'user') {
      assert.match(last.content, /^<system-reminder>\n/)
      assert.match(last.content, /"event":"rest_resume"/)
      assert.doesNotMatch(last.content, /读一篇具体论文/)
    }
    const pauseResultIndex = messages.findIndex((message) => (
      message.role === 'tool' && message.toolCallId === 'pause-1'
    ))
    assert.ok(pauseResultIndex > 0, 'pause tool result must survive compaction')
    const pauseCall = messages[pauseResultIndex - 1]
    assert.equal(pauseCall?.role, 'assistant', 'pause assistant call/result must remain atomic')
    if (pauseCall?.role === 'assistant') {
      assert.equal(pauseCall.toolCalls.at(-1)?.id, 'pause-1')
    }
    assert.ok(pauseResultIndex < messages.length - 1, 'reminder must follow the complete tool result')
    assert.match(
      messages[0]?.role === 'user' ? messages[0].content : '',
      /^\[历史摘要\]/,
      'reminder must be appended after ordinary compaction',
    )
    assert.equal(saved.length, 3, 'pre-round, post-round, and reminder snapshots must be durable')
    assert.deepEqual(saved.at(-1)?.messages, messages)
  })

  test('does not append a reminder when rest is interrupted', async () => {
    const ctx = createAgentContext()
    const eventQueue = new InMemoryEventQueue<BotEvent>()
    eventQueue.enqueue({ type: 'curiosity_tick' })
    const { repo } = makeMockSnapshotRepo()
    const agent = createBotLoopAgent({
      systemPrompt: '',
      context: ctx,
      eventQueue,
      llm: makeMockLlm([{
        content: '',
        toolCalls: [{ id: 'pause-1', name: 'pause', args: {} }],
        usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 2 },
        model: 'mock',
      }]),
      tools: makeMockTools({
        pause: async () => ({
          content: JSON.stringify({ ok: true, status: 'interrupted' }),
          effects: [{ type: 'pause', status: 'interrupted' }],
        }),
      }),
      snapshotRepo: repo,
      renderEvent: renderBotEvent,
      eventDebounceMs: 0,
    })

    await agent.runOnceForTest()

    assert.equal(
      ctx.getSnapshot().messages.some(
        (message) => message.role === 'user' && message.content.startsWith('<system-reminder>'),
      ),
      false,
    )
  })

  test('persists one focus reminder when an attention event interrupts rest', async () => {
    const ctx = createAgentContext()
    ctx.appendAssistantTurn({
      content: '',
      toolCalls: [{ id: 'pause-1', name: 'pause', args: { action: 'rest' } }],
    })
    ctx.appendToolResult({
      toolCallId: 'pause-1',
      content: JSON.stringify({
        ok: true,
        status: 'interrupted',
        resumePlan: {
          primaryDirection: '继续读 QuadRF 的实现说明，先找出采样率换算公式',
          alternativeDirection: '整理刚才发现的一条射频工具线索',
        },
      }),
    })
    const eventQueue = new InMemoryEventQueue<BotEvent>()
    eventQueue.enqueue({
      type: 'napcat_private_message',
      messageRowId: 88,
      peerId: 9001,
      messageId: 20_088,
      senderId: 9001,
      senderNickname: 'Alice',
      mentionedSelf: true,
      sentAt: new Date('2026-07-13T09:00:00.000Z'),
      renderedText: '在吗',
    })
    const { repo, saved } = makeMockSnapshotRepo()
    const agent = createBotLoopAgent({
      systemPrompt: '',
      context: ctx,
      eventQueue,
      llm: makeMockLlm([{
        content: '',
        toolCalls: [],
        usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 0 },
        model: 'mock',
      }]),
      tools: makeMockTools(),
      snapshotRepo: repo,
      renderEvent: renderBotEvent,
      eventDebounceMs: 0,
    })

    await agent.runOnceForTest()

    const reminders = ctx.getSnapshot().messages.filter(
      (message) => message.role === 'user' && message.content.includes('"event":"rest_interrupted_attention"'),
    )
    assert.equal(reminders.length, 1)
    assert.doesNotMatch(reminders[0]?.role === 'user' ? reminders[0].content : '', /QuadRF|采样率|射频工具/)
    assert.equal(
      saved[0]?.messages.some(
        (message) => message.role === 'user' && message.content.includes('"event":"rest_interrupted_attention"'),
      ),
      true,
      'the pre-round snapshot must durably include the reminder',
    )
  })

  test('treats scheduled wake as attention when it interrupts rest', async () => {
    const ctx = createAgentContext()
    ctx.appendAssistantTurn({
      content: '',
      toolCalls: [{ id: 'pause-1', name: 'pause', args: { action: 'rest' } }],
    })
    ctx.appendToolResult({
      toolCallId: 'pause-1',
      content: JSON.stringify({
        ok: true,
        status: 'interrupted',
        resumePlan: {
          primaryDirection: '继续读原来的资料',
          alternativeDirection: '整理上一次的线索',
        },
      }),
    })
    const eventQueue = new InMemoryEventQueue<BotEvent>()
    eventQueue.enqueue(makeScheduledWake())
    const { repo } = makeMockSnapshotRepo()
    const agent = createBotLoopAgent({
      systemPrompt: '',
      context: ctx,
      eventQueue,
      llm: makeMockLlm([{
        content: '',
        toolCalls: [],
        usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 0 },
        model: 'mock',
      }]),
      tools: makeMockTools(),
      snapshotRepo: repo,
      renderEvent: renderBotEvent,
      eventDebounceMs: 0,
    })

    await agent.runOnceForTest()

    const userMessages = ctx.getSnapshot().messages.filter((message) => message.role === 'user')
    assert.equal(userMessages.some((message) => message.content.includes('"event":"scheduled_wake"')), true)
    assert.equal(
      userMessages.some((message) => message.content.includes('"event":"rest_interrupted_attention"')),
      true,
    )
  })

  test('discloses high-priority QQ notification before an earlier scheduled wake', async () => {
    const goalStore = createInMemoryGoalStore()
    const created = await goalStore.createSelf({
      objective: '完成当前研究',
      motivation: '把已有主线做完',
      completionCriteria: ['得到可验证的结论'],
    })
    assert.ok(created.goal)
    const ctx = createAgentContext()
    const eventQueue = new InMemoryEventQueue<BotEvent>()
    eventQueue.enqueue(makeScheduledWake())
    eventQueue.enqueue({
      type: 'napcat_private_message',
      messageRowId: 88,
      peerId: 9001,
      messageId: 20_088,
      senderId: 9001,
      senderNickname: 'Alice',
      mentionedSelf: true,
      sentAt: new Date('2026-07-13T09:00:01.000Z'),
      renderedText: '在吗',
    })
    const { repo } = makeMockSnapshotRepo()
    const agent = createBotLoopAgent({
      systemPrompt: '',
      context: ctx,
      eventQueue,
      llm: makeMockLlm([{
        content: '',
        toolCalls: [],
        usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 0 },
        model: 'mock',
      }]),
      tools: makeMockTools(),
      snapshotRepo: repo,
      goalStore,
      initialGoalRevision: created.goal.revision,
      renderEvent: renderBotEvent,
      eventDebounceMs: 0,
    })

    await agent.runOnceForTest()

    const userMessages = ctx.getSnapshot().messages.filter((message) => message.role === 'user')
    assert.equal(JSON.parse(userMessages[0]!.content).priority, 'high')
    assert.equal(JSON.parse(userMessages[1]!.content).event, 'scheduled_wake')
    assert.equal(JSON.parse(userMessages[2]!.content).event, 'goal_continuation')
  })

  test('keeps mailbox continuity at the newest message after priority reordering', async () => {
    const oldAt = new Date('2026-07-13T06:00:00.000Z')
    const highAt = new Date('2026-07-13T09:00:00.000Z')
    const eventQueue = new InMemoryEventQueue<BotEvent>()
    eventQueue.enqueue({
      type: 'mailbox_backlog',
      mailboxKey: 'qq_group:999',
      priority: 'normal',
      source: { type: 'group', groupId: 999, groupName: '环境群' },
      count: 100,
      firstRowId: 1,
      throughRowId: 100,
      recentAfterRowId: 50,
      senderCount: 10,
      timeRange: { from: new Date(oldAt.getTime() - 60_000), to: oldAt },
    })
    eventQueue.enqueue({
      type: 'napcat_message',
      messageRowId: 101,
      groupId: 999,
      groupName: '环境群',
      messageId: 20_101,
      senderId: 9001,
      senderNickname: 'Alice',
      mentionedSelf: true,
      sentAt: highAt,
      renderedText: '@bot 新消息',
    })
    const ctx = createAgentContext()
    const { repo, savedContinuity } = makeMockSnapshotRepo()
    const agent = createBotLoopAgent({
      systemPrompt: '',
      context: ctx,
      eventQueue,
      llm: makeMockLlm([
        {
          content: '',
          toolCalls: [],
          usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 0 },
          model: 'mock',
        },
        {
          content: '',
          toolCalls: [],
          usage: { inputTokens: 20, cachedTokens: 0, outputTokens: 0 },
          model: 'mock',
        },
      ]),
      tools: makeMockTools(),
      snapshotRepo: repo,
      renderEvent: renderBotEvent,
      eventDebounceMs: 0,
    })

    await agent.runOnceForTest()
    const continuityAfterReordering = structuredClone(savedContinuity.at(-1))

    eventQueue.enqueue({
      type: 'napcat_message',
      messageRowId: 102,
      groupId: 999,
      groupName: '环境群',
      messageId: 20_102,
      senderId: 9002,
      senderNickname: 'Bob',
      mentionedSelf: false,
      sentAt: new Date(highAt.getTime() + 1_000),
      renderedText: '紧邻消息',
    })
    await agent.runOnceForTest()

    const notifications = ctx.getSnapshot().messages
      .filter((message) => message.role === 'user')
      .map((message) => JSON.parse(message.content) as {
        mode?: string
        priority?: string
        throughRowId?: number
        readArgs?: { contextBefore?: number }
      })
    assert.equal(notifications[0]?.priority, 'high')
    assert.equal(notifications[0]?.throughRowId, 101)
    assert.equal(notifications[1]?.mode, 'backlog')
    assert.equal(continuityAfterReordering?.mailboxes['qq_group:999']?.lastMessageAtMs, highAt.getTime())
    assert.equal(notifications[2]?.throughRowId, 102)
    assert.equal(notifications[2]?.readArgs?.contextBefore, undefined)
  })

  test('sorts high backlog and mentioned group batches before a scheduled wake', async () => {
    const eventQueue = new InMemoryEventQueue<BotEvent>()
    eventQueue.enqueue(makeScheduledWake())
    eventQueue.enqueue({
      type: 'mailbox_backlog',
      mailboxKey: 'qq_private:9001',
      priority: 'high',
      source: { type: 'private', peerId: 9001, senderName: 'Alice' },
      count: 100,
      firstRowId: 1,
      throughRowId: 100,
      recentAfterRowId: 50,
      senderCount: 1,
      timeRange: {
        from: new Date('2026-07-13T08:00:00.000Z'),
        to: new Date('2026-07-13T08:30:00.000Z'),
      },
    })
    eventQueue.enqueue({
      type: 'napcat_message',
      messageRowId: 101,
      groupId: 999,
      groupName: '环境群',
      messageId: 20_101,
      senderId: 9002,
      senderNickname: 'Bob',
      mentionedSelf: true,
      sentAt: new Date('2026-07-13T09:00:00.000Z'),
      renderedText: '@bot 新消息',
    })
    const ctx = createAgentContext()
    const { repo } = makeMockSnapshotRepo()
    const agent = createBotLoopAgent({
      systemPrompt: '',
      context: ctx,
      eventQueue,
      llm: makeMockLlm([{
        content: '',
        toolCalls: [],
        usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 0 },
        model: 'mock',
      }]),
      tools: makeMockTools(),
      snapshotRepo: repo,
      renderEvent: renderBotEvent,
      eventDebounceMs: 0,
    })

    await agent.runOnceForTest()

    const userMessages = ctx.getSnapshot().messages.filter((message) => message.role === 'user')
    assert.equal(JSON.parse(userMessages[0]!.content).mode, 'backlog')
    assert.equal(JSON.parse(userMessages[0]!.content).priority, 'high')
    assert.equal(JSON.parse(userMessages[1]!.content).priority, 'high')
    assert.equal(JSON.parse(userMessages[1]!.content).throughRowId, 101)
    assert.equal(JSON.parse(userMessages[2]!.content).event, 'scheduled_wake')
  })

  test('discloses scheduled wake before the active goal continuation', async () => {
    const goalStore = createInMemoryGoalStore()
    const created = await goalStore.createSelf({
      objective: '完成当前研究',
      motivation: '把已有主线做完',
      completionCriteria: ['得到可验证的结论'],
    })
    assert.ok(created.goal)
    const ctx = createAgentContext()
    const eventQueue = new InMemoryEventQueue<BotEvent>()
    eventQueue.enqueue(makeScheduledWake())
    const { repo } = makeMockSnapshotRepo()
    const agent = createBotLoopAgent({
      systemPrompt: '',
      context: ctx,
      eventQueue,
      llm: makeMockLlm([{
        content: '',
        toolCalls: [],
        usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 0 },
        model: 'mock',
      }]),
      tools: makeMockTools(),
      snapshotRepo: repo,
      goalStore,
      initialGoalRevision: created.goal.revision,
      renderEvent: renderBotEvent,
      eventDebounceMs: 0,
    })

    await agent.runOnceForTest()

    const userMessages = ctx.getSnapshot().messages.filter((message) => message.role === 'user')
    assert.equal(JSON.parse(userMessages[0]!.content).event, 'scheduled_wake')
    assert.equal(JSON.parse(userMessages[1]!.content).event, 'goal_continuation')
  })

  test('discloses active goal continuation before an ambient mailbox notification', async () => {
    const goalStore = createInMemoryGoalStore()
    const created = await goalStore.createSelf({
      objective: '完成当前研究',
      motivation: '把已有主线做完',
      completionCriteria: ['得到可验证的结论'],
    })
    assert.ok(created.goal)
    const ctx = createAgentContext()
    const eventQueue = new InMemoryEventQueue<BotEvent>()
    eventQueue.enqueue({
      type: 'napcat_message',
      messageRowId: 89,
      groupId: 999,
      groupName: '环境群',
      messageId: 20_089,
      senderId: 9002,
      senderNickname: 'Bob',
      mentionedSelf: false,
      sentAt: new Date('2026-07-13T09:00:01.000Z'),
      renderedText: '普通群消息',
    })
    const { repo } = makeMockSnapshotRepo()
    const agent = createBotLoopAgent({
      systemPrompt: '',
      context: ctx,
      eventQueue,
      llm: makeMockLlm([{
        content: '',
        toolCalls: [],
        usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 0 },
        model: 'mock',
      }]),
      tools: makeMockTools(),
      snapshotRepo: repo,
      goalStore,
      initialGoalRevision: created.goal.revision,
      renderEvent: renderBotEvent,
      eventDebounceMs: 0,
    })

    await agent.runOnceForTest()

    const userMessages = ctx.getSnapshot().messages.filter((message) => message.role === 'user')
    assert.equal(JSON.parse(userMessages[0]!.content).event, 'goal_continuation')
    assert.equal(JSON.parse(userMessages[1]!.content).priority, 'normal')
  })

  test('delegates tool execution failures to the React kernel durable error result path', async () => {
    const ctx = createAgentContext()
    const eventQueue = new InMemoryEventQueue<BotEvent>()
    eventQueue.enqueue({ type: 'curiosity_tick' })
    const { repo } = makeMockSnapshotRepo()
    const agent = createBotLoopAgent({
      systemPrompt: 'you are a bot',
      context: ctx,
      eventQueue,
      llm: makeMockLlm([{
        content: '',
        toolCalls: [{ id: 'boom-1', name: 'boom', args: {} }],
        usage: { inputTokens: 4, cachedTokens: 0, outputTokens: 3 },
        model: 'mock',
      }]),
      tools: makeMockTools({
        boom: async () => {
          throw new Error('kernel catches this')
        },
      }),
      snapshotRepo: repo,
      renderEvent: renderBotEvent,
      eventDebounceMs: 0,
    })

    await agent.runOnceForTest()

    const toolMessage = ctx.getSnapshot().messages.find((message) => message.role === 'tool')
    assert.equal(toolMessage?.role, 'tool')
    if (toolMessage?.role === 'tool') {
      assert.equal(toolMessage.toolCallId, 'boom-1')
      assert.equal(typeof toolMessage.content, 'string')
      const content = JSON.parse(toolMessage.content as string) as { code?: unknown; error?: unknown }
      assert.equal(content.code, 'execution_failed')
      const error = content.error
      if (typeof error !== 'string') {
        assert.fail('expected durable error content to include an error string')
      }
      assert.match(error, /kernel catches this/)
    }
  })

  test('effect interpreter rejects pause effects returned by non-pause tools', async () => {
    const ctx = createAgentContext()
    const eventQueue = new InMemoryEventQueue<BotEvent>()
    eventQueue.enqueue({ type: 'curiosity_tick' })
    let llmCallCount = 0
    let cooldownWaits = 0
    let agent: ReturnType<typeof createBotLoopAgent>
    const llm: LlmClient = {
      async chat() {
        llmCallCount++
        if (llmCallCount === 3) await agent.stop()
        return {
          content: '',
          toolCalls: llmCallCount === 1
            ? [{ id: 'lookup-1', name: 'lookup', args: {} }]
            : [],
          usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 5 },
          model: 'mock',
        }
      },
    }
    const tools = makeMockTools({
      lookup: async () => ({
        content: '{"ok":true}',
        effects: [{ type: 'pause' }],
      }),
    })
    const { repo } = makeMockSnapshotRepo()

    agent = createBotLoopAgent({
      systemPrompt: 'you are a bot',
      context: ctx,
      eventQueue,
      llm,
      tools,
      snapshotRepo: repo,
      renderEvent: renderBotEvent,
      eventDebounceMs: 0,
      autonomy: {
        maxConsecutiveRounds: 2,
        cooldownMs: 60_000,
        async waitForAttentionOrTimeout() {
          cooldownWaits++
          await agent.stop()
          return 'elapsed'
        },
      },
    })

    await agent.start()

    assert.equal(llmCallCount, 2)
    assert.equal(cooldownWaits, 1)
  })

  test('send_message 非 sent 状态即使 ok=true 也立即跑下一轮让 LLM 修正', async () => {
    const ctx = createAgentContext()
    const eventQueue = new InMemoryEventQueue<BotEvent>()
    eventQueue.enqueue({
      type: 'napcat_message',
      messageRowId: 1,
      groupId: 999,
      messageId: 12345,
      senderId: 100,
      senderNickname: '张三',
      mentionedSelf: true,
      sentAt: new Date('2026-01-01T00:00:00Z'),
      renderedText: 'hello',
    })

    let llmCallCount = 0
    let agent: ReturnType<typeof createBotLoopAgent>
    const llm: LlmClient = {
      async chat() {
        llmCallCount++
        if (llmCallCount === 1) {
          return {
            content: '',
            toolCalls: [{ id: 'c1', name: 'send_message', args: { text: '在' } }],
            usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 5 },
            model: 'mock',
          }
        }
        return {
          content: '',
          toolCalls: [{ id: 'c2', name: 'rest', args: { durationSeconds: 30 } }],
          usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 5 },
          model: 'mock',
        }
      },
    }

    let restCalled = false
    const tools = makeMockTools({
      send_message: async () => ({ content: '{"ok":true,"status":"rejected","error":"not allowed"}' }),
      rest: async () => {
        restCalled = true
        await agent.stop()
        return { content: '[休息结束] 已休息约 30 秒。' }
      },
    })
    const { repo } = makeMockSnapshotRepo()

    agent = createBotLoopAgent({
      systemPrompt: 'you are a bot',
      context: ctx,
      eventQueue,
      llm,
      tools,
      snapshotRepo: repo,
      renderEvent: async (event) => {
        if (event.type !== 'napcat_message') return null
        return `[${event.senderNickname}] hello`
      },
      eventDebounceMs: 0,
    })

    const startPromise = agent.start()
    try {
      await new Promise((resolve) => setTimeout(resolve, 50))
      assert.ok(llmCallCount >= 2, `expected LLM to see rejected send result, got ${llmCallCount}`)
      assert.equal(restCalled, true)
    } finally {
      await agent.stop()
      await startPromise
    }
  })

  test('高 token 使用不触发跨日限流，只在连续轮次达到上限后短暂冷却', async () => {
    const ctx = createAgentContext()
    const eventQueue = new InMemoryEventQueue<BotEvent>()
    eventQueue.enqueue({ type: 'curiosity_tick' })
    let llmCallCount = 0
    let cooldownWaits = 0
    let agent: ReturnType<typeof createBotLoopAgent>
    const llm: LlmClient = {
      async chat() {
        llmCallCount++
        if (llmCallCount === 3) await agent.stop()
        return {
          content: '',
          toolCalls: [],
          usage: { inputTokens: 500_000, cachedTokens: 0, outputTokens: 500_000 },
          model: 'mock',
        }
      },
    }
    const { repo } = makeMockSnapshotRepo()

    agent = createBotLoopAgent({
      systemPrompt: 'you are a bot',
      context: ctx,
      eventQueue,
      llm,
      tools: makeMockTools(),
      snapshotRepo: repo,
      renderEvent: renderBotEvent,
      eventDebounceMs: 0,
      autonomy: {
        maxConsecutiveRounds: 2,
        cooldownMs: 60_000,
        async waitForAttentionOrTimeout(_queue, timeoutMs) {
          cooldownWaits++
          assert.equal(timeoutMs, 60_000)
          await agent.stop()
          return 'elapsed'
        },
      },
    })

    await agent.start()

    assert.equal(llmCallCount, 2)
    assert.equal(cooldownWaits, 1)
  })

  test('参数校验失败的 pause 不会重置连续轮次保护', async () => {
    const ctx = createAgentContext()
    const eventQueue = new InMemoryEventQueue<BotEvent>()
    eventQueue.enqueue({ type: 'curiosity_tick' })
    let llmCallCount = 0
    let cooldownWaits = 0
    let agent: ReturnType<typeof createBotLoopAgent>
    const llm: LlmClient = {
      async chat() {
        llmCallCount++
        if (llmCallCount === 3) await agent.stop()
        return {
          content: '',
          toolCalls: llmCallCount === 1
            ? [{ id: 'bad-pause', name: 'pause', args: {} }]
            : [],
          usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 5 },
          model: 'mock',
        }
      },
    }
    const { repo } = makeMockSnapshotRepo()

    agent = createBotLoopAgent({
      systemPrompt: 'you are a bot',
      context: ctx,
      eventQueue,
      llm,
      tools: makeMockTools({
        pause: async () => ({ content: '{"error":"Invalid tool arguments"}' }),
      }),
      snapshotRepo: repo,
      renderEvent: renderBotEvent,
      eventDebounceMs: 0,
      autonomy: {
        maxConsecutiveRounds: 2,
        cooldownMs: 60_000,
        async waitForAttentionOrTimeout() {
          cooldownWaits++
          await agent.stop()
          return 'elapsed'
        },
      },
    })

    await agent.start()

    assert.equal(llmCallCount, 2)
    assert.equal(cooldownWaits, 1)
  })

  test('assistant 返回 no tool calls 时不把 text-only 思考写入 context', async () => {
    const ctx = createAgentContext()
    const eventQueue = new InMemoryEventQueue<BotEvent>()
    eventQueue.enqueue({
      type: 'napcat_message',
      messageRowId: 1,
      groupId: 999,
      messageId: 12345,
      senderId: 100,
      senderNickname: '张三',
      mentionedSelf: true,
      sentAt: new Date('2026-01-01T00:00:00Z'),
      renderedText: 'hello',
    })

    let llmCallCount = 0
    let restCalled = false
    let agent: ReturnType<typeof createBotLoopAgent>
    const llm: LlmClient = {
      async chat() {
        llmCallCount++
        if (llmCallCount === 1) {
          return {
            content: '先想一下',
            toolCalls: [],
            usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 5 },
            model: 'mock',
          }
        }
        return {
          content: '',
          toolCalls: [{ id: 'c2', name: 'rest', args: { durationSeconds: 30 } }],
          usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 5 },
          model: 'mock',
        }
      },
    }

    const tools = makeMockTools({
      rest: async () => {
        restCalled = true
        await agent.stop()
        return { content: '[休息结束] 已休息约 30 秒。' }
      },
    })
    const { repo } = makeMockSnapshotRepo()

    agent = createBotLoopAgent({
      systemPrompt: 'you are a bot',
      context: ctx,
      eventQueue,
      llm,
      tools,
      snapshotRepo: repo,
      renderEvent: async (event) => {
        if (event.type !== 'napcat_message') return null
        return `[${event.senderNickname}] hello`
      },
      eventDebounceMs: 0,
    })

    const startPromise = agent.start()
    await new Promise((resolve) => setTimeout(resolve, 50))

    assert.ok(llmCallCount >= 2, `expected LLM to choose next action itself, got ${llmCallCount}`)
    assert.equal(restCalled, true)
    assert.equal(
      ctx.getSnapshot().messages.some((msg) => msg.role === 'assistant' && msg.content === '先想一下'),
      false,
      'text-only assistant output is transient telemetry, not durable context',
    )

    await startPromise
  })

  test('send_message 参数不做隐藏思考 preflight 拦截', async () => {
    const ctx = createAgentContext()
    const eventQueue = new InMemoryEventQueue<BotEvent>()
    eventQueue.enqueue({
      type: 'napcat_message',
      messageRowId: 1,
      groupId: 999,
      messageId: 12345,
      senderId: 100,
      senderNickname: '张三',
      mentionedSelf: true,
      sentAt: new Date('2026-01-01T00:00:00Z'),
      renderedText: 'hello',
    })

    const llm = makeMockLlm([
      {
        content: '',
        toolCalls: [{
          id: 'c1',
          name: 'send_message',
          args: {
            target: { type: 'private', userId: 10001 },
            mode: 'ambient',
            text: '收到。\n\n*思考: 这段不能进长期上下文。*',
            replyToMessageId: null,
            imageRef: null,
          },
        }],
        usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 5 },
        model: 'mock',
      },
    ])

    let toolExecuted = false
    const tools = makeMockTools({
      send_message: async () => {
        toolExecuted = true
        return { content: '{"ok":true,"status":"sent"}' }
      },
    })
    const { repo } = makeMockSnapshotRepo()

    const agent = createBotLoopAgent({
      systemPrompt: 'you are a bot',
      context: ctx,
      eventQueue,
      llm,
      tools,
      snapshotRepo: repo,
      renderEvent: async (event) => {
        if (event.type !== 'napcat_message') return null
        return `[${event.senderNickname}] hello`
      },
      eventDebounceMs: 0,
    })

    await agent.runOnceForTest()

    const messages = ctx.getSnapshot().messages
    assert.equal(toolExecuted, true)

    const assistant = messages.find((msg) => msg.role === 'assistant')
    assert.equal(assistant?.role, 'assistant')
    if (assistant?.role === 'assistant') {
      assert.equal(assistant.toolCalls[0]?.args.text, '收到。\n\n*思考: 这段不能进长期上下文。*')
    }

    const toolResult = messages.find((msg) => msg.role === 'tool')
    assert.equal(toolResult?.role, 'tool')
    if (toolResult?.role === 'tool' && typeof toolResult.content === 'string') {
      assert.equal(toolResult.content, '{"ok":true,"status":"sent"}')
    }
  })

  test('renderEvent returning null skips appending', async () => {
    const ctx = createAgentContext()
    const eventQueue = new InMemoryEventQueue<BotEvent>()
    eventQueue.enqueue({
      type: 'background_task_completed',
      taskId: 'task-1',
      toolName: 'test',
      description: 'skip me',
      elapsedMs: 1,
      ok: true,
      summary: 'skip me',
    })

    const llm = makeMockLlm([
      {
        content: '',
        toolCalls: [],
        usage: { inputTokens: 0, cachedTokens: 0, outputTokens: 0 },
        model: 'mock',
      },
    ])
    const { repo } = makeMockSnapshotRepo()

    const agent = createBotLoopAgent({
      systemPrompt: '',
      context: ctx,
      eventQueue,
      llm,
      tools: makeMockTools(),
      snapshotRepo: repo,
      renderEvent: () => null,
      eventDebounceMs: 0,
    })

    await agent.runOnceForTest()
    assert.equal(ctx.getSnapshot().messages.length, 0)
  })
})
