import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { isAbsolute, normalize, resolve } from 'node:path'
import { z } from 'zod'
import type { Tool } from '../tool.js'
import type { DbReadResult, ExecuteDbReadParams } from '../../database/agent-sql.js'
import type { GroupPolicy } from '../../config/group-policies.js'
import type { TargetMetadataMaps } from '../resolve-target-meta.js'
import { createDbTool } from './db.js'
import { createChatStyleTool } from './chat-style.js'
import { isAllowedOpenbbCommand, maybeCreateOpenbbCliTool } from './openbb-cli.js'
import { isAllowedMoomooSkillCommand, maybeCreateMoomooSkillTool } from './moomoo-skill.js'
import { createFetchContentTool } from './fetch-content.js'
import { predictAiTone, type AiTonePrediction, type AiTonePredictor } from './ai-tone.js'

const DEFAULT_WORKSPACE_DIR = 'data/agent-workspace'
const DEFAULT_TIMEOUT_MS = 5_000
const DEFAULT_OUTPUT_CAP_CHARS = 4_000
const DEFAULT_PATH = process.env.PATH ?? '/usr/bin:/bin'
const FETCH_ALLOWED_SUBREDDITS = ['technology', 'ClaudeAI', 'OpenAI', 'wallstreetbets', 'memes'] as const
const FETCH_ALLOWED_SUBREDDIT_SET = new Set<string>(FETCH_ALLOWED_SUBREDDITS)
const FETCH_REDDIT_POST_REGEX =
  /^https?:\/\/(?:www\.|old\.)?reddit\.com\/r\/[A-Za-z0-9_]+\/comments\/[A-Za-z0-9]+(?:\/[^?#]*)?\/?(?:[?#].*)?$/

const WORKSPACE_COMMANDS = new Set([
  'pwd',
  'ls',
  'rg',
  'cat',
  'head',
  'tail',
  'wc',
])

const REPO_READ_COMMANDS = new Set([
  'pwd',
  'ls',
  'rg',
  'cat',
  'head',
  'tail',
  'wc',
])

const REPO_BLOCKED_PATH_PREFIXES = [
  '.env',
  '.git',
  'data',
  'logs',
  'node_modules',
  'prompts/groups.md',
]

const argsSchema = z.object({
  cwd: z
    .enum(['workspace', 'repo'])
    .default('workspace')
    .describe('执行视图. workspace=私有工作区只读视图和受控子命令; repo=仓库代码只读视图.'),
  command: z
    .string()
    .trim()
    .min(1)
    .max(2000)
    .describe('受限 Bash 命令. workspace 和 repo 的普通文件命令只读; 内置 db/style/fetch/openbb/moomoo/ai_tone/metrics 子命令走专用 wrapper.'),
})

type Args = {
  cwd?: 'workspace' | 'repo'
  command: string
}

export interface ParsedWorkspaceCommand {
  ok: true
  kind: 'workspace'
  cwd: 'workspace' | 'repo'
  command: string
  args: string[]
}

export interface ParsedDbToolCommand {
  ok: true
  kind: 'db_tool'
  cwd: 'workspace'
  action: 'schema' | 'query'
  sql?: string
  params?: Record<string, string | number | boolean | null>
}

export interface ParsedStyleCommand {
  ok: true
  kind: 'style'
  cwd: 'workspace'
  scope: 'global' | 'group'
  section?: 'constraints' | 'base' | 'anti_patterns' | 'special_cases'
  groupId?: number
}

export interface ParsedOpenbbCommand {
  ok: true
  kind: 'openbb'
  cwd: 'workspace'
  command: string
  output?: unknown
}

export interface ParsedMoomooCommand {
  ok: true
  kind: 'moomoo'
  cwd: 'workspace'
  command: string
}

export interface ParsedFetchCommand {
  ok: true
  kind: 'fetch'
  cwd: 'workspace'
  action: 'url' | 'image_url' | 'qq_avatar' | 'reddit_list' | 'reddit_post'
  url?: string
  hint?: string
  qq?: number
  size?: '640' | '100' | '40'
  subreddit?: (typeof FETCH_ALLOWED_SUBREDDITS)[number]
  sort?: 'hot' | 'top' | 'new'
  limit?: number
}

export interface ParsedAiToneCommand {
  ok: true
  kind: 'ai_tone'
  cwd: 'workspace'
  text: string
  threshold?: number
}

export interface ParsedMetricsCommand {
  ok: true
  kind: 'metrics'
  cwd: 'workspace'
  date?: string
  days?: number
  endOffsetDays?: number
}

export interface ParsedHelpCommand {
  ok: true
  kind: 'help'
  cwd: 'workspace'
  topic?: 'workspace' | 'repo' | 'db' | 'style' | 'openbb' | 'moomoo' | 'fetch' | 'ai_tone' | 'metrics'
}

export type ParsedWorkspaceBashCommand =
  | ParsedWorkspaceCommand
  | ParsedDbToolCommand
  | ParsedStyleCommand
  | ParsedOpenbbCommand
  | ParsedMoomooCommand
  | ParsedFetchCommand
  | ParsedAiToneCommand
  | ParsedMetricsCommand
  | ParsedHelpCommand
  | { ok: false; error: string }

export interface WorkspaceBashRunInput {
  executable: string
  args: string[]
  cwd: string
  env: Record<string, string>
  stdin?: string
  timeoutMs: number
  maxOutputChars: number
}

export interface WorkspaceBashRunResult {
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

export type WorkspaceBashRunner = (input: WorkspaceBashRunInput) => Promise<WorkspaceBashRunResult>

export interface WorkspaceBashDeps {
  workspaceDir?: string
  repoDir?: string
  runner?: WorkspaceBashRunner
  timeoutMs?: number
  maxOutputChars?: number
  groupIdWhitelist?: readonly number[]
  executeDbRead?: (params: ExecuteDbReadParams) => Promise<DbReadResult | unknown>
  groupIds?: readonly number[]
  metadata?: TargetMetadataMaps
  groupPolicies?: readonly GroupPolicy[]
  openbbTool?: Tool | null
  moomooTool?: Tool | null
  fetchTool?: Tool | null
  aiTonePredictor?: AiTonePredictor
  loadDailyMetrics?: (options: { date?: string; days?: number; endOffsetDays?: number }) => Promise<unknown>
}

function shellTokens(command: string): string[] | null {
  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let escaped = false

  for (const ch of command.trim()) {
    if (quote === "'") {
      if (ch === quote) quote = null
      else current += ch
      continue
    }
    if (escaped) {
      current += ch
      escaped = false
      continue
    }
    if (ch === '\\') {
      escaped = true
      continue
    }
    if (quote) {
      if (ch === quote) quote = null
      else current += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (/\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push(current)
        current = ''
      }
      continue
    }
    current += ch
  }

  if (quote) return null
  if (current.length > 0) tokens.push(current)
  return tokens
}

function hasForbiddenShellSyntax(command: string): boolean {
  return /[\r\n;&|`<]/.test(command) || command.includes('$(')
}

function isSafeRelativePath(value: string): boolean {
  if (!value || isAbsolute(value) || value.startsWith('~')) return false
  const normalized = normalize(value)
  if (normalized === '..' || normalized.startsWith(`..${'/'}`)) return false
  if (hasEnvLikePathSegment(normalized)) return false
  return true
}

function hasEnvLikePathSegment(value: string): boolean {
  return value
    .replace(/\\/g, '/')
    .split('/')
    .some((segment) => segment === '.env' || segment.startsWith('.env.'))
}

function isSafeRepoPath(value: string): boolean {
  if (!isSafeRelativePath(value)) return false
  const normalized = normalize(value).replace(/\\/g, '/')
  return !REPO_BLOCKED_PATH_PREFIXES.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`))
}

function tokenLooksLikePath(token: string): boolean {
  if (token === '.' || token.includes('/')) return true
  return token.startsWith('.')
}

function validateWorkspaceArgs(command: string, args: string[]): string | null {
  if (command === 'pwd') {
    return args.length === 0 ? null : 'pwd does not accept arguments'
  }

  for (const arg of args) {
    if (arg.startsWith('-')) continue
    if (!tokenLooksLikePath(arg)) continue
    if (!isSafeRelativePath(arg)) return `path is not allowed: ${arg}`
  }

  return null
}

function validateRepoArgs(command: string, args: string[]): string | null {
  if (command === 'pwd') {
    return args.length === 0 ? null : 'pwd does not accept arguments'
  }

  if (command === 'rg') {
    const allowedFlags = new Set([
      '--files',
      '-n',
      '--line-number',
      '-i',
      '--ignore-case',
      '-S',
      '--smart-case',
      '-F',
      '--fixed-strings',
    ])
    for (const arg of args) {
      if (arg.startsWith('-') && !allowedFlags.has(arg)) {
        return `repo rg option is not allowed: ${arg}`
      }
    }
  }

  for (const arg of args) {
    if (arg.startsWith('-')) continue
    if (!tokenLooksLikePath(arg)) continue
    if (!isSafeRepoPath(arg)) return `repo path is not allowed: ${arg}`
  }

  return null
}

function parseHelpCommand(tokens: string[], cwd: 'workspace' | 'repo'): ParsedHelpCommand | { ok: false; error: string } {
  if (cwd !== 'workspace') return { ok: false, error: 'help is only available in workspace mode' }
  if (tokens.length > 2) return { ok: false, error: 'help accepts at most one topic' }
  const topic = tokens[1]
  if (topic == null) return { ok: true, kind: 'help', cwd: 'workspace' }
  if (
    topic === 'workspace'
    || topic === 'repo'
    || topic === 'db'
    || topic === 'style'
    || topic === 'openbb'
    || topic === 'moomoo'
    || topic === 'fetch'
    || topic === 'ai_tone'
    || topic === 'metrics'
  ) {
    return { ok: true, kind: 'help', cwd: 'workspace', topic }
  }
  return { ok: false, error: 'help topic must be workspace, repo, db, style, openbb, moomoo, fetch, ai_tone, or metrics' }
}

function parseMetricsCommand(tokens: string[], cwd: 'workspace' | 'repo'): ParsedMetricsCommand | { ok: false; error: string } {
  if (cwd !== 'workspace') return { ok: false, error: 'metrics is only available in workspace mode' }
  if (tokens.length === 1 || (tokens.length === 2 && tokens[1] === 'today')) {
    return { ok: true, kind: 'metrics', cwd: 'workspace' }
  }
  if (tokens.length === 2 && tokens[1] === 'yesterday') {
    return { ok: true, kind: 'metrics', cwd: 'workspace', endOffsetDays: -1 }
  }
  if (tokens.length === 2 && isCalendarDate(tokens[1])) {
    return { ok: true, kind: 'metrics', cwd: 'workspace', date: tokens[1] }
  }
  if (tokens.length === 3 && tokens[1] === 'days' && /^\d+$/.test(tokens[2] ?? '')) {
    const days = Number(tokens[2])
    if (days >= 1 && days <= 7) return { ok: true, kind: 'metrics', cwd: 'workspace', days }
  }
  return {
    ok: false,
    error: 'metrics command must be `metrics`, `metrics today`, `metrics yesterday`, `metrics YYYY-MM-DD`, or `metrics days <1-7>`',
  }
}

function isCalendarDate(value: string | undefined): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = Date.parse(`${value}T00:00:00+08:00`)
  return Number.isFinite(parsed)
    && new Date(parsed + 8 * 60 * 60 * 1000).toISOString().slice(0, 10) === value
}

function parseDbToolCommand(
  tokens: string[],
  cwd: 'workspace' | 'repo',
  rawCommand: string,
): ParsedDbToolCommand | { ok: false; error: string } {
  if (cwd !== 'workspace') return { ok: false, error: 'db is only available in workspace mode' }
  if (tokens[1] === 'schema' && tokens.length === 2) {
    return { ok: true, kind: 'db_tool', cwd: 'workspace', action: 'schema' }
  }
  if (tokens[1] !== 'query') {
    return { ok: false, error: 'db command must be `db schema` or `db query <json>`' }
  }

  const rawPayload = rawCommand.match(/^db\s+query\s+([\s\S]+)$/)?.[1]?.trim()
  const payloadCandidates = [rawPayload, tokens.length === 3 ? tokens[2] : undefined]
    .filter((value): value is string => Boolean(value))
  let parsed: unknown = undefined
  for (const candidate of payloadCandidates) {
    try {
      parsed = JSON.parse(candidate)
      break
    } catch {
      // A shell-quoted payload fails as raw text but succeeds after shellTokens removes
      // the outer quotes; an unquoted JSON payload succeeds as raw text before its
      // internal quotes are consumed by shellTokens.
    }
  }
  if (parsed === undefined) {
    return { ok: false, error: 'db query requires JSON payload' }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'db query payload must be an object' }
  }
  const payload = parsed as Record<string, unknown>
  if (typeof payload.sql !== 'string' || payload.sql.trim().length === 0) {
    return { ok: false, error: 'db query payload requires sql string' }
  }
  const params = payload.params
  if (params != null && (!params || typeof params !== 'object' || Array.isArray(params))) {
    return { ok: false, error: 'db query params must be an object' }
  }
  return {
    ok: true,
    kind: 'db_tool',
    cwd: 'workspace',
    action: 'query',
    sql: payload.sql,
    ...(params ? { params: params as Record<string, string | number | boolean | null> } : {}),
  }
}

