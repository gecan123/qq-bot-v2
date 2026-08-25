import assert from 'node:assert/strict'
import { test } from 'node:test'
import { QqGatewayClient } from './qq-gateway-client.js'

test('QQ gateway client posts bodyless list requests', async () => {
  const calls: Array<{ path: string; method: string; body: string | null }> = []
  const client = new QqGatewayClient('http://127.0.0.1:37922', 1000, async (input, init) => {
    const url = new URL(String(input))
    calls.push({
      path: url.pathname,
      method: init?.method ?? 'GET',
      body: init?.body == null ? null : String(init.body),
    })
    const payload = url.pathname === '/friends' ? { friends: [] } : { groups: [] }
    return new Response(JSON.stringify(payload), { status: 200 })
  })

  assert.deepEqual(await client.friends(), [])
  assert.deepEqual(await client.groups(), [])
  assert.deepEqual(calls, [
    { path: '/friends', method: 'POST', body: '{}' },
    { path: '/groups', method: 'POST', body: '{}' },
  ])
})
