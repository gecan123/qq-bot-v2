const TRANSIENT_ERROR_CODES = new Set([
  'P1001',
  'P1002',
  'P1008',
  'P1017',
  'P2024',
  'P2034',
  'ECONNREFUSED',
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
])

export interface TransientRetryOptions {
  maxAttempts?: number
  baseDelayMs?: number
  sleep?: (ms: number) => Promise<void>
  random?: () => number
  jitterRatio?: number
  onRetry?: (input: { error: unknown; attempt: number; delayMs: number }) => void
}

export async function withTransientRetry<T>(
  operation: () => Promise<T>,
  options: TransientRetryOptions = {},
): Promise<T> {
  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? 3))
  const baseDelayMs = Math.max(0, Math.floor(options.baseDelayMs ?? 50))
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const random = options.random ?? Math.random
  const jitterRatio = Math.max(0, Math.min(0.5, options.jitterRatio ?? 0.15))
  for (let attempt = 1; ; attempt++) {
    try {
      return await operation()
    } catch (error) {
      if (attempt >= maxAttempts || !isTransientError(error)) throw error
      const exponentialDelay = baseDelayMs * 2 ** (attempt - 1)
      const delayMs = Math.max(0, Math.round(
        exponentialDelay * (1 + (random() - 0.5) * 2 * jitterRatio),
      ))
      options.onRetry?.({ error, attempt, delayMs })
      await sleep(delayMs)
    }
  }
}

export function isTransientError(error: unknown): boolean {
  let current: unknown = error
  for (let depth = 0; depth < 3 && current && typeof current === 'object'; depth++) {
    const code = (current as { code?: unknown }).code
    if (typeof code === 'string' && TRANSIENT_ERROR_CODES.has(code)) return true
    current = (current as { cause?: unknown }).cause
  }
  return false
}
