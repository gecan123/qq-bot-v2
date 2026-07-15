import assert from 'node:assert/strict'
import { access, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, test } from 'node:test'
import { createAgentContext } from './agent-context.js'
import { InMemoryEventQueue, type EventQueue } from './event-queue.js'
import type { BotEvent } from './event.js'
import type { LlmClient } from './llm-client.js'
import { createAgentRuntime, createScheduleRuntimeLogHandler } from './runtime.js'
import type { MessageSender } from '../messaging/message-sender.js'
import { McpManager } from './mcp-manager.js'
import { createInMemoryGoalStore } from './goal-store.js'
import type { ScheduleRuntime, ScheduleRuntimeLogEntry } from './schedule-runtime.js'
import { createTestAgentLedger } from './test-support/agent-ledger.js'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('createAgentRuntime', () => {
  test('wires deferred tool activation state through AgentContext', async () => {
    const context = createAgentContext()
    context.activateToolCapability('external_research')
    const ledger = createTestAgentLedger({
      runtimeState: { activeToolCapabilities: ['external_research'] },
    })
    let mcpConnections = 0
    let scheduleStarts = 0
    let scheduleStops = 0
    const scheduleRuntime = makeScheduleRuntime({
      async start() { scheduleStarts++ },
      async stop() { scheduleStops++ },
    })
    const mcpManager = new McpManager({
      servers: {
        local: {
          command: '/bin/echo',
          args: [],
          env: {},
          inheritEnv: [],
          readOnlyTools: ['search'],
          timeoutMs: 30_000,
          resultMaxChars: 12_000,
        },
      },
      snapshotDir: '/tmp/qq-bot-v2-runtime-test-mcp-schemas',
      factory: async () => {
        mcpConnections++
        return {
          async listTools() { return [] },
          async callTool() { return {} },
          async close() {},
        }
      },
    })

    const runtime = createAgentRuntime({
      context,
      eventQueue: new InMemoryEventQueue<BotEvent>(),
      llm: makeMockLlm(),
      ledgerRepo: ledger.repo,
      ledgerLoader: ledger.loader,
      sender: makeMessageSender(),
      loadFriends: async () => [{ userId: 2002, nickname: '好友', remark: '主人' }],
      loadGroups: async () => [{ groupId: 1001, groupName: '测试群' }],
      groupIds: [1001],
      groupAmbientSendIds: new Set([1001]),
      selfNumber: 9999,
      metadata: { groupNames: new Map([[1001, '测试群']]) },
      groupCustomizations: [],
      toolCallLogPath: '/tmp/qq-bot-v2-runtime-test-tool-calls.ndjson',
      owner: { qq: 2002, name: 'zzz' },
      eventDebounceMs: 0,
      optionalTools: disabledOptionalTools(),
      mcpManager,
      scheduleRuntime,
      goalStore: createInMemoryGoalStore(),
      lifeJournal: {
        async recordRound() {},
        async pickIdleIntention() {
          return {
            ok: true,
            thought: '我还想把 QuadRF 那条线索往前推一步。',
            intention: '继续拆解 Agenda 里的 QuadRF 供应链线索',
            anchorSource: 'agenda',
            whyNow: '它仍在 Active',
            firstStep: '读取现有 notebook 的第一段',
            promoteToGoal: false,
          }
        },
      },
    })

    assert.match(runtime.systemPrompt, /测试群/)
    assert.deepEqual(runtime.tools.list().map((tool) => tool.name), [
      'pause',
      'qq_directory',
      'background_task',
      'schedule',
      'delegate',
      'approval',
      'goal',
      'todo',
      'skill',
      'memory',
      'inbox',
      'collect_sticker',
      'chat_style',
      'ai_tone',
      'notebook',
      'life_journal',
      'workspace_bash',
      'help',
      'invoke',
    ])
    await runtime.startBackgroundServices()
    assert.equal(scheduleStarts, 1)

    const helpResult = await runtime.tools.execute({
      id: 'help-1',
      name: 'help',
      args: { action: 'list' },
    }, {
      eventQueue: new InMemoryEventQueue<BotEvent>(),
      roundIndex: 1,
    })
    assert.equal(typeof helpResult.content, 'string')
    if (typeof helpResult.content !== 'string') {
      throw new Error('help result should be text JSON')
    }
    const payload = JSON.parse(helpResult.content)
    const externalResearch = payload.capabilities.find((item: { name: string }) => item.name === 'external_research')
    const skillManagement = payload.capabilities.find((item: { name: string }) => item.name === 'skill_management')
    const mcpConnectors = payload.capabilities.find((item: { name: string }) => item.name === 'mcp_connectors')
    const qq = payload.capabilities.find((item: { name: string }) => item.name === 'qq')
    assert.equal(externalResearch.active, true)
    assert.equal(skillManagement.active, false)
    assert.equal(mcpConnectors.active, false)
    assert.deepEqual(mcpConnectors.tools, ['mcp'])
    assert.equal(qq.active, false)
    assert.deepEqual(qq.tools, ['qq_conversation', 'send_message'])
    assert.equal(mcpConnections, 0)

    const pauseResult = await runtime.tools.execute({
      id: 'pause-1',
      name: 'pause',
      args: {
        action: 'rest',
        durationSeconds: 30,
        reason: '刚完成一段活动，想短暂停一下',
        intention: {
          primaryDirection: '读一篇具体论文的摘要',
          alternativeDirection: '复核一条已有研究假设',
        },
      },
    }, {
      eventQueue: new InMemoryEventQueue<BotEvent>(),
      roundIndex: 1,
    })
    const pausePayload = JSON.parse(pauseResult.content as string)
    assert.equal(pausePayload.status, 'alternative_available')
    assert.equal(pausePayload.paused, false)
    assert.equal(pausePayload.idleThought.event, 'idle_thought')
    assert.equal(pausePayload.idleThought.direction, '继续拆解 Agenda 里的 QuadRF 供应链线索')
    await runtime.stopBackgroundServices()
    assert.equal(scheduleStops, 1)
  })

  test('opens and sends through the deferred qq capability using runtime-local focus', async () => {
    const context = createAgentContext()
    const sent: Parameters<MessageSender['sendSegments']>[0][] = []
    const runtime = createAgentRuntime({
      ...makeRuntimeInput(),
      context,
      sender: {
        async sendSegments(input) {
          sent.push(input)
          return { success: true, attempts: 1, providerMessageId: 77 }
        },
      },
    })

    assert.equal(runtime.tools.list().some((tool) => tool.name === 'send_message'), false)

    await runtime.tools.execute({
      id: 'activate-qq',
      name: 'help',
      args: { action: 'activate', capability: 'qq' },
    }, {
      eventQueue: new InMemoryEventQueue<BotEvent>(),
      roundIndex: 1,
    })
    await runtime.tools.execute({
      id: 'open-private',
      name: 'invoke',
      args: {
        tool: 'qq_conversation',
        args: { action: 'open', target: { type: 'private', userId: 2002 } },
      },
    }, {
      eventQueue: new InMemoryEventQueue<BotEvent>(),
      roundIndex: 1,
    })
    const send = await runtime.tools.execute({
      id: 'send-private',
      name: 'invoke',
      args: { tool: 'send_message', args: { message: 'hi', reply_to: 5 } },
    }, {
      eventQueue: new InMemoryEventQueue<BotEvent>(),
      roundIndex: 1,
    })

    const current = await runtime.tools.execute({
      id: 'current-private',
      name: 'invoke',
      args: { tool: 'qq_conversation', args: { action: 'current' } },
    }, {
      eventQueue: new InMemoryEventQueue<BotEvent>(),
      roundIndex: 1,
    })
    assert.deepEqual(JSON.parse(current.content as string).current, {
      type: 'private',
      userId: 2002,
    })
    assert.equal(context.getSnapshot().qqConversationFocus, null)
    assert.deepEqual(sent, [{
      target: { type: 'private', userId: 2002 },
      segments: [
        { type: 'reply', data: { id: '5' } },
        { type: 'text', data: { text: 'hi' } },
      ],
    }])
    assert.match(send.content as string, /"providerMessageId":77/)
  })

  test('uses an in-memory schedule store by default and keeps schedule unavailable until startup', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-runtime-memory-schedule-'))
    tempDirs.push(dir)
    const originalCwd = process.cwd()
    await symlink(join(originalCwd, 'prompts'), join(dir, 'prompts'), 'dir')
    process.chdir(dir)
    let runtime: ReturnType<typeof createAgentRuntime> | null = null

    try {
      runtime = createAgentRuntime(makeRuntimeInput())
      const beforeStart = await executeSchedule(runtime, {
        action: 'create',
        name: 'follow-up',
        intention: '结合最新上下文重新检查进展',
        schedule: { kind: 'at', afterSeconds: 30 },
      })
      assert.deepEqual(beforeStart.outcome, { ok: false, code: 'not_started' })

      await runtime.startBackgroundServices()
      const created = await executeSchedule(runtime, {
        action: 'create',
        name: 'follow-up',
        intention: '结合最新上下文重新检查进展',
        schedule: { kind: 'at', afterSeconds: 30 },
      })
      assert.deepEqual(created.outcome, { ok: true, code: 'created' })

      const listed = await executeSchedule(runtime, { action: 'list' })
      assert.equal(JSON.parse(listed.content as string).schedules.length, 1)
      await assert.rejects(
        access(join(dir, 'data/agent-workspace/runtime/schedules.json')),
        (error: unknown) => isNodeError(error) && error.code === 'ENOENT',
      )
    } finally {
      await runtime?.stopBackgroundServices()
      process.chdir(originalCwd)
    }
  })

  test('propagates persistent schedule startup failures and allows a later retry', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-runtime-schedule-'))
    tempDirs.push(dir)
    const scheduleStatePath = join(dir, 'schedules.json')
    await writeFile(scheduleStatePath, '{ invalid json', 'utf8')
    const runtime = createAgentRuntime({
      ...makeRuntimeInput(),
      scheduleStatePath,
    })

    await assert.rejects(
      runtime.startBackgroundServices(),
      (error: unknown) => error instanceof Error
        && error.message.includes(scheduleStatePath)
        && error.cause instanceof Error
        && error.cause.name === 'ScheduleRuntimeError',
    )

    await writeFile(scheduleStatePath, '{"version":1,"schedules":[]}', 'utf8')
    await runtime.startBackgroundServices()
    await runtime.stopBackgroundServices()
  })

  test('persists capability activation with its visible help result before installing it', async () => {
    const context = createAgentContext()
    context.appendUserMessage('activate research')
    const ledger = createTestAgentLedger({ messages: context.getSnapshot().messages })
    const runtime = createAgentRuntime({
      ...makeRuntimeInput(),
      context,
      llm: {
        async chat() {
          return {
            content: '',
            toolCalls: [{
              id: 'activate-research',
              name: 'help',
              args: { action: 'activate', capability: 'external_research' },
            }],
            usage: { inputTokens: 5, cachedTokens: 0, outputTokens: 2 },
            model: 'mock',
            contextWindowTokens: 200_000,
          }
        },
      },
      ledgerRepo: ledger.repo,
      ledgerLoader: ledger.loader,
    })

    await runtime.agent.runOnceForTest()

    const committed = ledger.snapshots.at(-1)
    assert.ok(committed)
    assert.deepEqual(committed.activeToolCapabilities, ['external_research'])
    assert.equal(committed.messages.at(-1)?.role, 'tool')
    assert.deepEqual(context.getSnapshot().activeToolCapabilities, ['external_research'])
  })

  test('rejects restarting background services after they have stopped', async () => {
    const runtime = createAgentRuntime({
      ...makeRuntimeInput(),
      scheduleRuntime: makeScheduleRuntime(),
    })

    await runtime.startBackgroundServices()
    await runtime.stopBackgroundServices()

    await assert.rejects(runtime.startBackgroundServices(), /stopped/i)
  })

  test('stops the schedule runtime before MCP and remains idempotent', async () => {
    const order: string[] = []
    const scheduleRuntime = makeScheduleRuntime({
      async stop() { order.push('schedule') },
    })
    const mcpManager = {
      hasServers() { return false },
      approvalRequirementForArgs() { return null },
      async closeAll() { order.push('mcp') },
    } as unknown as McpManager
    const runtime = createAgentRuntime({
      ...makeRuntimeInput(),
      scheduleRuntime,
      mcpManager,
    })

    await Promise.all([
      runtime.stopBackgroundServices(),
      runtime.stopBackgroundServices(),
    ])

    assert.deepEqual(order, ['schedule', 'mcp'])
  })

  test('closes MCP after schedule stop fails and retains both failures', async () => {
    const order: string[] = []
    const scheduleFailure = new Error('schedule stop failed')
    const mcpFailure = new Error('mcp close failed')
    const scheduleRuntime = makeScheduleRuntime({
      async stop() {
        order.push('schedule')
        throw scheduleFailure
      },
    })
    const mcpManager = {
      hasServers() { return false },
      approvalRequirementForArgs() { return null },
      async closeAll() {
        order.push('mcp')
        throw mcpFailure
      },
    } as unknown as McpManager
    const runtime = createAgentRuntime({
      ...makeRuntimeInput(),
      scheduleRuntime,
      mcpManager,
    })

    await assert.rejects(runtime.stopBackgroundServices(), (error: unknown) => {
      return error instanceof AggregateError
        && error.errors[0] === scheduleFailure
        && error.errors[1] === mcpFailure
    })
    assert.deepEqual(order, ['schedule', 'mcp'])
  })

  test('passes schedule runtime failures to the configured operations logger', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-runtime-schedule-logger-'))
    tempDirs.push(dir)
    const scheduleStatePath = join(dir, 'schedules.json')
    const now = Date.now()
    const createdAt = new Date(now - 60_000)
    const scheduledFor = new Date(now - 1_000)
    await writeFile(scheduleStatePath, JSON.stringify({
      version: 1,
      schedules: [{
        id: 'log-schedule',
        name: 'logger wiring',
        intention: 'must not be logged',
        schedule: { kind: 'at', at: scheduledFor.toISOString() },
        createdAt: createdAt.toISOString(),
        expiresAt: new Date(createdAt.getTime() + 3 * 24 * 60 * 60_000).toISOString(),
        nextRunAt: scheduledFor.toISOString(),
        runCount: 0,
      }],
    }), 'utf8')
    const entries: ScheduleRuntimeLogEntry[] = []
    const runtime = createAgentRuntime({
      ...makeRuntimeInput(),
      eventQueue: throwingScheduledWakeQueue(),
      scheduleStatePath,
      scheduleLogger: (entry) => entries.push(entry),
    })

    await runtime.startBackgroundServices()

    assert.equal(entries.length, 1)
    assert.equal(entries[0]?.event, 'schedule_event_enqueue_failed')
    assert.equal(entries[0]?.scheduleId, 'log-schedule')
    assert.equal('intention' in (entries[0] as unknown as Record<string, unknown>), false)
    await runtime.stopBackgroundServices()
  })

  test('formats schedule runtime failures for the SCHEDULE error logger without intention text', () => {
    const calls: unknown[][] = []
    const failure = new Error('timer failed')
    const handler = createScheduleRuntimeLogHandler({
      error(...args: unknown[]) { calls.push(args) },
    })

    handler({
      event: 'schedule_timer_failed',
      scheduleId: 'schedule-1',
      error: failure,
    })

    assert.deepEqual(calls, [[{
      event: 'schedule_timer_failed',
      scheduleId: 'schedule-1',
      err: failure,
    }, 'schedule_runtime_failed']])
  })
})

