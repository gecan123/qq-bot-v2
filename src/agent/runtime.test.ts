import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, test } from 'node:test'
import { createAgentContext } from './agent-context.js'
import { InMemoryEventQueue } from './event-queue.js'
import type { BotEvent } from './event.js'
import type { LlmClient } from './llm-client.js'
import type { BotSnapshotRepo } from './snapshot-repo.js'
import { createAgentRuntime } from './runtime.js'
import type { MessageSender } from '../messaging/message-sender.js'
import { McpManager } from './mcp-manager.js'
import { createInMemoryGoalStore } from './goal-store.js'
import type { ScheduleRuntime } from './schedule-runtime.js'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('createAgentRuntime', () => {
  test('wires deferred tool activation state through AgentContext', async () => {
    const context = createAgentContext()
    context.activateToolCapability('external_research')
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
      snapshotRepo: makeSnapshotRepo(),
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
      'send_message',
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
    assert.equal(externalResearch.active, true)
    assert.equal(skillManagement.active, false)
    assert.equal(mcpConnectors.active, false)
    assert.deepEqual(mcpConnectors.tools, ['mcp'])
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

  test('uses an in-memory schedule store by default and keeps schedule unavailable until startup', async () => {
    const runtime = createAgentRuntime(makeRuntimeInput())

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
    await runtime.stopBackgroundServices()
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
        && error.name === 'ScheduleRuntimeError'
        && error.message.includes('Failed to load schedules during startup'),
    )

    await writeFile(scheduleStatePath, '{"version":1,"schedules":[]}', 'utf8')
    await runtime.startBackgroundServices()
    await runtime.stopBackgroundServices()
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
})

function makeRuntimeInput() {
  return {
    context: createAgentContext(),
    eventQueue: new InMemoryEventQueue<BotEvent>(),
    llm: makeMockLlm(),
    snapshotRepo: makeSnapshotRepo(),
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

function makeMockLlm(): LlmClient {
  return {
    async chat() {
      return {
        content: '',
        toolCalls: [],
        usage: { inputTokens: 0, cachedTokens: 0, outputTokens: 0 },
        model: 'mock',
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

function makeSnapshotRepo(): BotSnapshotRepo {
  return {
    async load() {
      return null
    },
    async save() {},
  }
}

function makeMessageSender(): MessageSender {
  return {
    async sendSegments() {
      return { success: true, attempts: 1, providerMessageId: 1 }
    },
  }
}
