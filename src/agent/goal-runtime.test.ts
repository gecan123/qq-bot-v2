import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { createAgentContext } from './agent-context.js'
import { createBotLoopAgent } from './bot-loop-agent.js'
import { InMemoryEventQueue } from './event-queue.js'
import type { BotEvent } from './event.js'
import { createInMemoryGoalStore } from './goal-store.js'
import { renderBotEvent } from './render-event.js'
import type { BotSnapshotRepo } from './snapshot-repo.js'
import { createToolExecutor } from './tool.js'
import { createGoalTool } from './tools/goal.js'

function validSummary(content: string): string {
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

describe('BotLoop goal integration', () => {
  test('creates a self goal during ordinary autonomy and continues it on the next foreground round', async () => {
    const context = createAgentContext()
    const goalStore = createInMemoryGoalStore()
    let calls = 0
    const agent = createBotLoopAgent({
      systemPrompt: '',
      context,
      eventQueue: new InMemoryEventQueue<BotEvent>(),
      llm: {
        async chat() {
          calls++
          if (calls === 1) {
            return {
              content: '',
              toolCalls: [{
                id: 'self-goal-create-1',
                name: 'goal',
                args: {
                  action: 'create_self',
                  objective: '把一个兴趣发展成可验证结论',
                  motivation: '我想持续追踪新证据',
                  completionCriteria: ['形成结论', '记录反例'],
                },
              }],
              usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 2 },
              model: 'mock', stopReason: 'tool_use' as const,
            }
          }
          const goal = (await goalStore.get())!
          return {
            content: '',
            toolCalls: [{
              id: 'self-goal-complete-1',
              name: 'goal',
              args: { action: 'complete', goalId: goal.goalId, evidence: ['结论与反例均已记录'] },
            }],
            usage: { inputTokens: 12, cachedTokens: 4, outputTokens: 3 },
            model: 'mock', stopReason: 'tool_use' as const,
          }
        },
      },
      tools: createToolExecutor([createGoalTool(goalStore)]),
      snapshotRepo: makeSnapshotRepo([]),
      renderEvent: renderBotEvent,
      eventDebounceMs: 0,
      goalStore,
    })

    context.appendUserMessage('开始普通自主活动')
    await agent.runOnceForTest()
    assert.equal((await goalStore.get())?.origin, 'self')
    assert.equal((await goalStore.get())?.tokensUsed, 0)

    await agent.runOnceForTest()
    const completed = await goalStore.get()
    assert.equal(completed?.status, 'complete')
    assert.equal(completed?.tokensUsed, 11)
    const users = context.getSnapshot().messages.filter((message) => message.role === 'user')
    const continuation = users.find((message) => message.content.includes('goal_continuation'))
    assert.match(continuation?.content ?? '', /"origin":"self"/)
    assert.match(continuation?.content ?? '', /"completionCriteria":\["形成结论","记录反例"\]/)
  })

  test('active goal is disclosed, continued, completed and accounted in one serial foreground round', async () => {
    const context = createAgentContext()
    const goalStore = createInMemoryGoalStore()
    await goalStore.applyControl({
      messageRowId: 10,
      command: { action: 'set', objective: '完成测试目标', tokenBudget: 100 },
    })
    const goal = (await goalStore.get())!
    const savedGoalRevisions: number[] = []
    const snapshotRepo = makeSnapshotRepo(savedGoalRevisions)
    const agent = createBotLoopAgent({
      systemPrompt: '',
      context,
      eventQueue: new InMemoryEventQueue<BotEvent>(),
      llm: {
        async chat() {
          return {
            content: '',
            toolCalls: [{
              id: 'goal-complete-1',
              name: 'goal',
              args: { action: 'complete', goalId: goal.goalId, evidence: ['测试证据'] },
            }],
            usage: { inputTokens: 20, cachedTokens: 5, outputTokens: 4 },
            model: 'mock',
            stopReason: 'tool_use' as const,
          }
        },
      },
      tools: createToolExecutor([createGoalTool(goalStore)]),
      snapshotRepo,
      renderEvent: renderBotEvent,
      eventDebounceMs: 0,
      goalStore,
      initialGoalRevision: 0,
    })

    await agent.runOnceForTest()

    const finished = await goalStore.get()
    assert.equal(finished?.status, 'complete')
    assert.equal(finished?.tokensUsed, 19)
    const userMessages = context.getSnapshot().messages
      .filter((message) => message.role === 'user')
      .map((message) => message.content)
    assert.match(userMessages[0]!, /goal_state_changed/)
    assert.match(userMessages[1]!, /goal_continuation/)
    assert.match(userMessages.at(-1)!, /"status":"complete"/)
    assert.equal(savedGoalRevisions.at(-1), finished?.revision)
  })

  test('priority attention is appended after goal continuation and budget transition stops goal continuation', async () => {
    const context = createAgentContext()
    const goalStore = createInMemoryGoalStore()
    await goalStore.applyControl({
      messageRowId: 1,
      command: { action: 'set', objective: '有限预算目标', tokenBudget: 5 },
    })
    const queue = new InMemoryEventQueue<BotEvent>()
    queue.enqueue({
      type: 'napcat_private_message',
      messageRowId: 2,
      peerId: 100,
      messageId: 22,
      senderId: 100,
      senderNickname: 'owner',
      mentionedSelf: true,
      sentAt: new Date('2026-07-12T00:00:00Z'),
      renderedText: '先看一下',
    })
    const agent = createBotLoopAgent({
      systemPrompt: '',
      context,
      eventQueue: queue,
      llm: {
        async chat() {
          return {
            content: '', toolCalls: [],
            usage: { inputTokens: 8, cachedTokens: 0, outputTokens: 1 },
            model: 'mock', stopReason: 'end_turn' as const,
          }
        },
      },
      tools: createToolExecutor([]),
      snapshotRepo: makeSnapshotRepo([]),
      renderEvent: renderBotEvent,
      eventDebounceMs: 0,
      goalStore,
    })

    await agent.runOnceForTest()

    const goal = await goalStore.get()
    assert.equal(goal?.status, 'budget_limited')
    const users = context.getSnapshot().messages.filter((message) => message.role === 'user')
    assert.match(users[1]!.content, /goal_continuation/)
    assert.match(users[2]!.content, /inbox_update/)
    assert.match(users.at(-1)!.content, /budget_limited/)
  })

  test('resume with an already disclosed active goal adds continuation without duplicating state event', async () => {
    const context = createAgentContext()
    const goalStore = createInMemoryGoalStore()
    await goalStore.applyControl({
      messageRowId: 1,
      command: { action: 'set', objective: '重启后继续', tokenBudget: null },
    })
    const goal = (await goalStore.get())!
    const agent = createBotLoopAgent({
      systemPrompt: '',
      context,
      eventQueue: new InMemoryEventQueue<BotEvent>(),
      llm: {
        async chat() {
          return {
            content: '', toolCalls: [],
            usage: { inputTokens: 0, cachedTokens: 0, outputTokens: 0 },
            model: 'mock', stopReason: 'end_turn' as const,
          }
        },
      },
      tools: createToolExecutor([]),
      snapshotRepo: makeSnapshotRepo([]),
      renderEvent: renderBotEvent,
      eventDebounceMs: 0,
      goalStore,
      initialGoalRevision: goal.revision,
    })

    await agent.runOnceForTest()
    const users = context.getSnapshot().messages.filter((message) => message.role === 'user')
    assert.equal(users.length, 1)
    assert.match(users[0]!.content, /goal_continuation/)
  })

  test('re-injects the active goal after ordinary compaction', async () => {
    const context = createAgentContext()
    const goalStore = createInMemoryGoalStore()
    await goalStore.applyControl({
      messageRowId: 1,
      command: { action: 'set', objective: '压缩后继续', tokenBudget: null },
    })
    const agent = createBotLoopAgent({
      systemPrompt: '',
      context,
      eventQueue: new InMemoryEventQueue<BotEvent>(),
      llm: {
        async chat() {
          return {
            content: '', toolCalls: [],
            usage: { inputTokens: 10, cachedTokens: 10, outputTokens: 0 },
            model: 'mock', stopReason: 'end_turn' as const,
          }
        },
      },
      tools: createToolExecutor([]),
      snapshotRepo: makeSnapshotRepo([]),
      renderEvent: renderBotEvent,
      eventDebounceMs: 0,
      goalStore,
      compactOptions: {
        triggerTokens: 1,
        keepRatio: 0.5,
        summarize: async () => validSummary('压缩摘要'),
      },
    })

    await agent.runOnceForTest()

    const messages = context.getSnapshot().messages
    assert.equal(messages[0]?.role, 'user')
    assert.match(messages[0]!.content, /\[历史摘要\]/)
    const lastMessage = messages.at(-1)
    assert.match(lastMessage?.role === 'user' ? lastMessage.content : '', /post_compaction/)
  })

  test('keeps the rest resume reminder after post-compaction goal continuation', async () => {
    const context = createAgentContext()
    const goalStore = createInMemoryGoalStore()
    await goalStore.applyControl({
      messageRowId: 1,
      command: { action: 'set', objective: '醒来后继续推进', tokenBudget: null },
    })
    const agent = createBotLoopAgent({
      systemPrompt: '',
      context,
      eventQueue: new InMemoryEventQueue<BotEvent>(),
      llm: {
        async chat() {
          return {
            content: '',
            toolCalls: [{ id: 'pause-1', name: 'pause', args: {} }],
            usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 1 },
            model: 'mock', stopReason: 'tool_use' as const,
          }
        },
      },
      tools: {
        list: () => [],
        async execute() {
          return {
            content: JSON.stringify({ ok: true, status: 'elapsed', resumePlan: {} }),
            effects: [{ type: 'pause', status: 'elapsed' }],
          }
        },
      },
      snapshotRepo: makeSnapshotRepo([]),
      renderEvent: renderBotEvent,
      eventDebounceMs: 0,
      goalStore,
      compactOptions: {
        triggerTokens: 1,
        keepRatio: 0.5,
        summarize: async () => validSummary('休息前摘要'),
      },
      autonomy: {
        now: () => new Date('2026-07-13T08:00:00.000Z'),
      },
    })

    await agent.runOnceForTest()

    const messages = context.getSnapshot().messages
    const continuation = messages.at(-2)
    const reminder = messages.at(-1)
    assert.match(
      continuation?.role === 'user' ? continuation.content : '',
      /"reason":"post_compaction"/,
    )
    assert.match(
      reminder?.role === 'user' ? reminder.content : '',
      /^<system-reminder>\n\{"event":"rest_resume"/,
    )
  })

  test('re-injects the active goal before retrying a context-overflow round', async () => {
    const context = createAgentContext()
    const goalStore = createInMemoryGoalStore()
    await goalStore.applyControl({
      messageRowId: 1,
      command: { action: 'set', objective: '溢出恢复后继续', tokenBudget: null },
    })
    const seenInputs: string[][] = []
    let calls = 0
    const agent = createBotLoopAgent({
      systemPrompt: '',
      context,
      eventQueue: new InMemoryEventQueue<BotEvent>(),
      llm: {
        async chat(input) {
          seenInputs.push(input.messages
            .filter((message) => message.role === 'user')
            .map((message) => message.content))
          calls++
          if (calls === 1) throw { kind: 'context_overflow' }
          return {
            content: '', toolCalls: [],
            usage: { inputTokens: 0, cachedTokens: 0, outputTokens: 0 },
            model: 'mock', stopReason: 'end_turn' as const,
          }
        },
      },
      tools: createToolExecutor([]),
      snapshotRepo: makeSnapshotRepo([]),
      renderEvent: renderBotEvent,
      eventDebounceMs: 0,
      goalStore,
      compactOptions: {
        keepRatio: 0.5,
        summarize: async () => validSummary('恢复摘要'),
      },
    })

    await agent.runOnceForTest()

    assert.equal(calls, 2)
    assert.equal(seenInputs[1]?.some((message) => message.includes('post_compaction')), true)
  })

  test('records a hard provider quota failure as usage_limited before surfacing the round error', async () => {
    const context = createAgentContext()
    const goalStore = createInMemoryGoalStore()
    await goalStore.applyControl({
      messageRowId: 1,
      command: { action: 'set', objective: '额度恢复后继续', tokenBudget: null },
    })
    const agent = createBotLoopAgent({
      systemPrompt: '',
      context,
      eventQueue: new InMemoryEventQueue<BotEvent>(),
      llm: {
        async chat() {
          throw Object.assign(new Error('organization usage limit exceeded'), { kind: 'rate_limit' })
        },
      },
      tools: createToolExecutor([]),
      snapshotRepo: makeSnapshotRepo([]),
      renderEvent: renderBotEvent,
      eventDebounceMs: 0,
      goalStore,
    })

    await assert.rejects(agent.runOnceForTest(), /usage limit exceeded/)

    assert.equal((await goalStore.get())?.status, 'usage_limited')
    const users = context.getSnapshot().messages.filter((message) => message.role === 'user')
    assert.match(users.at(-1)!.content, /usage_limited/)
  })
})

function makeSnapshotRepo(savedGoalRevisions: number[]): BotSnapshotRepo {
  return {
    async load() { return null },
    async save(input) { savedGoalRevisions.push(input.goalRevision) },
  }
}
