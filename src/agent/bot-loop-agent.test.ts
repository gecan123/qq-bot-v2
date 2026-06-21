import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { createBotLoopAgent } from './bot-loop-agent.js'
import { createAgentContext } from './agent-context.js'
import { InMemoryEventQueue } from './event-queue.js'
import type { BotEvent } from './event.js'
import type { LlmClient, LlmCallOutput } from './llm-client.js'
import type { ToolExecutor } from './tool.js'
import type { BotSnapshotRepo } from './snapshot-repo.js'
import type { PersistedAgentSnapshot } from './agent-context.types.js'

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

function makeMockTools(impl: Record<string, () => Promise<{ content: string }>> = {}): ToolExecutor {
  const noop = async () => ({ content: 'ok' })
  return {
    list: () => [],
    async execute(call) {
      const fn = impl[call.name] ?? noop
      return fn()
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

// Note: 'send_group_message' references in fixtures below are intentionally retained as the
// historical (MVP-1) tool name, mirroring how persisted bot snapshots from before the MVP-2
// rename look on disk. New code calls the tool 'send_message' (see src/agent/tools/send-message.ts);
// already-persisted history stays as-is (red line 5: byte stability of historical turns).
describe('BotLoopAgent.runOnceForTest', () => {
  test('drains napcat events into context as user messages, runs LLM, executes tools', async () => {
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
        return { content: '{"ok":true}' }
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
        return { content: '{"ok":true}' }
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

  test('send_message 后没有新外部事件时主循环阻塞, 不重复回复同一批消息', async () => {
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
        await agent.stop()
        return {
          content: '',
          toolCalls: [{ id: 'c2', name: 'send_message', args: { text: '又回一次' } }],
          usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 5 },
          model: 'mock',
        }
      },
    }

    let sendMessageCount = 0
    const tools = makeMockTools({
      send_message: async () => {
        sendMessageCount++
        return { content: '{"ok":true}' }
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

      assert.equal(llmCallCount, 1, 'send_message 后应等新事件, 不能立刻下一轮重看同一条消息')
      assert.equal(sendMessageCount, 1)
    } finally {
      await agent.stop()
      await startPromise
    }
  })

  test('send_message 返回失败时立即跑下一轮让 LLM 修正', async () => {
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
      send_message: async () => ({ content: '{"ok":false,"error":"Invalid tool arguments"}' }),
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

    assert.ok(llmCallCount >= 2, `expected LLM to see failed send result, got ${llmCallCount}`)
    assert.equal(restCalled, true)

    await startPromise
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
        return { content: '{"ok":true}' }
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
      assert.equal(toolResult.content, '{"ok":true}')
    }
  })

  test('renderEvent returning null skips appending', async () => {
    const ctx = createAgentContext()
    const eventQueue = new InMemoryEventQueue<BotEvent>()
    eventQueue.enqueue({
      type: 'napcat_message',
      messageRowId: 7,
      groupId: 999,
      messageId: 12347,
      senderId: 100,
      senderNickname: 'spam',
      mentionedSelf: false,
      sentAt: new Date(),
      renderedText: 'spam content',
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
