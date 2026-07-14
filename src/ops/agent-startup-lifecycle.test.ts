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
  const stopping = lifecycle.stopAgent()

  assert.equal(agentStops, 1)
  assert.equal(agentStarts, 0)
  await stopping
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

  await lifecycle.stopAgent()
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

test('awaits one shared asynchronous Agent stop across repeated requests', async () => {
  const stopping = deferred<void>()
  let stopCalls = 0
  const lifecycle = createAgentStartupLifecycle({
    async startBackgroundServices() {},
    async startAgent() {},
    stopAgent() {
      stopCalls++
      return stopping.promise
    },
  })

  const first = lifecycle.stopAgent()
  const second = lifecycle.stopAgent()
  assert.equal(first, second)
  assert.equal(stopCalls, 1)

  let settled = false
  void first.then(() => { settled = true })
  await Promise.resolve()
  assert.equal(settled, false)

  stopping.resolve()
  await first
  assert.equal(settled, true)
})

test('turns a synchronous Agent stop throw into the returned rejection', async () => {
  const failure = new Error('sync stop failed')
  const lifecycle = createAgentStartupLifecycle({
    async startBackgroundServices() {},
    async startAgent() {},
    stopAgent() { throw failure },
  })

  await assert.rejects(lifecycle.stopAgent(), (error: unknown) => error === failure)
})

test('propagates an asynchronous Agent stop rejection through the shared promise', async () => {
  const failure = new Error('async stop failed')
  const rejectedStop = Promise.reject(failure)
  void rejectedStop.catch(() => {})
  const lifecycle = createAgentStartupLifecycle({
    async startBackgroundServices() {},
    async startAgent() {},
    stopAgent: () => rejectedStop,
  })

  const first = lifecycle.stopAgent()
  const second = lifecycle.stopAgent()
  assert.equal(first, second)
  await assert.rejects(first, (error: unknown) => error === failure)
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
