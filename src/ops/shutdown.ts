export type ShutdownPhase =
  | 'disconnectIngress'
  | 'stopAgent'
  | 'awaitAgent'
  | 'drainIngress'
  | 'stopJobs'
  | 'saveFinal'
  | 'disconnectDb'

export interface ShutdownError {
  phase: ShutdownPhase
  error: string
}

export interface ShutdownResult {
  ok: boolean
  errors: ShutdownError[]
}

export interface ShutdownCoordinator {
  shutdown(reason?: string): Promise<ShutdownResult>
}

export interface ShutdownCoordinatorDeps {
  disconnectIngress(): void | Promise<void>
  stopAgent(): void | Promise<void>
  awaitAgent(): void | Promise<void>
  drainIngress(): void | Promise<void>
  stopJobs(): void | Promise<void>
  saveFinal(): void | Promise<void>
  disconnectDb(): void | Promise<void>
  timeoutMs: number
  onPhaseError?: (error: ShutdownError) => void
}

export function createShutdownCoordinator(deps: ShutdownCoordinatorDeps): ShutdownCoordinator {
  let inFlight: Promise<ShutdownResult> | null = null

  async function run(): Promise<ShutdownResult> {
    const errors: ShutdownError[] = []
    const phases: Array<[ShutdownPhase, () => void | Promise<void>]> = [
      ['disconnectIngress', deps.disconnectIngress],
      ['stopAgent', deps.stopAgent],
      ['awaitAgent', deps.awaitAgent],
      ['drainIngress', deps.drainIngress],
      ['stopJobs', deps.stopJobs],
      ['saveFinal', deps.saveFinal],
      ['disconnectDb', deps.disconnectDb],
    ]

    for (const [phase, execute] of phases) {
      try {
        await withTimeout(Promise.resolve().then(execute), deps.timeoutMs, phase)
      } catch (error) {
        const item = {
          phase,
          error: error instanceof Error ? error.message : String(error),
        }
        errors.push(item)
        deps.onPhaseError?.(item)
      }
    }

    return { ok: errors.length === 0, errors }
  }

  return {
    shutdown() {
      inFlight ??= run()
      return inFlight
    },
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, phase: ShutdownPhase): Promise<T> {
  if (timeoutMs <= 0) return promise
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${phase} timed out after ${timeoutMs}ms`)), timeoutMs)
      }),
    ])
  } finally {
    if (timer != null) clearTimeout(timer)
  }
}
