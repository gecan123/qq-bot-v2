import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { createLogger } from '../logger.js'

const log = createLogger('TOOL_CALL_LOG')

const DEFAULT_TOOL_CALL_LOG_PATH = 'logs/tool-calls.ndjson'
const MAX_STRING_LENGTH = 240
const MAX_ARRAY_ITEMS = 12
const MAX_OBJECT_KEYS = 24
const MAX_DEPTH = 4

const SENSITIVE_KEY_RE = /(?:api[_-]?key|token|secret|password|passwd|authorization|cookie|access[_-]?token)/i
const SENSITIVE_ID_KEYS = new Set([
  'groupId',
  'userId',
  'peerId',
  'qq',
  'mentionUserId',
  'selfNumber',
])

export interface ToolCallLogEntry {
  ts: string
  toolCallId: string
  toolName: string
  roundIndex: number
  argsSummary: unknown
  durationMs: number
  ok: boolean
  sideEffect: boolean
  error?: string
}

export interface ToolCallLogOptions {
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

export async function logToolCall(
  entry: ToolCallLogEntry,
  options: ToolCallLogOptions = {},
): Promise<void> {
  const path = options.path ?? DEFAULT_TOOL_CALL_LOG_PATH
  const appender = options.appender ?? defaultAppender
  try {
    await appender(path, JSON.stringify(entry) + '\n')
  } catch (err) {
    log.warn({ err, path, toolName: entry.toolName, toolCallId: entry.toolCallId }, 'tool_call_log_write_failed')
  }
}

export function summarizeToolArgs(args: unknown): unknown {
  return summarizeValue(args, 0, null)
}

function summarizeValue(value: unknown, depth: number, key: string | null): unknown {
  if (key && shouldRedactKey(key)) return '[REDACTED]'
  if (value == null) return value
  if (typeof value === 'string') return summarizeString(value)
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'bigint') return value.toString()
  if (typeof value !== 'object') return `[${typeof value}]`
  if (depth >= MAX_DEPTH) return '[MAX_DEPTH]'

  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY_ITEMS).map((item) => summarizeValue(item, depth + 1, null))
    if (value.length > MAX_ARRAY_ITEMS) items.push(`[${value.length - MAX_ARRAY_ITEMS} more]`)
    return items
  }

  const out: Record<string, unknown> = {}
  const entries = Object.entries(value as Record<string, unknown>)
  for (const [childKey, childValue] of entries.slice(0, MAX_OBJECT_KEYS)) {
    out[childKey] = summarizeValue(childValue, depth + 1, childKey)
  }
  if (entries.length > MAX_OBJECT_KEYS) {
    out.__truncatedKeys = entries.length - MAX_OBJECT_KEYS
  }
  return out
}

function shouldRedactKey(key: string): boolean {
  return SENSITIVE_KEY_RE.test(key) || SENSITIVE_ID_KEYS.has(key)
}

function summarizeString(value: string): string {
  if (value.length <= MAX_STRING_LENGTH) return value
  return `${value.slice(0, MAX_STRING_LENGTH)}...[truncated ${value.length - MAX_STRING_LENGTH} chars]`
}

export function isSideEffectTool(toolName: string, args?: unknown): boolean {
  if (toolName === 'memory') {
    return hasAnyAction(args, ['write', 'delete'])
  }
  if (toolName === 'fetch_content') {
    return hasAnyAction(args, ['image_url', 'qq_avatar'])
  }
  if (toolName === 'journal') {
    return hasAction(args, 'write')
  }
  if (toolName === 'life_journal') {
    return hasAnyAction(args, ['write', 'write_agenda'])
  }
  if (toolName === 'skill_editor') {
    return hasAnyAction(args, ['draft', 'install'])
  }
  if (toolName === 'workspace_bash') {
    return isWorkspaceBashSideEffect(args)
  }
  return SIDE_EFFECT_TOOLS.has(toolName)
}

function hasAction(args: unknown, action: string): boolean {
  return !!args && typeof args === 'object' && (args as Record<string, unknown>).action === action
}

function hasAnyAction(args: unknown, actions: readonly string[]): boolean {
  return !!args && typeof args === 'object' && actions.includes(String((args as Record<string, unknown>).action))
}

function isWorkspaceBashSideEffect(args: unknown): boolean {
  if (!args || typeof args !== 'object') return true
  const raw = args as Record<string, unknown>
  const command = typeof raw.command === 'string' ? raw.command.trim() : ''
  if (!command) return true
  if (raw.cwd === 'repo') return false
  if (/[\r\n;&|`<]/.test(command) || command.includes('$(')) return true

  const first = firstShellToken(command)
  if (!first) return true
  if (command.includes('>')) return true
  if (first === 'mkdir' || first === 'touch') return true
  if (first === 'journal') {
    if (command === 'journal write' || command.startsWith('journal write ')) return true
    return isKnownWorkspaceSubcommand(command, ['journal list', 'journal search', 'journal read']) ? false : true
  }
  if (first === 'fetch') {
    if (command === 'fetch image' || command.startsWith('fetch image ')) return true
    if (command === 'fetch avatar' || command.startsWith('fetch avatar ')) return true
    return isKnownWorkspaceSubcommand(command, ['fetch url', 'fetch reddit list', 'fetch reddit post']) ? false : true
  }
  if (first === 'help' || first === 'db' || first === 'style' || first === 'openbb') return false
  if (first === 'pwd' || first === 'ls' || first === 'rg' || first === 'cat' || first === 'head' || first === 'tail' || first === 'wc' || first === 'printf') {
    return false
  }
  return true
}

function firstShellToken(command: string): string | null {
  const match = /^\s*([^\s"'`;&|<>]+)/.exec(command)
  return match?.[1] ?? null
}

function isKnownWorkspaceSubcommand(command: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => command === prefix || command.startsWith(`${prefix} `))
}

const SIDE_EFFECT_TOOLS = new Set([
  'send_message',
  'generate_image',
  'fetch_image',
  'download_image',
  'remember',
  'collect_sticker',
  'browser',
])

/** 测试用 reset; 生产代码不应调用。 */
export function __resetToolCallLogStateForTest(): void {
  parentDirEnsured = new Set<string>()
}
