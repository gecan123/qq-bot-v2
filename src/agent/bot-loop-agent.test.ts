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
    })

    await agent.runOnceForTest()

    const messages = ctx.getSnapshot().messages
    assert.equal(messages.length, 3, 'user + assistant + tool')
    assert.equal(messages[0]?.role, 'user')
    assert.equal(messages[1]?.role, 'assistant')
    assert.equal(messages[2]?.role, 'tool')
    assert.equal(toolExecuted, true)
    assert.equal(saved.length, 1, 'snapshot persisted once')
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
    })

    await agent.runOnceForTest()
    assert.equal(ctx.getSnapshot().messages.length, 0, 'wake events must not enter context')
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
    })

    await agent.runOnceForTest()
    assert.equal(ctx.getSnapshot().messages.length, 0)
  })
})