function parseStyleCommand(tokens: string[], cwd: 'workspace' | 'repo'): ParsedStyleCommand | { ok: false; error: string } {
  if (cwd !== 'workspace') return { ok: false, error: 'style is only available in workspace mode' }
  if (tokens[1] === 'global') {
    if (tokens.length > 3) return { ok: false, error: 'style global accepts at most one section' }
    const section = tokens[2]
    if (section == null) return { ok: true, kind: 'style', cwd: 'workspace', scope: 'global' }
    if (section !== 'constraints' && section !== 'base' && section !== 'anti_patterns' && section !== 'special_cases') {
      return { ok: false, error: 'style global section must be constraints, base, anti_patterns, or special_cases' }
    }
    return { ok: true, kind: 'style', cwd: 'workspace', scope: 'global', section }
  }
  if (tokens[1] === 'group') {
    if (tokens.length !== 3 || !/^\d+$/.test(tokens[2] ?? '')) {
      return { ok: false, error: 'style group requires numeric groupId' }
    }
    return { ok: true, kind: 'style', cwd: 'workspace', scope: 'group', groupId: Number(tokens[2]) }
  }
  return { ok: false, error: 'style command must be `style global [section]` or `style group <groupId>`' }
}

function parseOpenbbCommand(tokens: string[], cwd: 'workspace' | 'repo'): ParsedOpenbbCommand | { ok: false; error: string } {
  if (cwd !== 'workspace') return { ok: false, error: 'openbb is only available in workspace mode' }
  if (tokens.length < 2) return { ok: false, error: 'openbb requires a command' }

  if (tokens.length === 2 && tokens[1]?.trim().startsWith('{')) {
    let parsed: unknown
    try {
      parsed = JSON.parse(tokens[1])
    } catch {
      return { ok: false, error: 'openbb JSON payload is invalid' }
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, error: 'openbb JSON payload must be an object' }
    }
    const payload = parsed as Record<string, unknown>
    if (typeof payload.command !== 'string' || !isAllowedOpenbbCommand(payload.command)) {
      return { ok: false, error: 'openbb command is not allowed' }
    }
    return {
      ok: true,
      kind: 'openbb',
      cwd: 'workspace',
      command: payload.command,
      ...(payload.output != null ? { output: payload.output } : {}),
    }
  }

  const command = tokens.slice(1).join(' ')
  if (!isAllowedOpenbbCommand(command)) return { ok: false, error: 'openbb command is not allowed' }
  return { ok: true, kind: 'openbb', cwd: 'workspace', command }
}

