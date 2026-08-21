import assert from 'node:assert/strict'
import { test } from 'node:test'
import { authorizeFeishuDelivery } from './feishu-delivery-policy.js'

test('Feishu reply must belong to the focused conversation', async () => {
  const result = await authorizeFeishuDelivery({
    request: {
      actionId: '550e8400-e29b-41d4-a716-446655440000',
      target: { platform: 'feishu', accountId: 'cli_1', kind: 'group', externalId: 'oc_current' },
      text: '回复',
      replyToExternalId: 'om_other_chat',
    },
    appId: 'cli_1',
    groupIds: ['oc_current'],
    async isObservedConversation() { return true },
    async isMessageInConversation(_conversation, messageExternalId) {
      return messageExternalId !== 'om_other_chat'
    },
  })

  assert.equal(result, 'reply message does not belong to the target conversation')
})
