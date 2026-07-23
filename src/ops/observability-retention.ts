import { randomUUID } from 'node:crypto'
import { open, rename, unlink } from 'node:fs/promises'
import { prisma } from '../database/client.js'
import { createLogger } from '../logger.js'
import { formatBeijingIso } from '../utils/beijing-time.js'

const log = createLogger('OBSERVABILITY_RETENTION')

export interface ObservabilityRetentionStore {
  deleteToolCallsBefore(cutoff: Date): Promise<number>
  deleteTokenUsageBefore(cutoff: Date): Promise<number>
  deleteLlmCallsBefore(cutoff: Date): Promise<number>
}

export type ObservabilityRetentionFailure = {
  target: string
  error: string
}

export type ObservabilityRetentionReport = {
  disabled: boolean
  deletedToolCalls: number
  deletedTokenUsage: number
  deletedLlmCalls: number
  files: ObservabilityRetentionFileReport[]
  failures: ObservabilityRetentionFailure[]
}

export type ObservabilityRetentionFileReport = {
  path: string
  removedLines: number
  retainedLines: number
  unparseableTimestampLines: number
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
  async deleteLlmCallsBefore(cutoff) {
    const result = await prisma.agentLlmCall.deleteMany({ where: { ts: { lt: cutoff } } })
    return result.count
  },
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

function inspectNdjsonLine(line: Buffer, cutoffMs: number): {
  retain: boolean
  unparseableTimestamp: boolean
} {
  let parsed: unknown
  try {
    parsed = JSON.parse(line.toString('utf8'))
  } catch {
    return { retain: true, unparseableTimestamp: true }
  }

  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { retain: true, unparseableTimestamp: true }
  }
  const record = parsed as Record<string, unknown>
  const timestamp = record.ts ?? record.time
  if (typeof timestamp !== 'string') {
    return { retain: true, unparseableTimestamp: true }
  }
  const timestampMs = Date.parse(timestamp)
  if (!Number.isFinite(timestampMs)) {
    return { retain: true, unparseableTimestamp: true }
  }
  return { retain: timestampMs >= cutoffMs, unparseableTimestamp: false }
}

async function pruneNdjsonFile(
  filePath: string,
  cutoff: Date,
): Promise<ObservabilityRetentionFileReport | undefined> {
  let input
  try {
    input = await open(filePath, 'r')
  } catch (error) {
    if (isMissingFile(error)) return undefined
    throw error
  }

  const tempPath = `${filePath}.retention-${process.pid}-${randomUUID()}.tmp`
  let output
  try {
    const inputStat = await input.stat()
    output = await open(tempPath, 'wx', inputStat.mode)
    const report: ObservabilityRetentionFileReport = {
      path: filePath,
      removedLines: 0,
      retainedLines: 0,
      unparseableTimestampLines: 0,
    }
    let pending: Buffer = Buffer.alloc(0)

    const processLine = async (lineWithEnding: Buffer) => {
      let contentEnd = lineWithEnding.length
      if (contentEnd > 0 && lineWithEnding[contentEnd - 1] === 0x0a) contentEnd--
      if (contentEnd > 0 && lineWithEnding[contentEnd - 1] === 0x0d) contentEnd--
      const inspection = inspectNdjsonLine(lineWithEnding.subarray(0, contentEnd), cutoff.getTime())
      if (inspection.unparseableTimestamp) report.unparseableTimestampLines++
      if (inspection.retain) {
        report.retainedLines++
        await output!.write(lineWithEnding)
      } else {
        report.removedLines++
      }
    }

    for await (const chunk of input.createReadStream({ autoClose: false })) {
      pending = pending.length === 0
        ? chunk as Buffer
        : Buffer.concat([pending, chunk as Buffer])
      let lineStart = 0
      for (let index = 0; index < pending.length; index++) {
        if (pending[index] !== 0x0a) continue
        await processLine(pending.subarray(lineStart, index + 1))
        lineStart = index + 1
      }
      pending = pending.subarray(lineStart)
    }
    if (pending.length > 0) await processLine(pending)

    await output.sync()
    await output.close()
    output = undefined
    await input.close()
    input = undefined
    await rename(tempPath, filePath)
    return report
  } catch (error) {
    await output?.close().catch(() => undefined)
    await unlink(tempPath).catch(() => undefined)
    throw error
  } finally {
    await input?.close().catch(() => undefined)
  }
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
    deletedLlmCalls: 0,
    files: [],
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

  try {
    report.deletedLlmCalls = await store.deleteLlmCallsBefore(cutoff)
  } catch (error) {
    report.failures.push({ target: 'agent_llm_calls', error: errorMessage(error) })
  }

  for (const filePath of new Set(options.ndjsonPaths)) {
    try {
      const fileReport = await pruneNdjsonFile(filePath, cutoff)
      if (fileReport) {
        report.files.push(fileReport)
        if (fileReport.unparseableTimestampLines > 0) {
          log.warn(
            {
              path: filePath,
              unparseableTimestampLines: fileReport.unparseableTimestampLines,
            },
            'NDJSON 日志包含无法解析时间戳的保留记录',
          )
        }
      }
    } catch (error) {
      report.failures.push({ target: filePath, error: errorMessage(error) })
    }
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
        deletedLlmCalls: report.deletedLlmCalls,
      },
      '观测数据清理完成',
    )
  }

  return report
}
