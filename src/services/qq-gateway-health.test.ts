import assert from 'node:assert/strict'
import { test } from 'node:test'
import { qqGatewayHealth } from './qq-gateway-health.js'

test('QQ gateway health stays unavailable until connection and initial backfill are ready', () => {
  assert.deepEqual(qqGatewayHealth(false, false), {
    status: 503,
    body: { ok: false, connected: false, backfillCompleted: false },
  })
  assert.deepEqual(qqGatewayHealth(true, false), {
    status: 503,
    body: { ok: false, connected: true, backfillCompleted: false },
  })
  assert.deepEqual(qqGatewayHealth(true, true), {
    status: 200,
    body: { ok: true, connected: true, backfillCompleted: true },
  })
})
