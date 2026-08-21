import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  createMessageDelivery,
  type DeliveryRequest,
  type PlatformDeliveryAdapter,
} from './message-delivery.js'

describe('MessageDelivery', () => {
  test('routes one stable outbound action to the target platform adapter', async () => {
    const calls: DeliveryRequest[] = []
    const feishu: PlatformDeliveryAdapter = {
      platform: 'feishu',
      async send(request) {
        calls.push(request)
        return { status: 'sent', providerMessageId: 'om_sent' }
      },
    }
    const delivery = createMessageDelivery([feishu])
    const request: DeliveryRequest = {
      actionId: 'b2fc6a18-980c-4d4a-9bd8-f81c9495a6da',
      target: {
        platform: 'feishu',
        accountId: 'cli_1',
        kind: 'private',
        externalId: 'oc_owner',
      },
      text: 'hello',
      replyToExternalId: 'om_parent',
    }

    assert.deepEqual(await delivery.send(request), {
      status: 'sent',
      providerMessageId: 'om_sent',
    })
    assert.deepEqual(calls, [request])
  })

  test('reports an ambiguous adapter exception instead of hiding the failure', async () => {
    const delivery = createMessageDelivery([{
      platform: 'feishu',
      async send() { throw new Error('socket closed after write') },
    }])
    const result = await delivery.send({
      actionId: 'action-1',
      target: { platform: 'feishu', accountId: 'cli_1', kind: 'private', externalId: 'oc_1' },
      text: 'hello',
    })
    assert.deepEqual(result, {
      status: 'delivery_unknown',
      code: 'adapter_exception',
      error: 'socket closed after write',
    })
  })
})
