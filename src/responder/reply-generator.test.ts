import assert from 'node:assert/strict'
import { afterEach, describe, mock, test } from 'node:test'
import { log } from '../logger.js'
import type { AgentMessage } from '../agent/types.js'
import { buildMentionContextFrame } from './reply-generator.js'
import { logMentionReplyTokenUsage } from './reply-token-usage.js'

describe('generateMentionReply token usage logging', () => {
  afterEach(() => {
    mock.restoreAll()
  })

  test('logs aggregated token usage summary', () => {
    const infoMock = mock.method(log, 'info', () => log)

    logMentionReplyTokenUsage({
      groupId: 1001,
      messageId: 2002,
      mode: 'agent',
      durationMs: 345,
      summary: {
        total: {
          promptTokens: 120,
          completionTokens: 45,
          totalTokens: 165,
          calls: 2,
        },
        byOperation: {
          generateReply: {
            promptTokens: 120,
            completionTokens: 45,
            totalTokens: 165,
            calls: 2,
          },
        },
      },
    })

    assert.equal(infoMock.mock.calls.length, 1)
    assert.equal(infoMock.mock.calls[0]?.arguments[1], 'at_mention_token_usage')
    assert.deepEqual(infoMock.mock.calls[0]?.arguments[0], {
      scope: 'REPLY',
      direction: 'internal',
      actor: 'bot',
      category: 'mention_reply',
      flow: 'reply_generation_token_usage',
      groupId: 1001,
      messageId: 2002,
      mode: 'agent',
      durationMs: 345,
      promptTokens: 120,
      completionTokens: 45,
      totalTokens: 165,
      llmCalls: 2,
      byOperation: {
        generateReply: {
          promptTokens: 120,
          completionTokens: 45,
          totalTokens: 165,
          calls: 2,
        },
      },
    })
  })
})

describe('mention reply context frame', () => {
  const initialHistory: AgentMessage[] = [
    { role: 'user', content: '[当前要回复的消息]\n用户30: @bot ping' },
  ]

  test('uses deterministic legacy fallback identity outside runtime opportunities', () => {
    const left = buildMentionContextFrame({
      msg: {
        groupId: 1001,
        sceneKind: 'qq_group',
        sceneExternalId: '1001',
        sceneId: 'qq_group:1001',
        messageRowId: 20,
        messageId: 2002,
        senderId: 30,
        senderNickname: '用户30',
        segments: [{ type: 'text', content: '@bot ping' }],
      },
      systemPrompt: 'system',
      initialHistory,
      messageCursorStart: 1,
      messageCursorEnd: 19,
      includedActionRecordIds: [],
    })
    const right = buildMentionContextFrame({
      msg: {
        groupId: 1001,
        sceneKind: 'qq_group',
        sceneExternalId: '1001',
        sceneId: 'qq_group:1001',
        messageRowId: 20,
        messageId: 2002,
        senderId: 30,
        senderNickname: '用户30',
        segments: [{ type: 'text', content: '@bot ping' }],
      },
      systemPrompt: 'system',
      initialHistory,
      messageCursorStart: 1,
      messageCursorEnd: 19,
      includedActionRecordIds: [],
    })

    assert.equal(left.opportunityId, 'legacy:qq_group:1001:20:mention')
    assert.equal(left.sourceKind, 'legacy_fallback')
    assert.equal(left.frameId, right.frameId)
  })

  test('uses runtime opportunity identity when provided', () => {
    const frame = buildMentionContextFrame({
      msg: {
        groupId: 1001,
        sceneKind: 'qq_group',
        sceneExternalId: '1001',
        sceneId: 'qq_group:1001',
        messageRowId: 20,
        messageId: 2002,
        senderId: 30,
        senderNickname: '用户30',
        segments: [{ type: 'text', content: '@bot ping' }],
      },
      generationContext: {
        sceneId: 'qq_group:1001',
        opportunityId: 'runtime-opp',
        sourceKind: 'mention',
        deliveryMode: 'reply_to_message',
        triggerMessageRowId: 20,
        triggerMessageId: 2002,
        incorporatedMessageRowId: 20,
        incorporatedMessageId: 2002,
      },
      systemPrompt: 'system',
      initialHistory,
      messageCursorStart: 1,
      messageCursorEnd: 19,
      includedActionRecordIds: [],
    })

    assert.equal(frame.opportunityId, 'runtime-opp')
    assert.equal(frame.sourceKind, 'mention')
    assert.equal(frame.triggerMessageRowId, 20)
  })
})
