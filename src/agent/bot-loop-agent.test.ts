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
} {
  const saved: PersistedAgentSnapshot[] = []
  const savedCursors: Array<MailboxCursors | undefined> = []
  const savedLastWakeAt: Array<Date | null> = []
  const repo: BotSnapshotRepo = {
    async load() {
      return null
    },
    async save(input) {
      saved.push(input.snapshot)
      savedCursors.push((input as typeof input & { mailboxCursors?: MailboxCursors }).mailboxCursors)
      savedLastWakeAt.push(input.lastWakeAt)
    },
  }
  return { repo, saved, savedCursors, savedLastWakeAt }
}

// Note: 'send_group_message' references in fixtures below are intentionally retained as the
// historical (MVP-1) tool name, mirroring how persisted bot snapshots from before the MVP-2
// rename look on disk. New code calls the tool 'send_message' (see src/agent/tools/send-message.ts);
// already-persisted history stays as-is (red line 5: byte stability of historical turns).
describe('BotLoopAgent.runOnceForTest', () => {
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
          return 'summary'
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
    assert.deepEqual(
      saved.at(-1),
      ctx.exportPersistedSnapshot(),
      'the snapshot saved at the end of the step must include compaction output',
    )
    assert.equal(saved.at(-1)?.messages[0]?.role, 'user')
    if (saved.at(-1)?.messages[0]?.role === 'user') {
      assert.match(saved.at(-1)!.messages[0]!.content, /^\[历史摘要\]/)
    }
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
            args: { action: 'rest', durationSeconds: 300, intention: '醒来后继续自己的研究' },
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
        dailyTokenBudget: 10_000,
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
        dailyTokenBudget: 1_000_000,
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

  test('连续轮次达到上限后自动冷却', async () => {
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
      tools: makeMockTools(),
      snapshotRepo: repo,
      renderEvent: renderBotEvent,
      eventDebounceMs: 0,
      autonomy: {
        maxConsecutiveRounds: 2,
        cooldownMs: 60_000,
        dailyTokenBudget: 1_000_000,
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
        dailyTokenBudget: 1_000_000,
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

  test('每日预算耗尽后由注意事件唤醒并获得一个连续处理窗口', async () => {
    const ctx = createAgentContext()
    const eventQueue = new InMemoryEventQueue<BotEvent>()
    eventQueue.enqueue({ type: 'curiosity_tick' })
    let llmCallCount = 0
    let budgetWaits = 0
    let pauseCalled = false
    let agent: ReturnType<typeof createBotLoopAgent>
    const llm: LlmClient = {
      async chat() {
        llmCallCount++
        if (llmCallCount === 1) {
          return {
            content: '',
            toolCalls: [],
            usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 5 },
            model: 'mock',
          }
        }
        return {
          content: '',
          toolCalls: [{ id: 'pause-1', name: 'pause', args: {} }],
          usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 5 },
          model: 'mock',
        }
      },
    }
    const tools = makeMockTools({
      pause: async () => {
        pauseCalled = true
        await agent.stop()
        return { content: '[休息结束]' }
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
      renderEvent: renderBotEvent,
      eventDebounceMs: 0,
      autonomy: {
        maxConsecutiveRounds: 20,
        cooldownMs: 60_000,
        dailyTokenBudget: 15,
        now: () => new Date('2026-07-06T00:00:00.000Z'),
        async waitForAttentionOrTimeout(queue) {
          budgetWaits++
          queue.enqueue({
            type: 'napcat_private_message',
            messageRowId: 99,
            peerId: 400,
            messageId: 500,
            senderId: 400,
            senderNickname: '朋友',
            mentionedSelf: true,
            sentAt: new Date('2026-07-06T00:00:01.000Z'),
            renderedText: '醒醒',
          })
          return 'attention'
        },
      },
    })

    await agent.start()

    assert.equal(budgetWaits, 1)
    assert.equal(llmCallCount, 2)
    assert.equal(pauseCalled, true)
  })

  test('每日预算在新的一天自动重置', async () => {
    const ctx = createAgentContext()
    const eventQueue = new InMemoryEventQueue<BotEvent>()
    eventQueue.enqueue({ type: 'curiosity_tick' })
    let now = new Date('2026-07-06T00:00:00.000Z')
    let llmCallCount = 0
    let budgetWaits = 0
    let agent: ReturnType<typeof createBotLoopAgent>
    const llm: LlmClient = {
      async chat() {
        llmCallCount++
        return {
          content: '',
          toolCalls: llmCallCount === 1 ? [] : [{ id: 'pause-1', name: 'pause', args: {} }],
          usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 5 },
          model: 'mock',
        }
      },
    }
    const tools = makeMockTools({
      pause: async () => {
        await agent.stop()
        return { content: '[休息结束]' }
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
      renderEvent: renderBotEvent,
      eventDebounceMs: 0,
      autonomy: {
        maxConsecutiveRounds: 20,
        cooldownMs: 60_000,
        dailyTokenBudget: 15,
        now: () => now,
        async waitForAttentionOrTimeout() {
          budgetWaits++
          now = new Date('2026-07-07T00:00:00.000Z')
          return 'elapsed'
        },
      },
    })

    await agent.start()

    assert.equal(llmCallCount, 2)
    assert.equal(budgetWaits, 1)
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
