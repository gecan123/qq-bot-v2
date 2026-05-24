import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { config } from '../config/index.js'
import { createLogger } from '../logger.js'

const log = createLogger('TOKEN_STATS')

export interface TokenUsageEntry {
  operation: 'agent.chat' | 'compaction'
  roundIndex?: number
  inputTokens: number | null
  cachedTokens: number | null
  outputTokens: number | null
  model: string
}

let dirEnsured = false

export function recordTokenUsage(entry: TokenUsageEntry): void {
  const logPath = config.tokenUsageLogPath
  const cacheHitRate =
    entry.inputTokens != null && entry.cachedTokens != null && entry.inputTokens > 0
      ? entry.cachedTokens / entry.inputTokens
      : null

  const line = JSON.stringify({
    ts: new Date().toISOString(),
    operation: entry.operation,
    ...(entry.roundIndex != null ? { roundIndex: entry.roundIndex } : {}),
    inputTokens: entry.inputTokens,
    cachedTokens: entry.cachedTokens,
    outputTokens: entry.outputTokens,
    model: entry.model,
    ...(cacheHitRate != null ? { cacheHitRate: Math.round(cacheHitRate * 1000) / 1000 } : {}),
  })

  const doWrite = async () => {
    if (!dirEnsured) {
      await mkdir(dirname(logPath), { recursive: true })
      dirEnsured = true
    }
    await appendFile(logPath, line + '\n', 'utf-8')
  }

  doWrite().catch((err) => {
    log.warn({ err, path: logPath }, 'token_usage_write_failed')
  })
}