function parseMoomooCommand(tokens: string[], cwd: 'workspace' | 'repo'): ParsedMoomooCommand | { ok: false; error: string } {
  if (cwd !== 'workspace') return { ok: false, error: 'moomoo is only available in workspace mode' }
  if (tokens.length < 2) return { ok: false, error: 'moomoo requires a command' }
  const command = tokens.slice(1).join(' ')
  if (!isAllowedMoomooSkillCommand(command)) return { ok: false, error: 'moomoo command is not allowed' }
  return { ok: true, kind: 'moomoo', cwd: 'workspace', command }
}

function isUrl(value: string | undefined): value is string {
  if (!value) return false
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

function parseFetchCommand(tokens: string[], cwd: 'workspace' | 'repo'): ParsedFetchCommand | { ok: false; error: string } {
  if (cwd !== 'workspace') return { ok: false, error: 'fetch is only available in workspace mode' }
  const subject = tokens[1]

  if (subject === 'url') {
    const url = tokens[2]
    if (!isUrl(url)) return { ok: false, error: 'fetch url requires an http(s) URL' }
    const hint = tokens.slice(3).join(' ').trim()
    if (hint.length > 200) return { ok: false, error: 'fetch url hint exceeds 200 chars' }
    return {
      ok: true,
      kind: 'fetch',
      cwd: 'workspace',
      action: 'url',
      url,
      ...(hint ? { hint } : {}),
    }
  }

  if (subject === 'image') {
    if (tokens.length !== 3 || !isUrl(tokens[2])) return { ok: false, error: 'fetch image requires exactly one http(s) URL' }
    return { ok: true, kind: 'fetch', cwd: 'workspace', action: 'image_url', url: tokens[2] }
  }

  if (subject === 'avatar') {
    if (!/^[1-9]\d*$/.test(tokens[2] ?? '')) return { ok: false, error: 'fetch avatar requires numeric QQ' }
    const size = tokens[3] ?? '640'
    if (tokens.length > 4 || (size !== '640' && size !== '100' && size !== '40')) {
      return { ok: false, error: 'fetch avatar size must be 640, 100, or 40' }
    }
    return {
      ok: true,
      kind: 'fetch',
      cwd: 'workspace',
      action: 'qq_avatar',
      qq: Number(tokens[2]),
      size,
    }
  }

  if (subject === 'reddit') {
    const redditAction = tokens[2]
    if (redditAction === 'list') {
      const subreddit = tokens[3]
      if (!subreddit || !FETCH_ALLOWED_SUBREDDIT_SET.has(subreddit)) {
        return { ok: false, error: `fetch reddit list subreddit must be one of ${FETCH_ALLOWED_SUBREDDITS.join(', ')}` }
      }
      const sort = tokens[4] ?? 'hot'
      if (sort !== 'hot' && sort !== 'top' && sort !== 'new') {
        return { ok: false, error: 'fetch reddit list sort must be hot, top, or new' }
      }
      const rawLimit = tokens[5] ?? '10'
      if (tokens.length > 6 || !/^[1-9]\d*$/.test(rawLimit)) {
        return { ok: false, error: 'fetch reddit list limit must be 1-10' }
      }
      const limit = Number(rawLimit)
      if (limit < 1 || limit > 10) return { ok: false, error: 'fetch reddit list limit must be 1-10' }
      return {
        ok: true,
        kind: 'fetch',
        cwd: 'workspace',
        action: 'reddit_list',
        subreddit: subreddit as (typeof FETCH_ALLOWED_SUBREDDITS)[number],
        sort,
        limit,
      }
    }

    if (redditAction === 'post') {
      const url = tokens[3]
      if (tokens.length !== 4 || !url || !FETCH_REDDIT_POST_REGEX.test(url)) {
        return { ok: false, error: 'fetch reddit post requires a reddit post URL' }
      }
      return { ok: true, kind: 'fetch', cwd: 'workspace', action: 'reddit_post', url }
    }
  }

  return { ok: false, error: 'fetch command must be url, image, avatar, reddit list, or reddit post' }
}

function parseAiToneCommand(tokens: string[], cwd: 'workspace' | 'repo'): ParsedAiToneCommand | { ok: false; error: string } {
  if (cwd !== 'workspace') return { ok: false, error: 'ai_tone is only available in workspace mode' }
  if (tokens.length !== 2) return { ok: false, error: 'ai_tone requires JSON payload' }

  let parsed: unknown
  try {
    parsed = JSON.parse(tokens[1]!)
  } catch {
    return { ok: false, error: 'ai_tone JSON payload is invalid' }
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'ai_tone payload must be an object' }
  }

  const payload = parsed as Record<string, unknown>
  if (typeof payload.text !== 'string' || payload.text.trim().length === 0) {
    return { ok: false, error: 'ai_tone payload requires non-empty text' }
  }
  if (payload.text.length > 2000) return { ok: false, error: 'ai_tone text exceeds 2000 chars' }
  if (
    payload.threshold != null
    && (
      typeof payload.threshold !== 'number'
      || !Number.isFinite(payload.threshold)
      || payload.threshold < 0
      || payload.threshold > 1
    )
  ) {
    return { ok: false, error: 'ai_tone threshold must be a number between 0 and 1' }
  }

  return {
    ok: true,
    kind: 'ai_tone',
    cwd: 'workspace',
    text: payload.text,
    ...(payload.threshold == null ? {} : { threshold: payload.threshold }),
  }
}

