import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createShutdownCoordinator } from './shutdown.js'

test('shutdown runs lifecycle phases once and in order', async () => {
  const order: string[] = []
  const coordinator = createShutdownCoordinator({
    disconnectIngress: () => { order.push('disconnectIngress') },
    stopAgent: async () => { order.push('stopAgent') },
    awaitAgent: async () => { order.push('awaitAgent') },
    drainIngress: async () => { order.push('drainIngress') },
    stopJobs: () => { order.push('stopJobs') },
    saveFinal: async () => { order.push('saveFinal') },
    disconnectDb: async () => { order.push('disconnectDb') },
    timeoutMs: 1_000,
  })

  const first = coordinator.shutdown('SIGTERM')
  const second = coordinator.shutdown('SIGINT')
  assert.equal(first, second)
  const result = await first

  assert.deepEqual(result, { ok: true, errors: [] })
  assert.deepEqual(order, [
    'disconnectIngress',
    'stopAgent',
    'awaitAgent',
    'drainIngress',
    'stopJobs',
    'saveFinal',
    'disconnectDb',
  ])
})

test('shutdown continues after phase failures and disconnects the database last', async () => {
  const order: string[] = []
  const coordinator = createShutdownCoordinator({
    disconnectIngress: () => {
      order.push('disconnectIngress')
      throw new Error('socket close failed')
    },
    stopAgent: async () => { order.push('stopAgent') },
    awaitAgent: async () => { order.push('awaitAgent') },
    drainIngress: async () => { order.push('drainIngress') },
    stopJobs: () => { order.push('stopJobs') },
    saveFinal: async () => {
      order.push('saveFinal')
      throw new Error('snapshot failed')
    },
    disconnectDb: async () => { order.push('disconnectDb') },
    timeoutMs: 1_000,
  })

  const result = await coordinator.shutdown('test')

  assert.equal(result.ok, false)
  assert.deepEqual(result.errors.map((error) => error.phase), ['disconnectIngress', 'saveFinal'])
  assert.equal(order.at(-1), 'disconnectDb')
})
