import assert from 'node:assert/strict'
import { afterEach, describe, mock, test } from 'node:test'
import { log } from '../logger.js'
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
