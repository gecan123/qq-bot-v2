import { AsyncLocalStorage } from 'node:async_hooks'

export interface TokenUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

export interface TokenUsageBucket extends TokenUsage {
  calls: number
}

export interface TokenUsageSummary {
  total: TokenUsageBucket
  byOperation: Record<string, TokenUsageBucket>
}

export interface OpenAITokenUsageLike {
  prompt_tokens?: number | null
  completion_tokens?: number | null
  total_tokens?: number | null
}

function createEmptyBucket(): TokenUsageBucket {
  return {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    calls: 0,
  }
}

export class TokenUsageTracker {
  private total = createEmptyBucket()
  private byOperation = new Map<string, TokenUsageBucket>()

  record(operation: string, usage: TokenUsage): void {
    const bucket = this.byOperation.get(operation) ?? createEmptyBucket()
    bucket.promptTokens += usage.promptTokens
    bucket.completionTokens += usage.completionTokens
    bucket.totalTokens += usage.totalTokens
    bucket.calls += 1
    this.byOperation.set(operation, bucket)

    this.total.promptTokens += usage.promptTokens
    this.total.completionTokens += usage.completionTokens
    this.total.totalTokens += usage.totalTokens
    this.total.calls += 1
  }

  snapshot(): TokenUsageSummary {
    return {
      total: { ...this.total },
      byOperation: Object.fromEntries(
        Array.from(this.byOperation.entries(), ([operation, bucket]) => [operation, { ...bucket }]),
      ),
    }
  }
}

const tokenUsageStorage = new AsyncLocalStorage<TokenUsageTracker>()

export async function runWithTokenUsageTracking<T>(fn: () => Promise<T>): Promise<T> {
  return tokenUsageStorage.run(new TokenUsageTracker(), fn)
}

export function getCurrentTokenUsageTracker(): TokenUsageTracker | undefined {
  return tokenUsageStorage.getStore()
}

export function recordCurrentTokenUsage(operation: string, usage: TokenUsage | null | undefined): void {
  if (!usage) return
  tokenUsageStorage.getStore()?.record(operation, usage)
}

export function toTokenUsage(usage: OpenAITokenUsageLike | null | undefined): TokenUsage | null {
  if (!usage) return null

  const promptTokens = usage.prompt_tokens ?? 0
  const completionTokens = usage.completion_tokens ?? 0
  const totalTokens = usage.total_tokens ?? promptTokens + completionTokens

  if (promptTokens === 0 && completionTokens === 0 && totalTokens === 0) return null

  return {
    promptTokens,
    completionTokens,
    totalTokens,
  }
}

