import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { conversationKey } from './conversation.js'

describe('conversation identity', () => {
  test('builds a stable platform and account scoped key', () => {
    assert.equal(conversationKey({
      platform: 'qq',
      accountId: '123456',
      kind: 'group',
      externalId: '1001',
    }), 'qq:123456:group:1001')

    assert.equal(conversationKey({
      platform: 'feishu',
      accountId: 'cli:test',
      kind: 'private',
      externalId: 'ou:owner',
    }), 'feishu:cli%3Atest:private:ou%3Aowner')
  })
})