export function parseWorkspaceBashCommand(
  command: string,
  cwd: 'workspace' | 'repo' = 'workspace',
): ParsedWorkspaceBashCommand {
  const trimmed = command.trim()
  if (!trimmed) return { ok: false, error: 'command is required' }
  if (hasForbiddenShellSyntax(trimmed)) return { ok: false, error: 'shell control syntax is not allowed' }

  const tokens = shellTokens(trimmed)
  if (!tokens || tokens.length === 0) return { ok: false, error: 'could not parse command' }

  if (tokens[0] === 'help') {
    return parseHelpCommand(tokens, cwd)
  }

  if (tokens[0] === 'db') {
    return parseDbToolCommand(tokens, cwd, trimmed)
  }

  if (tokens[0] === 'style') {
    return parseStyleCommand(tokens, cwd)
  }

  if (tokens[0] === 'openbb') {
    return parseOpenbbCommand(tokens, cwd)
  }

  if (tokens[0] === 'moomoo') {
    return parseMoomooCommand(tokens, cwd)
  }

  if (tokens[0] === 'fetch') {
    return parseFetchCommand(tokens, cwd)
  }

  if (tokens[0] === 'ai_tone') {
    return parseAiToneCommand(tokens, cwd)
  }

  if (tokens[0] === 'metrics') {
    return parseMetricsCommand(tokens, cwd)
  }

  const executable = tokens[0]!
  const allowed = cwd === 'repo' ? REPO_READ_COMMANDS : WORKSPACE_COMMANDS
  if (!allowed.has(executable)) {
    return { ok: false, error: `command is not allowed: ${executable}` }
  }

  const args = tokens.slice(1)
  const redirectIndex = args.findIndex((arg) => arg === '>' || arg === '>>')
  if (redirectIndex >= 0) {
    return { ok: false, error: cwd === 'repo' ? 'repo view is read-only' : 'workspace writes require workspace_file' }
  }

  const argError = cwd === 'repo'
    ? validateRepoArgs(executable, args)
    : validateWorkspaceArgs(executable, args)
  if (argError) return { ok: false, error: argError }

  return { ok: true, kind: 'workspace', cwd, command: executable, args }
}