function makeRuntimeInput() {
  const context = createAgentContext()
  const ledger = createTestAgentLedger()
  return {
    context,
    eventQueue: new InMemoryEventQueue<BotEvent>(),
    llm: makeMockLlm(),
    ledgerRepo: ledger.repo,
    ledgerLoader: ledger.loader,
    sender: makeMessageSender(),
    loadFriends: async () => [{ userId: 2002, nickname: '好友', remark: '主人' }],
    loadGroups: async () => [{ groupId: 1001, groupName: '测试群' }],
    groupIds: [1001],
    groupAmbientSendIds: new Set([1001]),
    selfNumber: 9999,
    metadata: { groupNames: new Map([[1001, '测试群']]) },
    groupCustomizations: [],
    toolCallLogPath: '/tmp/qq-bot-v2-runtime-test-tool-calls.ndjson',
    toolAuditMode: 'off' as const,
    owner: { qq: 2002, name: 'zzz' },
    eventDebounceMs: 0,
    optionalTools: disabledOptionalTools(),
    goalStore: createInMemoryGoalStore(),
  }
}

async function executeSchedule(
  runtime: ReturnType<typeof createAgentRuntime>,
  args: Record<string, unknown>,
) {
  return await runtime.tools.execute({ id: 'schedule-test', name: 'schedule', args }, {
    eventQueue: new InMemoryEventQueue<BotEvent>(),
    roundIndex: 1,
  })
}

