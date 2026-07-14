export interface AgentStartupLifecycle {
  start(): Promise<void>
  stopAgent(): Promise<void>
  awaitAgent(): Promise<void>
}

export interface AgentStartupLifecycleDeps {
  startBackgroundServices(): Promise<void>
  startAgent(): void | Promise<void>
  stopAgent(): void | Promise<void>
}

export function createAgentStartupLifecycle(
  deps: AgentStartupLifecycleDeps,
): AgentStartupLifecycle {
  let stopRequested = false
  let startPromise: Promise<void> | null = null
  let agentPromise: Promise<void> | null = null
  let stopPromise: Promise<void> | null = null

  return {
    start() {
      startPromise ??= (async () => {
        await deps.startBackgroundServices()
        if (stopRequested) return
        agentPromise = Promise.resolve(deps.startAgent())
        await agentPromise
      })()
      return startPromise
    },

    stopAgent() {
      stopRequested = true
      if (stopPromise) return stopPromise
      try {
        stopPromise = Promise.resolve(deps.stopAgent())
      } catch (error) {
        stopPromise = Promise.reject(error)
      }
      return stopPromise
    },

    awaitAgent() {
      return agentPromise ?? Promise.resolve()
    },
  }
}