function minimalEnv(): Record<string, string> {
  return { PATH: DEFAULT_PATH }
}

function clamp(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  return value.slice(0, maxChars) + `\n[...truncated at ${maxChars} chars]`
}

function clipCommandField(value: string, maxChars: number): { value: string; truncated: boolean } {
  if (value.length <= maxChars) return { value, truncated: false }
  return { value: value.slice(0, maxChars), truncated: true }
}

function renderCommandEnvelope(
  result: Pick<WorkspaceBashRunResult, 'exitCode' | 'stdout' | 'stderr'>,
  options: { ok: boolean; maxChars: number; format?: 'text' | 'json'; code?: string; error?: string },
): string {
  const content = clipCommandField(result.stdout, options.maxChars)
  const stderr = clipCommandField(result.stderr, options.maxChars)
  return JSON.stringify({
    ok: options.ok,
    exitCode: result.exitCode,
    format: options.format ?? 'text',
    content: content.value,
    stderr: stderr.value,
    truncated: content.truncated || stderr.truncated,
    ...(options.code ? { code: options.code } : {}),
    ...(options.error ? { error: options.error } : {}),
  })
}

function renderHelpCommand(parsed: ParsedHelpCommand): WorkspaceBashRunResult {
  const topics = {
    workspace: {
      purpose: '私有工作区只读查看, cwd 默认就是 workspace; 普通文件修改请激活 workspace_management 后调用 workspace_file.',
      commands: [
        'pwd',
        'ls [path]',
        'rg <pattern> [path]',
        'cat <path>',
        'head <path>',
        'tail <path>',
        'wc <path>',
      ],
    },
    repo: {
      purpose: '只读查看仓库代码和文档, 需要显式传 cwd=repo.',
      commands: [
        'pwd',
        'ls [path]',
        'rg <pattern> [path]',
        'rg --files [path]',
        'cat <path>',
        'head <path>',
        'tail <path>',
        'wc <path>',
      ],
    },
    db: {
      purpose: '只读查询消息账本和可公开 schema.',
      commands: [
        'db schema',
        'db query {"sql":"SELECT 1","params":{}}',
      ],
    },
    style: {
      purpose: '按需读取全局或群风格说明.',
      commands: [
        'style global [constraints|base|anti_patterns|special_cases]',
        'style group <groupId>',
      ],
    },
    openbb: {
      purpose: '通过 OpenBB allowlist 查询金融数据.',
      commands: [
        'openbb <allowed command>',
        'openbb {"command":"<allowed command>","output":{...}}',
      ],
    },
    moomoo: {
      purpose: '通过本机 Moomoo OpenD 和官方 Skill 脚本查询行情与账户数据, 或操作普通证券模拟仓; 实盘和长时间订阅不开放.',
      commands: [
        'moomoo check_env',
        'moomoo quote/get_snapshot US.AAPL HK.00700',
        'moomoo quote/get_kline US.AAPL --ktype K_DAY',
        'moomoo trade/get_portfolio --trd-env SIMULATE',
        'moomoo trade/place_order --code US.AAPL --side BUY --quantity 1 --price 100 --trd-env SIMULATE',
        'moomoo trade/modify_order --order-id 123 --price 101 --trd-env SIMULATE',
        'moomoo trade/cancel_order --order-id 123 --trd-env SIMULATE',
      ],
    },
    fetch: {
      purpose: '获取外部网页、图片、头像或 Reddit 内容.',
      commands: [
        'fetch url <http(s)-url> [hint]',
        'fetch image <http(s)-url>',
        'fetch avatar <qq> [640|100|40]',
        `fetch reddit list ${FETCH_ALLOWED_SUBREDDITS.join('|')} [hot|top|new] [limit]`,
        'fetch reddit post <reddit-post-url>',
      ],
    },
    ai_tone: {
      purpose: '判断中文文本更像 AI 腔调还是人味; 只做参考, 短文本和技术长文可能误判.',
      commands: [
        'ai_tone \'{"text":"要判断的中文文本"}\'',
        'ai_tone \'{"text":"要判断的中文文本","threshold":0.7}\'',
      ],
    },
    metrics: {
      purpose: '按北京时间自然日查询真实 bot 的工具调用、token/cache 和 rest 行为；默认排除 model=mock 测试数据.',
      commands: [
        'metrics',
        'metrics today',
        'metrics yesterday',
        'metrics YYYY-MM-DD',
        'metrics days <1-7>',
      ],
    },
  } as const
  const payload = parsed.topic
    ? { ok: true, topic: parsed.topic, ...topics[parsed.topic] }
    : {
      ok: true,
      topics: Object.keys(topics),
      examples: [
        'help fetch',
        'fetch url https://example.com "要点"',
        'fetch reddit list technology hot 5',
        'db schema',
        'metrics today',
      ],
    }

  return {
    exitCode: 0,
    stdout: JSON.stringify(payload),
    stderr: '',
    timedOut: false,
  }
}

