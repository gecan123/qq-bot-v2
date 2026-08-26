export interface BackfillScheduler {
  readonly initialBackfillDone: Promise<void>
  schedule(): Promise<void>
  drain(): Promise<void>
}

export class BackfillSourceTimeoutError extends Error {
  readonly code = 'backfill_source_timeout'

  constructor(
    readonly source: unknown,
    readonly timeoutMs: number,
  ) {
    super(`backfill source ${String(source)} timed out after ${timeoutMs}ms`)
    this.name = 'BackfillSourceTimeoutError'
  }
}

export async function runBoundedBackfills<T>(input: {
  sources: readonly T[]
  concurrency: number
  sourceTimeoutMs: number
  run: (source: T, signal: AbortSignal) => Promise<void>
  onFailure: (source: T, error: unknown) => Promise<void> | void
}): Promise<void> {
  if (!Number.isSafeInteger(input.concurrency) || input.concurrency <= 0) {
    throw new Error('backfill concurrency must be a positive safe integer')
  }
  if (!Number.isSafeInteger(input.sourceTimeoutMs) || input.sourceTimeoutMs <= 0) {
    throw new Error('backfill sourceTimeoutMs must be a positive safe integer')
  }

  let nextSourceIndex = 0
  const workerCount = Math.min(input.concurrency, input.sources.length)
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextSourceIndex < input.sources.length) {
      const source = input.sources[nextSourceIndex++]!
      try {
        await withBackfillSourceTimeout(
          (signal) => input.run(source, signal),
          source,
          input.sourceTimeoutMs,
        )
      } catch (error) {
        await input.onFailure(source, error)
      }
    }
  }))
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

async function withBackfillSourceTimeout<T>(
  run: (signal: AbortSignal) => Promise<T>,
  source: unknown,
  timeoutMs: number,
): Promise<T> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error('backfill timeoutMs must be a positive safe integer')
  }
  const abort = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      Promise.resolve().then(() => run(abort.signal)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const error = new BackfillSourceTimeoutError(source, timeoutMs)
          abort.abort(error)
          reject(error)
        }, timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
