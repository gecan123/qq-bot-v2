import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ConversationRef } from '../chat/conversation.js'
import type { MessageDelivery } from '../messaging/message-delivery.js'
import { createAgentContext } from './agent-context.js'
import { createBotLoopAgent } from './bot-loop-agent.js'
import type { ConversationSendPolicy } from './conversation-send-policy.js'
import { InMemoryEventQueue } from './event-queue.js'
import type { BotEvent } from './event.js'
import type { LlmCallOutput, LlmClient } from './llm-client.js'
import { renderBotEvent } from './render-event.js'
import { createTestAgentLedger } from './test-support/agent-ledger.js'
import { createDeferredToolExecutor } from './tool.js'
import { createConversationController, createConversationTool } from './tools/conversation.js'
import { createSendMessageTool } from './tools/send-message.js'

const qqPrivate: ConversationRef = {
  platform: 'qq', accountId: '10000', kind: 'private', externalId: '20000',
}
const feishuPrivate: ConversationRef = {
  platform: 'feishu', accountId: 'cli_1', kind: 'private', externalId: 'oc_owner',
}

function messageEvent(input: {
  rowId: number
  conversation: ConversationRef
  sender: string
}): Extract<BotEvent, { type: 'chat_message' }> {
  return {
    type: 'chat_message',
    eventKind: 'message',
    messageRowId: input.rowId,
    conversation: input.conversation,
    messageExternalId: `message-${input.rowId}`,
    senderExternalId: input.sender,
    senderName: input.sender,
    mentionedSelf: true,
    sentAt: new Date(`2026-08-20T00:00:0${input.rowId}.000Z`),
    renderedText: `hidden-${input.rowId}`,
  }
}

function toolOutput(id: string, tool: string, args: Record<string, unknown>): LlmCallOutput {
  return {
    content: '',
    toolCalls: [{ id, name: 'invoke', args: { tool, args } }],
    usage: { inputTokens: 100, cachedTokens: 80, outputTokens: 20 },
    model: 'mock',
    contextWindowTokens: 200_000,
  }
}

test('QQ and Feishu events share one BotLoop, durable ledger and explicit focus', async () => {
  const context = createAgentContext()
  const eventQueue = new InMemoryEventQueue<BotEvent>()
  eventQueue.enqueue(messageEvent({ rowId: 1, conversation: qqPrivate, sender: '20000' }))
  eventQueue.enqueue(messageEvent({ rowId: 2, conversation: feishuPrivate, sender: 'ou_owner' }))

  const outputs = [
    toolOutput('open-feishu', 'conversation', { action: 'open', target: feishuPrivate }),
    toolOutput('send-feishu', 'send_message', {
      message: '飞书回复', reply_to: { row_id: 2, expect: 'message' }, work: { state: 'none' },
    }),
  ]
  let outputIndex = 0
  const llm: LlmClient = {
    async chat() {
      const output = outputs[outputIndex++]
      if (!output) throw new Error('mock LLM ran out of outputs')
      return output
    },
  }

  let focus: ConversationRef | null = null
  const conversations = createConversationController({
    state: { get: () => focus, set: (value) => { focus = value } },
    loadConversations: async () => [
      { target: qqPrivate, displayName: 'QQ 主人' },
      { target: feishuPrivate, displayName: '飞书主人' },
    ],
  })
  const deliveries: Parameters<MessageDelivery['send']>[0][] = []
  const delivery: MessageDelivery = {
    async send(request) {
      deliveries.push(request)
      return { status: 'sent', providerMessageId: 'om_sent' }
    },
  }
  const targetPolicy: ConversationSendPolicy = {
    async authorize() { return { allowed: true } },
  }
  const tools = createDeferredToolExecutor({
    alwaysOnTools: [],
    capabilities: [{
      name: 'chat',
      description: 'cross-platform chat',
      tools: [
        createConversationTool(conversations),
        createSendMessageTool({
          delivery,
          targetPolicy,
          conversations,
          loadReplyMessage: async (rowId) => ({
            rowId,
            eventKind: 'message',
            platform: 'feishu',
            accountId: 'cli_1',
            conversationKind: 'private',
            conversationExternalId: 'oc_owner',
            messageExternalId: 'om_2',
            senderExternalId: 'ou_owner',
            senderName: '飞书主人',
            senderConversationName: null,
            content: [{ type: 'text', content: 'hidden-2' }],
            resolvedText: 'hidden-2',
            searchText: 'hidden-2',
          }),
        }),
      ],
    }],
  })
  const ledger = createTestAgentLedger()
  const agent = createBotLoopAgent({
    systemPrompt: 'integration test',
    context,
    eventQueue,
    llm,
    tools,
    ledgerRepo: ledger.repo,
    ledgerLoader: ledger.loader,
    getConversationFocus: () => focus,
    syncConversationFocus: (value) => { focus = value },
    renderEvent: renderBotEvent,
    eventDebounceMs: 0,
    compactOptions: { reserveTokens: 0 },
  })

  await agent.runOnceForTest()
  await agent.runOnceForTest()

  const messages = context.getSnapshot().messages
  const notifications = messages
    .filter((message): message is typeof message & { content: string } => (
      message.role === 'user'
      && typeof message.content === 'string'
      && message.content.includes('"kind":"inbox_update"')
    ))
    .map((message) => JSON.parse(message.content) as { data: { mailbox: string } })
  assert.deepEqual(notifications.map((item) => item.data.mailbox), [
    'qq:10000:private:20000',
    'feishu:cli_1:private:oc_owner',
  ])
  assert.deepEqual(focus, feishuPrivate)
  assert.deepEqual(ledger.canonical().runtimeState.conversationFocus, feishuPrivate)
  assert.deepEqual(deliveries, [{
    actionId: deliveries[0]!.actionId,
    target: feishuPrivate,
    text: '飞书回复',
    replyToExternalId: 'om_2',
  }])
  assert.ok(messages.some((message) => message.role === 'user' && message.content === JSON.stringify({
    event: 'mailbox_handled', mailbox: 'feishu:cli_1:private:oc_owner', throughRowId: 2,
  })))
})