function fetchArgsFromParsed(parsed: ParsedFetchCommand): Record<string, unknown> {
  if (parsed.action === 'url') {
    return parsed.hint === undefined
      ? { action: 'url', url: parsed.url }
      : { action: 'url', url: parsed.url, hint: parsed.hint }
  }
  if (parsed.action === 'image_url') return { action: 'image_url', url: parsed.url }
  if (parsed.action === 'qq_avatar') return { action: 'qq_avatar', qq: parsed.qq, size: parsed.size }
  if (parsed.action === 'reddit_list') {
    return { action: 'reddit_list', subreddit: parsed.subreddit, sort: parsed.sort, limit: parsed.limit }
  }
  return { action: 'reddit_post', url: parsed.url }
}

export async function runCommand(input: WorkspaceBashRunInput): Promise<WorkspaceBashRunResult> {
  return new Promise((resolveResult) => {
    const child = spawn(input.executable, input.args, {
      cwd: input.cwd,
      env: input.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false

    const append = (current: string, chunk: Buffer) => clamp(current + chunk.toString('utf8'), input.maxOutputChars)
    const finish = (result: WorkspaceBashRunResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolveResult(result)
    }

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      setTimeout(() => {
        if (!settled) child.kill('SIGKILL')
      }, 1000).unref()
    }, input.timeoutMs)
    timer.unref()

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = append(stdout, chunk)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = append(stderr, chunk)
    })
    child.on('error', (err) => {
      finish({ exitCode: null, stdout, stderr: stderr || err.message, timedOut })
    })
    child.on('close', (code) => {
      finish({ exitCode: code, stdout, stderr, timedOut })
    })

    if (input.stdin != null) child.stdin?.end(input.stdin)
    else child.stdin?.end()
  })
}

