export interface AgentStartupLifecycle {
  start(): Promise<void>
  stopAgent(): void
  awaitAgent(): Promise<void>
}

export interface AgentStartupLifecycleDeps {
  startBackgroundServices(): Promise<void>
  startAgent(): void | Promise<void>
  stopAgent(): void
}

export function createAgentStartupLifecycle(
  deps: AgentStartupLifecycleDeps,
): AgentStartupLifecycle {
  let stopRequested = false
  let stopIssued = false
  let startPromise: Promise<void> | null = null
  let agentPromise: Promise<void> | null = null

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
      if (stopIssued) return
      stopIssued = true
      deps.stopAgent()
    },

    awaitAgent() {
      return agentPromise ?? Promise.resolve()
    },
  }
}
