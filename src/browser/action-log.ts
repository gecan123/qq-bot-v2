import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { createLogger } from '../logger.js'
import type { BrowserActionInput, BrowserActionJsonResult } from './protocol.js'
import { redactBrowserValue } from './risk.js'

const log = createLogger('BROWSER_ACTION_LOG')
const DEFAULT_BROWSER_ACTION_LOG_PATH = 'logs/browser-actions.ndjson'

export interface BrowserActionLogEntry {
  ts: string
  action: string
  pageId?: string
  url?: string
  title?: string
  argsSummary: unknown
  risk?: string
  riskReason?: string
  ok: boolean
  code?: string
  error?: string
  artifactId?: string
  durationMs: number
}

export interface BrowserActionLogOptions {
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

export async function logBrowserAction(
  entry: BrowserActionLogEntry,
  options: BrowserActionLogOptions = {},
): Promise<void> {
  const path = options.path ?? DEFAULT_BROWSER_ACTION_LOG_PATH
  const appender = options.appender ?? defaultAppender
  try {
    await appender(path, JSON.stringify(entry) + '\n')
  } catch (err) {
    log.warn({ err, path, action: entry.action }, 'browser_action_log_write_failed')
  }
}

export function buildBrowserActionLogEntry(input: {
  startedAt: number
  action: BrowserActionInput
  result: BrowserActionJsonResult
  now?: () => Date
}): BrowserActionLogEntry {
  const finishedAt = Date.now()
  const argsSummary = redactBrowserValue(input.action) as Record<string, unknown>
  if (input.action.action === 'type' && input.result.risk === 'high' && 'text' in argsSummary) {
    argsSummary.text = '[REDACTED]'
  }
  return {
    ts: (input.now?.() ?? new Date()).toISOString(),
    action: input.action.action,
    ...(input.action.pageId ? { pageId: input.action.pageId } : {}),
    ...(input.result.url ? { url: input.result.url } : {}),
    ...(input.result.title ? { title: input.result.title } : {}),
    argsSummary,
    ...(input.result.risk ? { risk: input.result.risk } : {}),
    ...(input.result.reason ? { riskReason: input.result.reason } : {}),
    ok: input.result.ok,
    ...(input.result.code ? { code: input.result.code } : {}),
    ...(input.result.error ? { error: input.result.error } : {}),
    ...(input.result.artifactId ? { artifactId: input.result.artifactId } : {}),
    durationMs: Math.max(0, Math.round(finishedAt - input.startedAt)),
  }
}

export function __resetBrowserActionLogStateForTest(): void {
  parentDirEnsured = new Set<string>()
}
