import { createLogger } from '../logger.js'

const log = createLogger('RETENTION_RUNNER')
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1_000
const DEFAULT_RUN_HOUR = 3

type Timer = ReturnType<typeof setTimeout>

export interface DailyRetentionRunner {
  start(): void
  stop(): Promise<void>
}

export interface DailyRetentionRunnerOptions {
  run(): Promise<void>
  now?: () => Date
  runHour?: number
  setTimer?: (callback: () => void, delayMs: number) => Timer
  clearTimer?: (timer: Timer) => void
  onError?: (error: unknown) => void
}

export function createDailyRetentionRunner(options: DailyRetentionRunnerOptions): DailyRetentionRunner {
  const now = options.now ?? (() => new Date())
  const runHour = options.runHour ?? DEFAULT_RUN_HOUR
  const setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs))
  const clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer))
  const onError = options.onError ?? ((error) => log.warn({ error }, 'daily_retention_failed'))
  let timer: Timer | null = null
  let active: Promise<void> | null = null
  let stopped = true

  function runSingleFlight(): Promise<void> {
    if (active) return active
    const current = Promise.resolve()
      .then(options.run)
      .catch(onError)
      .finally(() => {
        if (active === current) active = null
      })
    active = current
    return current
  }

  function armNext(): void {
    if (stopped) return
    const delayMs = millisecondsUntilNextBeijingHour(now(), runHour)
    timer = setTimer(() => {
      timer = null
      void runSingleFlight().finally(armNext)
    }, delayMs)
    timer.unref?.()
  }

  return {
    start() {
      if (!stopped) return
      stopped = false
      void runSingleFlight()
      armNext()
    },
    async stop() {
      if (stopped) return
      stopped = true
      if (timer) {
        clearTimer(timer)
        timer = null
      }
      await active
    },
  }
}

export function millisecondsUntilNextBeijingHour(now: Date, hour: number): number {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new Error(`invalid Beijing retention hour: ${hour}`)
  }
  const beijingNow = new Date(now.getTime() + BEIJING_OFFSET_MS)
  let nextUtcMs = Date.UTC(
    beijingNow.getUTCFullYear(),
    beijingNow.getUTCMonth(),
    beijingNow.getUTCDate(),
    hour,
  ) - BEIJING_OFFSET_MS
  if (nextUtcMs <= now.getTime()) nextUtcMs += 24 * 60 * 60 * 1_000
  return nextUtcMs - now.getTime()
}
