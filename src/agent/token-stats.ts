import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { config } from '../config/index.js'
import { createLogger } from '../logger.js'
import { formatBeijingIso } from '../utils/beijing-time.js'
import type { LlmCallTraceEvidence } from './llm-call-evidence.js'

const log = createLogger('TOKEN_STATS')

export type AgentTokenOperation =
  | 'agent.chat'
  | 'compaction'
  | 'life_journal.review'
  | 'life_journal.idle_pick'
  | 'memory.maintenance'
  | 'goal.completion_judge'
  | 'persona.self_test'
  | 'fetch_url.summary'
  | 'long_term_state.translate'

export interface TokenUsageEntry {
  callId?: string
  operation: AgentTokenOperation
  actor?: string
  roundIndex?: number
  goalId?: string
  taskId?: string
  attempt?: number
  provider?: string
  status?: 'succeeded' | 'failed' | 'aborted'
  durationMs?: number
  stopReason?: string
  errorKind?: string
  inputTokens: number | null
  cachedTokens: number | null
  outputTokens: number | null
  model: string
  evidence?: LlmCallTraceEvidence
}

let dirEnsured = false
let dbPersistenceEnabled = false

export function setTokenUsageDbPersistenceEnabled(enabled: boolean): void {
  dbPersistenceEnabled = enabled
}

export function recordTokenUsage(entry: TokenUsageEntry): void {
  const logPath = config.tokenUsageLogPath
  const cacheHitRate =
    entry.inputTokens != null && entry.cachedTokens != null && entry.inputTokens > 0
      ? entry.cachedTokens / entry.inputTokens
      : null

  const event = {
    ts: formatBeijingIso(new Date()),
    ...(entry.callId ? { callId: entry.callId } : {}),
    operation: entry.operation,
    ...(entry.actor ? { actor: entry.actor } : {}),
    ...(entry.roundIndex != null ? { roundIndex: entry.roundIndex } : {}),
    ...(entry.goalId ? { goalId: entry.goalId } : {}),
    ...(entry.taskId ? { taskId: entry.taskId } : {}),
    ...(entry.attempt != null ? { attempt: entry.attempt } : {}),
    ...(entry.provider ? { provider: entry.provider } : {}),
    status: entry.status ?? 'succeeded',
    ...(entry.durationMs != null ? { durationMs: entry.durationMs } : {}),
    ...(entry.stopReason ? { stopReason: entry.stopReason } : {}),
    ...(entry.errorKind ? { errorKind: entry.errorKind } : {}),
    inputTokens: entry.inputTokens,
    cachedTokens: entry.cachedTokens,
    outputTokens: entry.outputTokens,
    model: entry.model,
    ...(cacheHitRate != null ? { cacheHitRate: Math.round(cacheHitRate * 1000) / 1000 } : {}),
    ...(entry.evidence ? { evidence: entry.evidence } : {}),
  }
  const line = JSON.stringify(event)

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

  if (dbPersistenceEnabled) {
    import('../ops/agent-observability-db.js')
      .then(({ recordAgentTokenUsageEvent }) => recordAgentTokenUsageEvent(event))
      .catch((err) => {
        log.warn({ err }, 'agent_token_usage_db_writer_load_failed')
      })
  }
}