export async function runWorkspaceBashCommand(
  parsed: ParsedWorkspaceCommand | ParsedHelpCommand,
  options: {
    workspaceDir: string
    repoDir: string
    timeoutMs: number
    maxOutputChars: number
    runner?: WorkspaceBashRunner
  },
): Promise<WorkspaceBashRunResult> {
  const runner = options.runner ?? runCommand
  await mkdir(options.workspaceDir, { recursive: true })

  if (parsed.kind === 'help') {
    return renderHelpCommand(parsed)
  }

  const runInput: WorkspaceBashRunInput = {
    executable: parsed.command,
    args: parsed.args,
    cwd: parsed.cwd === 'repo' ? options.repoDir : options.workspaceDir,
    env: minimalEnv(),
    stdin: undefined,
    timeoutMs: options.timeoutMs,
    maxOutputChars: options.maxOutputChars,
  }
  const result = await runner(runInput)

  return result
}

function renderAiToneResult(result: AiTonePrediction): string {
  return JSON.stringify({ ok: true, ...result })
}

function renderMetricsResult(result: unknown, maxChars: number): string {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return JSON.stringify({ ok: true, reports: [], truncated: false })
  }
  const raw = result as Record<string, unknown>
  const reports = Array.isArray(raw.reports)
    ? raw.reports.map((value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return value
      const report = value as Record<string, unknown>
      const tokenUsage = report.tokenUsage && typeof report.tokenUsage === 'object' && !Array.isArray(report.tokenUsage)
        ? (report.tokenUsage as Record<string, unknown>).total
        : undefined
      return {
        date: report.date,
        tokenUsage,
        toolCalls: report.toolCalls,
        rest: report.rest,
      }
    })
    : []
  const payload = {
    ok: true,
    timezone: raw.timezone,
    generatedAt: raw.generatedAt,
    excludedModels: raw.excludedModels,
    reports,
    truncated: false,
  }
  const content = JSON.stringify(payload)
  if (content.length <= maxChars) return content

  return JSON.stringify({
    ...payload,
    reports: reports.map((value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return value
      const report = value as Record<string, unknown>
      const toolCalls = report.toolCalls && typeof report.toolCalls === 'object' && !Array.isArray(report.toolCalls)
        ? report.toolCalls as Record<string, unknown>
        : {}
      return {
        date: report.date,
        tokenUsage: report.tokenUsage,
        rest: report.rest,
        toolCalls: {
          rounds: toolCalls.rounds,
          total: toolCalls.total,
          unresolvedInvokeCalls: toolCalls.unresolvedInvokeCalls,
        },
      }
    }),
    truncated: true,
    hint: '多日结果过长，已省略 byTool；用 metrics YYYY-MM-DD 查询单日工具明细.',
  })
}

function commandErrorGuidance(error: string): { help: string; try: string } {
  if (error.startsWith('fetch ')) {
    return { help: 'help fetch', try: 'fetch reddit list technology hot 5' }
  }
  if (error.startsWith('db ')) {
    return { help: 'help db', try: 'db query {"sql":"SELECT 1"}' }
  }
  if (error.startsWith('style ')) {
    return { help: 'help style', try: 'style global' }
  }
  if (error.startsWith('openbb ')) {
    return { help: 'help openbb', try: 'help openbb' }
  }
  if (error.startsWith('moomoo ')) {
    return { help: 'help moomoo', try: 'moomoo check_env' }
  }
  if (error.startsWith('ai_tone ')) {
    return { help: 'help ai_tone', try: 'help ai_tone' }
  }
  if (error.startsWith('metrics ')) {
    return { help: 'help metrics', try: 'metrics today' }
  }
  if (error.startsWith('repo ')) {
    return { help: 'help repo', try: 'rg --files src' }
  }
  return { help: 'help workspace', try: 'help' }
}

