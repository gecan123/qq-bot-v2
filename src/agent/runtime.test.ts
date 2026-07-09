import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { createAgentContext } from './agent-context.js'
import { InMemoryEventQueue } from './event-queue.js'
import type { BotEvent } from './event.js'
import type { LlmClient } from './llm-client.js'
import type { BotSnapshotRepo } from './snapshot-repo.js'
import { createAgentRuntime } from './runtime.js'
import type { MessageSender } from '../messaging/message-sender.js'

describe('createAgentRuntime', () => {
  test('wires deferred tool activation state through AgentContext', async () => {
    const context = createAgentContext()
    context.activateToolCapability('external_research')

    const runtime = createAgentRuntime({
      context,
      eventQueue: new InMemoryEventQueue<BotEvent>(),
      llm: makeMockLlm(),
      snapshotRepo: makeSnapshotRepo(),
      sender: makeMessageSender(),
      loadFriendIds: async () => [2002],
      groupIds: [1001],
      groupAmbientSendIds: new Set([1001]),
      selfNumber: 9999,
      metadata: { groupNames: new Map([[1001, '测试群']]) },
      groupCustomizations: [],
      toolCallLogPath: '/tmp/qq-bot-v2-runtime-test-tool-calls.ndjson',
      owner: { qq: 2002, name: 'zzz' },
      eventDebounceMs: 0,
    })

    assert.match(runtime.systemPrompt, /测试群/)
    assert.deepEqual(runtime.tools.list().map((tool) => tool.name), [
      'pause',
      'send_message',
      'background_task',
      'todo',
      'skill',
      'memory',
      'inbox',
      'collect_sticker',
      'chat_style',
      'ai_tone',
      'journal',
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
    assert.equal(externalResearch.active, true)
    assert.equal(skillManagement.active, false)
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
