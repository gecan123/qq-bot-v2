import assert from 'node:assert/strict'
import { test } from 'node:test'
import { persistMessageRecall } from './message-recall.js'

test('persists an append-only recall correction using the original message identity', async () => {
  const facts: unknown[] = []
  const result = await persistMessageRecall({
    platform: 'qq', accountId: '10000', eventExternalId: 'recall:42:1700',
    messageExternalId: '42', conversationExternalId: '99', recalledAt: 1700,
    rawContent: { operator_id: 8 },
  }, {
    async findOriginal() {
      return {
        conversation: { platform: 'qq', accountId: '10000', kind: 'group', externalId: '99' },
        conversationName: '测试群', senderExternalId: '7', senderName: 'Alice',
      }
    },
    async appendFact(input) {
      facts.push(input)
      return { rowId: 2, createdAt: new Date(0), sentAt: new Date(0) }
    },
  })
  assert.equal(result?.rowId, 2)
  assert.deepEqual(facts, [{
    eventKind: 'recall', eventExternalId: 'recall:42:1700',
    conversation: { platform: 'qq', accountId: '10000', kind: 'group', externalId: '99' },
    conversationName: '测试群', messageExternalId: '42', senderExternalId: '7',
    senderName: 'Alice', content: [], rawContent: { operator_id: 8 }, sentAt: 1700,
  }])
})

test('does not invent a recall fact when the original message was never observed', async () => {
  let appended = false
  const result = await persistMessageRecall({
    platform: 'feishu', accountId: 'cli_1', eventExternalId: 'evt_recall',
    messageExternalId: 'om_missing', conversationExternalId: 'oc_1', recalledAt: 1,
  }, {
    async findOriginal() { return null },
    async appendFact() { appended = true; throw new Error('unreachable') },
  })
  assert.equal(result, null)
  assert.equal(appended, false)
})
