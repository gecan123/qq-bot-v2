import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { createAgentContext } from './agent-context.js'
import { InMemoryEventQueue } from './event-queue.js'
import type { BotEvent } from './event.js'
import type { LlmClient } from './llm-client.js'
import type { BotSnapshotRepo } from './snapshot-repo.js'
import { createAgentRuntime } from './runtime.js'
import type { MessageSender } from '../messaging/message-sender.js'
import { McpManager } from './mcp-manager.js'
import { createInMemoryGoalStore } from './goal-store.js'

describe('createAgentRuntime', () => {
  test('wires deferred tool activation state through AgentContext', async () => {
    const context = createAgentContext()
    context.activateToolCapability('external_research')
    let mcpConnections = 0
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
      goalStore: createInMemoryGoalStore(),
      lifeJournal: {
        async recordRound() {},
        async pickIdleIntention() {
          return {
            ok: true,
            intention: '继续拆解 Agenda 里的 QuadRF 供应链线索',
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
    assert.equal(pausePayload.alternative.direction, '继续拆解 Agenda 里的 QuadRF 供应链线索')
    await runtime.stopBackgroundServices()
  })
})

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
