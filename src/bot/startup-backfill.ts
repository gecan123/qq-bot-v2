export interface BackfillScheduler {
  readonly initialBackfillDone: Promise<void>
  schedule(): Promise<void>
  drain(): Promise<void>
}

export function createBackfillScheduler(runBackfill: () => Promise<void>): BackfillScheduler {
  let chain = Promise.resolve()
  let firstScheduled = false
  let resolveInitial!: () => void
  let rejectInitial!: (error: unknown) => void
  const initialBackfillDone = new Promise<void>((resolve, reject) => {
    resolveInitial = resolve
    rejectInitial = reject
  })

  return {
    initialBackfillDone,
    schedule() {
      const scheduled = chain.then(runBackfill)
      chain = scheduled.catch(() => undefined)
      if (!firstScheduled) {
        firstScheduled = true
        void scheduled.then(resolveInitial, rejectInitial)
      }
      return scheduled
    },
    drain() {
      return chain
    },
  }
}
