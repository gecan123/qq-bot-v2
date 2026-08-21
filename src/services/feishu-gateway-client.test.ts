import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createFeishuDeliveryAdapter, FeishuGatewayClient } from './feishu-gateway-client.js'

test('Feishu gateway adapter serializes image bytes for the loopback boundary', async () => {
  const bodies: unknown[] = []
  const client = new FeishuGatewayClient('http://127.0.0.1:37927', 1000, async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)))
    return new Response(JSON.stringify({ status: 'sent', providerMessageId: 'om_1' }), { status: 200 })
  })
  const result = await createFeishuDeliveryAdapter(client).send({
    actionId: 'a', target: { platform: 'feishu', accountId: 'cli_1', kind: 'group', externalId: 'oc_1' },
    imageBytes: Buffer.from('image'),
  })
  assert.equal(result.status, 'sent')
  assert.deepEqual(bodies, [{
    actionId: 'a', target: { platform: 'feishu', accountId: 'cli_1', kind: 'group', externalId: 'oc_1' },
    imageBase64: Buffer.from('image').toString('base64'),
  }])
})
