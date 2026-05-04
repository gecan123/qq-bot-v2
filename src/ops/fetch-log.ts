import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { config } from '../config/index.js'
import { createLogger } from '../logger.js'

const log = createLogger('FETCH_LOG')

/**
 * 旁路 NDJSON 运维日志: 每次 fetch_* 工具调用 append 一行到 logs/fetch.ndjson。
 *
 * 这不是数据持久化, 不进 Prisma, 不进 AgentContext。LLM 看不到这个文件。
 * 设计目的: 两周后用 grep + jq 跑统计 (fetch 频率 / 重复 URL 比例 / 失败率)。
 *
 * 容错: appendFile 失败 (磁盘满 / 权限 / 父目录不存在) 不影响 tool 主流程,
 * 只在内部 logger 里打 warn, 然后 swallow。
 */
export interface FetchLogEntry {
  ts: string
  source: string
  url: string
  status: number
  bytes: number
  toolCallId: string
  durationMs: number
  errorKind?: string
}

interface LogFetchOptions {
  path?: string
  appender?: (path: string, line: string) => Promise<void>
}

let parentDirEnsured = new Set<string>()

async function defaultAppender(path: string, line: string): Promise<void> {
  const dir = dirname(path)
  if (!parentDirEnsured.has(dir)) {
    await mkdir(dir, { recursive: true })
    parentDirEnsured.add(dir)
  }
  await appendFile(path, line, 'utf8')
}

export async function logFetch(
  entry: FetchLogEntry,
  options: LogFetchOptions = {},
): Promise<void> {
  const path = options.path ?? config.fetchLogPath
  const appender = options.appender ?? defaultAppender
  try {
    await appender(path, JSON.stringify(entry) + '\n')
  } catch (err) {
    log.warn({ err, path }, 'fetch_log_write_failed')
  }
}

/** 测试用 reset; 生产代码不应调用。 */
export function __resetFetchLogStateForTest(): void {
  parentDirEnsured = new Set<string>()
}
