import '@tanstack/react-start/server-only'
import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import {
  parseOverviewToolLog,
  summarizeOverviewToolLog,
  type OverviewToolActivityInput,
  type ParsedOverviewToolLog,
} from './overview-tool-log.js'

const DEFAULT_TOOL_CALL_LOG_PATH = 'logs/tool-calls.ndjson'
type ToolAuditMode = 'all' | 'side_effects' | 'off'

interface ToolLogCacheEntry {
  signature: string
  parsed: ParsedOverviewToolLog
}

const cache = new Map<string, ToolLogCacheEntry>()

export async function loadOverviewToolActivity(
  repositoryRoot: string,
  now: Date,
  env: NodeJS.ProcessEnv = process.env,
): Promise<OverviewToolActivityInput> {
  const configuredPath = env.BOT_TOOL_CALL_LOG_PATH?.trim() || DEFAULT_TOOL_CALL_LOG_PATH
  const path = isAbsolute(configuredPath) ? configuredPath : join(repositoryRoot, configuredPath)
  const mode = parseToolAuditMode(env.BOT_TOOL_AUDIT_MODE)
  const modeWarnings = toolAuditModeWarnings(mode)

  try {
    const metadata = await stat(path)
    const signature = `${metadata.dev}:${metadata.ino}:${metadata.size}:${metadata.mtimeMs}`
    let parsed = cache.get(path)?.signature === signature ? cache.get(path)!.parsed : undefined
    if (!parsed) {
      parsed = parseOverviewToolLog(await readFile(path, 'utf8'))
      cache.set(path, { signature, parsed })
    }
    return summarizeOverviewToolLog(parsed, now, modeWarnings)
  } catch (error) {
    if (isMissingFile(error)) {
      return summarizeOverviewToolLog({ entries: [], invalidLines: 0 }, now, [
        ...modeWarnings,
        '工具审计日志不存在，最近进展暂不可用。',
      ])
    }
    return summarizeOverviewToolLog({ entries: [], invalidLines: 0 }, now, [
      ...modeWarnings,
      '工具审计日志读取失败，最近进展暂不可用。',
    ])
  }
}

function parseToolAuditMode(value: string | undefined): ToolAuditMode {
  return value === 'all' || value === 'off' || value === 'side_effects'
    ? value
    : 'side_effects'
}

function toolAuditModeWarnings(mode: ToolAuditMode): string[] {
  if (mode === 'all') return []
  if (mode === 'off') return ['工具审计当前已关闭；最近进展只会显示日志中已有的历史记录。']
  return ['工具审计模式为 side_effects；最近进展只包含副作用调用。']
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}