export function createWorkspaceBashTool(deps: WorkspaceBashDeps = {}): Tool<Args> {
  const workspaceDir = resolve(deps.workspaceDir ?? DEFAULT_WORKSPACE_DIR)
  const repoDir = resolve(deps.repoDir ?? process.cwd())
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxOutputChars = deps.maxOutputChars ?? DEFAULT_OUTPUT_CAP_CHARS
  const dbTool = createDbTool({ groupIdWhitelist: deps.groupIdWhitelist, executeRead: deps.executeDbRead })
  const styleTool = createChatStyleTool({
    groupIds: deps.groupIds ?? [],
    metadata: deps.metadata ?? { groupNames: new Map() },
    groupPolicies: deps.groupPolicies ?? [],
  })
  const openbbTool = deps.openbbTool === undefined ? maybeCreateOpenbbCliTool() : deps.openbbTool
  const moomooTool = deps.moomooTool === undefined ? maybeCreateMoomooSkillTool() : deps.moomooTool
  const fetchTool = deps.fetchTool === undefined ? createFetchContentTool() : deps.fetchTool
  const aiTonePredictor = deps.aiTonePredictor ?? predictAiTone
  const loadDailyMetrics = deps.loadDailyMetrics ?? (async (options) => {
    const { loadDailyAgentMetrics } = await import('../../ops/agent-daily-metrics.js')
    return await loadDailyAgentMetrics(options)
  })

  return {
    name: 'workspace_bash',
    description: [
      '受限 Bash. 默认 cwd=workspace, 用来只读查看私有工作文件; 也可 cwd=repo 只读查看自己的仓库代码.',
      'workspace 允许少量只读文件命令: pwd/ls/rg/cat/head/tail/wc; 普通文件写入、替换、删除和移动使用 deferred workspace_file.',
      'repo 只允许读命令: pwd/ls/rg/cat/head/tail/wc; rg 支持普通搜索和 --files, 不能写, 也不能读 .env/logs/node_modules/.git/data/prompts/groups.md.',
      '常用路由不用先 help: 看 repo 传 cwd=repo 后用 `rg --files src` / `rg <pattern> src` / `cat <path>`; 查历史先 `db schema` 再用 `db query {"sql":"SELECT 1","params":{}}`; 查每日工具/token 用 `metrics today|yesterday|YYYY-MM-DD`; 抓网页用 `fetch url <url> [hint]`; 看 reddit 用 `fetch reddit list technology hot 5`.',
      '不确定语法时先用 `help` 或 `help <topic>`; Moomoo 行情、账户查询和证券模拟交易用 `moomoo <allowed command>`, 交易必须显式 SIMULATE; 聊天约束/风格用 `style global constraints|base|anti_patterns|special_cases` 或 `style group`; AI 腔调检测用 `ai_tone <json>`.',
      '数据库仍只读; ai_tone 只走内置模型; 不允许 psql/curl/node/cat .env/路径逃逸/任意 shell 组合.',
    ].join(' '),
    schema: argsSchema,
    async execute(args, ctx) {
      const parsed = parseWorkspaceBashCommand(args.command, args.cwd)
      if (!parsed.ok) {
        const error = `command not allowed: ${parsed.error}`
        return {
          content: JSON.stringify({
            ok: false,
            exitCode: null,
            format: 'text',
            content: '',
            stderr: error,
            truncated: false,
            code: 'command_not_allowed',
            error,
            ...commandErrorGuidance(parsed.error),
          }),
          outcome: { ok: false, code: 'command_not_allowed' },
        }
      }

      if (parsed.kind === 'db_tool') {
        if (parsed.action === 'schema') return await dbTool.execute({ action: 'schema' }, ctx)
        return await dbTool.execute({ action: 'query', sql: parsed.sql!, params: parsed.params }, ctx)
      }

      if (parsed.kind === 'style') {
        if (parsed.scope === 'global') {
          const next = parsed.section ? { scope: 'global' as const, section: parsed.section } : { scope: 'global' as const }
          return await styleTool.execute(next, ctx)
        }
        return await styleTool.execute({ scope: 'group', groupId: parsed.groupId! }, ctx)
      }

      if (parsed.kind === 'openbb') {
        if (!openbbTool) {
          return {
            content: JSON.stringify({ ok: false, code: 'not_configured', error: 'openbb not configured' }),
            outcome: { ok: false, code: 'not_configured' },
          }
        }
        return await openbbTool.execute(
          parsed.output === undefined ? { command: parsed.command } : { command: parsed.command, output: parsed.output },
          ctx,
        )
      }

      if (parsed.kind === 'moomoo') {
        if (!moomooTool) {
          return {
            content: JSON.stringify({ ok: false, code: 'not_configured', error: 'moomoo skill not configured' }),
            outcome: { ok: false, code: 'not_configured' },
          }
        }
        return await moomooTool.execute({ command: parsed.command }, ctx)
      }

      if (parsed.kind === 'fetch') {
        if (!fetchTool) return { content: JSON.stringify({ ok: false, error: 'fetch not configured' }) }
        return await fetchTool.execute(fetchArgsFromParsed(parsed), ctx)
      }

      if (parsed.kind === 'ai_tone') {
        return { content: renderAiToneResult(await aiTonePredictor(parsed.text, parsed.threshold)) }
      }

      if (parsed.kind === 'metrics') {
        try {
          const result = await loadDailyMetrics({
            ...(parsed.date ? { date: parsed.date } : {}),
            ...(parsed.days ? { days: parsed.days } : {}),
            ...(parsed.endOffsetDays != null ? { endOffsetDays: parsed.endOffsetDays } : {}),
          })
          return { content: renderMetricsResult(result, maxOutputChars), outcome: { ok: true } }
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err)
          return {
            content: JSON.stringify({ ok: false, code: 'metrics_failed', error }),
            outcome: { ok: false, code: 'metrics_failed', error },
          }
        }
      }

      const result = await runWorkspaceBashCommand(parsed, {
        workspaceDir,
        repoDir,
        timeoutMs,
        maxOutputChars,
        runner: deps.runner,
      })

      if (result.timedOut) {
        return {
          content: renderCommandEnvelope(result, {
            ok: false,
            maxChars: maxOutputChars,
            code: 'timeout',
            error: 'command timeout',
          }),
          outcome: { ok: false, code: 'timeout' },
        }
      }
      if (result.exitCode !== 0) {
        return {
          content: renderCommandEnvelope(result, { ok: false, maxChars: maxOutputChars }),
          outcome: { ok: false, code: `exit_${result.exitCode ?? 'unknown'}` },
        }
      }

      return {
        content: renderCommandEnvelope(result, {
          ok: true,
          maxChars: maxOutputChars,
          format: parsed.kind === 'workspace' ? 'text' : 'json',
        }),
        outcome: { ok: true },
      }
    },
  }
}