function makeScheduleRuntime(overrides: Partial<ScheduleRuntime> = {}): ScheduleRuntime {
  return {
    async start() {},
    async create() { throw new Error('unexpected create') },
    async list() { return [] },
    async cancel(id) { return { status: 'already_absent', id } },
    async stop() {},
    ...overrides,
  }
}

function throwingScheduledWakeQueue(): EventQueue<BotEvent> {
  const queue = new InMemoryEventQueue<BotEvent>()
  return {
    ...queue,
    enqueue(event) {
      if (event.type === 'scheduled_wake') throw new Error('queue unavailable')
      return queue.enqueue(event)
    },
    dequeue: () => queue.dequeue(),
    size: () => queue.size(),
    clear: () => queue.clear(),
    waitForEvent: (options) => queue.waitForEvent(options),
    waitForEventWhere: (predicate, options) => queue.waitForEventWhere(predicate, options),
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}

function makeMockLlm(): LlmClient {
  return {
    async chat() {
      return {
        content: '',
        toolCalls: [],
        usage: { inputTokens: 0, cachedTokens: 0, outputTokens: 0 },
        model: 'mock',
        contextWindowTokens: 200_000,
      }
    },
  }
}

function disabledOptionalTools() {
  return {
    browser: null,
    openbb: null,
    tradingAgent: null,
    website: null,
    webSearch: null,
    cryptoPaper: null,
  }
}

function makeMessageSender(): MessageSender {
  return {
    async sendSegments() {
      return { success: true, attempts: 1, providerMessageId: 1 }
    },
  }
}
