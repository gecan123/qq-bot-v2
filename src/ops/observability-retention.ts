import { prisma } from '../database/client.js'
import { createLogger } from '../logger.js'
import { formatBeijingIso } from '../utils/beijing-time.js'

const log = createLogger('OBSERVABILITY_RETENTION')

export interface ObservabilityRetentionStore {
  deleteToolCallsBefore(cutoff: Date): Promise<number>
  deleteTokenUsageBefore(cutoff: Date): Promise<number>
}

export type ObservabilityRetentionFailure = {
  target: string
  error: string
}

export type ObservabilityRetentionReport = {
  disabled: boolean
  deletedToolCalls: number
  deletedTokenUsage: number
  failures: ObservabilityRetentionFailure[]
}

const prismaObservabilityRetentionStore: ObservabilityRetentionStore = {
  async deleteToolCallsBefore(cutoff) {
    const result = await prisma.agentToolCall.deleteMany({ where: { ts: { lt: cutoff } } })
    return result.count
  },
  async deleteTokenUsageBefore(cutoff) {
    const result = await prisma.agentTokenUsage.deleteMany({ where: { ts: { lt: cutoff } } })
    return result.count
  },
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function purgeObservabilityData(options: {
  retentionDays: number
  now?: () => Date
  store?: ObservabilityRetentionStore
  ndjsonPaths: readonly string[]
}): Promise<ObservabilityRetentionReport> {
  const report: ObservabilityRetentionReport = {
    disabled: options.retentionDays === 0,
    deletedToolCalls: 0,
    deletedTokenUsage: 0,
    failures: [],
  }
  if (report.disabled) return report

  const now = options.now?.() ?? new Date()
  const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate() - options.retentionDays)
  const store = options.store ?? prismaObservabilityRetentionStore

  try {
    report.deletedToolCalls = await store.deleteToolCallsBefore(cutoff)
  } catch (error) {
    report.failures.push({ target: 'agent_tool_calls', error: errorMessage(error) })
  }

  try {
    report.deletedTokenUsage = await store.deleteTokenUsageBefore(cutoff)
  } catch (error) {
    report.failures.push({ target: 'agent_token_usage', error: errorMessage(error) })
  }

  if (report.failures.length > 0) {
    log.warn(
      { cutoff: formatBeijingIso(cutoff), failures: report.failures },
      '观测数据清理部分失败',
    )
  } else {
    log.info(
      {
        cutoff: formatBeijingIso(cutoff),
        deletedToolCalls: report.deletedToolCalls,
        deletedTokenUsage: report.deletedTokenUsage,
      },
      '观测数据库清理完成',
    )
  }

  return report
}
