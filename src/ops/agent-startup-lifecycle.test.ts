import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createAgentStartupLifecycle } from './agent-startup-lifecycle.js'

test('does not start the Agent when shutdown is requested during background startup', async () => {
  const background = deferred<void>()
  let agentStarts = 0
  let agentStops = 0
  const lifecycle = createAgentStartupLifecycle({
    startBackgroundServices: () => background.promise,
    startAgent: async () => { agentStarts++ },
    stopAgent: () => { agentStops++ },
  })

  const startup = lifecycle.start()
  lifecycle.stopAgent()

  assert.equal(agentStops, 1)
  assert.equal(agentStarts, 0)
  await lifecycle.awaitAgent()
  background.resolve()
  await startup
  assert.equal(agentStarts, 0)
})

test('stops and awaits an Agent that has started after background services', async () => {
  const agent = deferred<void>()
  let agentStarts = 0
  let agentStops = 0
  const lifecycle = createAgentStartupLifecycle({
    async startBackgroundServices() {},
    startAgent() {
      agentStarts++
      return agent.promise
    },
    stopAgent() { agentStops++ },
  })

  const startup = lifecycle.start()
  await Promise.resolve()
  assert.equal(agentStarts, 1)

  lifecycle.stopAgent()
  assert.equal(agentStops, 1)
  let awaited = false
  const awaitingAgent = lifecycle.awaitAgent().then(() => { awaited = true })
  await Promise.resolve()
  assert.equal(awaited, false)

  agent.resolve()
  await awaitingAgent
  await startup
  assert.equal(awaited, true)
})

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}
