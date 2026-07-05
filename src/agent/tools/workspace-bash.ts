import { spawn } from 'node:child_process'
import { mkdir, writeFile, appendFile } from 'node:fs/promises'
import { dirname, isAbsolute, normalize, resolve } from 'node:path'
import { z } from 'zod'
import type { Tool } from '../tool.js'
import type { DbReadResult, ExecuteDbReadParams } from '../../database/agent-sql.js'
import type { GroupCustomization } from '../../config/group-prompts.js'
import type { TargetMetadataMaps } from '../resolve-target-meta.js'
import { createDbTool } from './db.js'
import { createChatStyleTool } from './chat-style.js'
import { isAllowedOpenbbCommand, maybeCreateOpenbbCliTool } from './openbb-cli.js'
import { createFetchContentTool } from './fetch-content.js'
import { predictAiTone, type AiTonePrediction, type AiTonePredictor } from './ai-tone.js'
import {
  appendJournalRecord,
  listJournalRecords,
  readJournalRecord,
  searchJournalRecords,
  type JournalKind,
  type JournalRecord,
} from '../journal-store.js'

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
  'mkdir',
  'touch',
  'printf',
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
  'prompts/groups.yaml',
]

const argsSchema = z.object({
  cwd: z
    .enum(['workspace', 'repo'])
    .default('workspace')
    .describe('执行视图. workspace=私有工作区, 可写; repo=仓库代码只读视图, 只能读代码/文档, 不能写.'),
  command: z
    .string()
    .trim()
    .min(1)
    .max(2000)
    .describe('受限 Bash 命令. workspace 可操作 data/agent-workspace; repo 可只读查看仓库代码; 内置 journal/db/style/ai_tone 子命令走专用 wrapper.'),
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
  redirect?: { mode: 'write' | 'append'; path: string }
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

export interface ParsedJournalCommand {
  ok: true
  kind: 'journal'
  cwd: 'workspace'
  action: 'write' | 'list' | 'search' | 'read'
  kindArg?: JournalKind
  content?: string
  query?: string
  id?: string
  limit?: number
}

export interface ParsedHelpCommand {
  ok: true
  kind: 'help'
  cwd: 'workspace'
  topic?: 'workspace' | 'repo' | 'journal' | 'db' | 'style' | 'openbb' | 'fetch' | 'ai_tone'
}

export type ParsedWorkspaceBashCommand =
  | ParsedWorkspaceCommand
  | ParsedDbToolCommand
  | ParsedStyleCommand
  | ParsedOpenbbCommand
  | ParsedFetchCommand
  | ParsedAiToneCommand
  | ParsedJournalCommand
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
  groupCustomizations?: readonly GroupCustomization[]
  openbbTool?: Tool | null
  fetchTool?: Tool | null
  aiTonePredictor?: AiTonePredictor
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

function isProtectedWorkspaceWritePath(value: string): boolean {
  const normalized = normalize(value).replace(/\\/g, '/')
  return normalized === 'journal'
    || normalized.startsWith('journal/')
    || normalized === 'memory'
    || normalized.startsWith('memory/')
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

  if (command === 'printf') return null

  if (command === 'mkdir' || command === 'touch') {
    for (const arg of args) {
      if (!arg.startsWith('-') && isProtectedWorkspaceWritePath(arg)) {
        return `workspace path is managed by a dedicated tool: ${arg}`
      }
    }
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

function parseJournalKind(value: string | undefined): JournalKind | null {
  return value === 'diary' || value === 'dream' ? value : null
}

function parseLimit(value: string | undefined): number | null {
  if (value == null) return null
  if (!/^[1-9]\d*$/.test(value)) return null
  const parsed = Number(value)
  return parsed >= 1 && parsed <= 20 ? parsed : null
}

function parseOptionalKindAndLimit(tokens: string[]): { kindArg?: JournalKind; limit?: number } | { error: string } {
  if (tokens.length > 2) return { error: 'journal command has too many arguments' }
  let kindArg: JournalKind | undefined
  let limit: number | undefined

  for (const token of tokens) {
    const parsedKind = parseJournalKind(token)
    if (parsedKind) {
      if (kindArg) return { error: 'journal kind specified more than once' }
      kindArg = parsedKind
      continue
    }
    const parsedLimit = parseLimit(token)
    if (parsedLimit != null) {
      if (limit != null) return { error: 'journal limit specified more than once' }
      limit = parsedLimit
      continue
    }
    return { error: `invalid journal argument: ${token}` }
  }

  return { ...(kindArg ? { kindArg } : {}), ...(limit != null ? { limit } : {}) }
}

function parseJournalCommand(tokens: string[], cwd: 'workspace' | 'repo'): ParsedJournalCommand | { ok: false; error: string } {
  if (cwd !== 'workspace') return { ok: false, error: 'journal is only available in workspace mode' }
  if (tokens.includes('>') || tokens.includes('>>')) return { ok: false, error: 'journal does not support redirection' }

  const action = tokens[1]
  if (action === 'write') {
    const kindArg = parseJournalKind(tokens[2])
    if (!kindArg) return { ok: false, error: 'journal write requires kind diary or dream' }
    const content = tokens.slice(3).join(' ').trim()
    if (!content) return { ok: false, error: 'journal write requires content' }
    if (content.length > 2000) return { ok: false, error: 'journal content exceeds 2000 chars' }
    return { ok: true, kind: 'journal', cwd: 'workspace', action, kindArg, content }
  }

  if (action === 'list') {
    const parsed = parseOptionalKindAndLimit(tokens.slice(2))
    if ('error' in parsed) return { ok: false, error: parsed.error }
    return { ok: true, kind: 'journal', cwd: 'workspace', action, ...parsed }
  }

  if (action === 'search') {
    const query = tokens[2]?.trim()
    if (!query) return { ok: false, error: 'journal search requires query' }
    if (query.length > 100) return { ok: false, error: 'journal query exceeds 100 chars' }
    const parsed = parseOptionalKindAndLimit(tokens.slice(3))
    if ('error' in parsed) return { ok: false, error: parsed.error }
    return { ok: true, kind: 'journal', cwd: 'workspace', action, query, ...parsed }
  }

  if (action === 'read') {
    const id = tokens[2]?.trim()
    if (!id || tokens.length !== 3) return { ok: false, error: 'journal read requires exactly one id' }
    return { ok: true, kind: 'journal', cwd: 'workspace', action, id }
  }

  return { ok: false, error: 'journal action must be write, list, search, or read' }
}

function parseHelpCommand(tokens: string[], cwd: 'workspace' | 'repo'): ParsedHelpCommand | { ok: false; error: string } {
  if (cwd !== 'workspace') return { ok: false, error: 'help is only available in workspace mode' }
  if (tokens.length > 2) return { ok: false, error: 'help accepts at most one topic' }
  const topic = tokens[1]
  if (topic == null) return { ok: true, kind: 'help', cwd: 'workspace' }
  if (
    topic === 'workspace'
    || topic === 'repo'
    || topic === 'journal'
    || topic === 'db'
    || topic === 'style'
    || topic === 'openbb'
    || topic === 'fetch'
    || topic === 'ai_tone'
  ) {
    return { ok: true, kind: 'help', cwd: 'workspace', topic }
  }
  return { ok: false, error: 'help topic must be workspace, repo, journal, db, style, openbb, fetch, or ai_tone' }
}

function parseDbToolCommand(tokens: string[], cwd: 'workspace' | 'repo'): ParsedDbToolCommand | { ok: false; error: string } {
  if (cwd !== 'workspace') return { ok: false, error: 'db is only available in workspace mode' }
  if (tokens[1] === 'schema' && tokens.length === 2) {
    return { ok: true, kind: 'db_tool', cwd: 'workspace', action: 'schema' }
  }
  if (tokens[1] !== 'query' || tokens.length !== 3) {
    return { ok: false, error: 'db command must be `db schema` or `db query <json>`' }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(tokens[2]!)
  } catch {
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

  if (tokens[0] === 'journal') {
    return parseJournalCommand(tokens, cwd)
  }

  if (tokens[0] === 'db') {
    return parseDbToolCommand(tokens, cwd)
  }

  if (tokens[0] === 'style') {
    return parseStyleCommand(tokens, cwd)
  }

  if (tokens[0] === 'openbb') {
    return parseOpenbbCommand(tokens, cwd)
  }

  if (tokens[0] === 'fetch') {
    return parseFetchCommand(tokens, cwd)
  }

  if (tokens[0] === 'ai_tone') {
    return parseAiToneCommand(tokens, cwd)
  }

  const executable = tokens[0]!
  const allowed = cwd === 'repo' ? REPO_READ_COMMANDS : WORKSPACE_COMMANDS
  if (!allowed.has(executable)) {
    return { ok: false, error: `command is not allowed: ${executable}` }
  }

  let args = tokens.slice(1)
  let redirect: ParsedWorkspaceCommand['redirect']
  const redirectIndex = args.findIndex((arg) => arg === '>' || arg === '>>')
  if (redirectIndex >= 0) {
    if (cwd === 'repo') return { ok: false, error: 'repo view is read-only' }
    const op = args[redirectIndex]
    const target = args[redirectIndex + 1]
    if (!target || args.length !== redirectIndex + 2) {
      return { ok: false, error: 'redirection must be the final operation' }
    }
    if (!isSafeRelativePath(target)) return { ok: false, error: `redirect path is not allowed: ${target}` }
    if (isProtectedWorkspaceWritePath(target)) {
      return { ok: false, error: `workspace path is managed by a dedicated tool: ${target}` }
    }
    redirect = { mode: op === '>>' ? 'append' : 'write', path: target }
    args = args.slice(0, redirectIndex)
  }

  const argError = cwd === 'repo'
    ? validateRepoArgs(executable, args)
    : validateWorkspaceArgs(executable, args)
  if (argError) return { ok: false, error: argError }

  return { ok: true, kind: 'workspace', cwd, command: executable, args, ...(redirect ? { redirect } : {}) }
}

function minimalEnv(): Record<string, string> {
  return { PATH: DEFAULT_PATH }
}

function clamp(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  return value.slice(0, maxChars) + `\n[...truncated at ${maxChars} chars]`
}

function safeResolve(workspaceDir: string, target: string): string {
  const root = resolve(workspaceDir)
  const resolved = resolve(root, target)
  if (resolved !== root && !resolved.startsWith(`${root}/`)) {
    throw new Error(`path escapes workspace: ${target}`)
  }
  return resolved
}

function boundedJournalLimit(limit: number | undefined): number {
  return limit == null ? 10 : Math.min(limit, 20)
}

function journalPreview(content: string): string {
  return content.length <= 200 ? content : `${content.slice(0, 200)}…`
}

function renderJournalEntries(entries: JournalRecord[]) {
  return entries.map((entry) => ({
    id: entry.id,
    kind: entry.kind,
    createdAt: entry.createdAt,
    preview: journalPreview(entry.content),
  }))
}

function renderHelpCommand(parsed: ParsedHelpCommand): WorkspaceBashRunResult {
  const topics = {
    workspace: {
      purpose: '私有工作区文件整理, cwd 默认就是 workspace.',
      commands: [
        'pwd',
        'ls [path]',
        'rg <pattern> [path]',
        'cat <path>',
        'head <path>',
        'tail <path>',
        'wc <path>',
        'mkdir <path>',
        'touch <path>',
        'printf <text> > <path>',
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
    journal: {
      purpose: '写入和回顾日记/梦境, 存在 private workspace 的按月 Markdown 文件中; 写入必须走 journal 子命令.',
      commands: [
        'journal write diary|dream <content>',
        'journal list [diary|dream] [limit]',
        'journal search <query> [diary|dream] [limit]',
        'journal read <id>',
      ],
    },
    db: {
      purpose: '只读查询消息账本和可公开 schema.',
      commands: [
        'db schema',
        'db query <json>',
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
  } as const
  const payload = parsed.topic
    ? { ok: true, topic: parsed.topic, ...topics[parsed.topic] }
    : {
      ok: true,
      topics: Object.keys(topics),
      examples: [
        'help journal',
        'help fetch',
        'journal list 5',
        'fetch url https://example.com "要点"',
        'fetch reddit list technology hot 5',
        'db schema',
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

async function runJournalCommand(parsed: ParsedJournalCommand, rootDir: string): Promise<WorkspaceBashRunResult> {
  if (parsed.action === 'write') {
    const entry = await appendJournalRecord(
      { rootDir },
      { kind: parsed.kindArg!, content: parsed.content! },
    )
    return {
      exitCode: 0,
      stdout: JSON.stringify({ ok: true, id: entry.id, kind: entry.kind }),
      stderr: '',
      timedOut: false,
    }
  }

  if (parsed.action === 'list') {
    const result = await listJournalRecords(
      { rootDir },
      { kind: parsed.kindArg, limit: boundedJournalLimit(parsed.limit) },
    )
    return {
      exitCode: 0,
      stdout: JSON.stringify({
        ok: true,
        action: 'list',
        entries: renderJournalEntries(result.entries),
        skippedCorrupt: result.skippedCorrupt,
      }),
      stderr: '',
      timedOut: false,
    }
  }

  if (parsed.action === 'search') {
    const result = await searchJournalRecords(
      { rootDir },
      { query: parsed.query!, kind: parsed.kindArg, limit: boundedJournalLimit(parsed.limit) },
    )
    return {
      exitCode: 0,
      stdout: JSON.stringify({
        ok: true,
        action: 'search',
        query: parsed.query,
        entries: renderJournalEntries(result.entries),
        skippedCorrupt: result.skippedCorrupt,
      }),
      stderr: '',
      timedOut: false,
    }
  }

  const result = await readJournalRecord({ rootDir }, parsed.id!)
  if (!result.entry) {
    return {
      exitCode: 0,
      stdout: JSON.stringify({
        ok: false,
        action: 'read',
        id: parsed.id,
        error: 'journal entry not found',
      }),
      stderr: '',
      timedOut: false,
    }
  }
  return {
    exitCode: 0,
    stdout: JSON.stringify({
      ok: true,
      action: 'read',
      entry: result.entry,
      skippedCorrupt: result.skippedCorrupt,
    }),
    stderr: '',
    timedOut: false,
  }
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
  parsed: ParsedWorkspaceCommand | ParsedJournalCommand | ParsedHelpCommand,
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

  if (parsed.kind === 'journal') {
    return await runJournalCommand(parsed, options.workspaceDir)
  }

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

  if (parsed.redirect && parsed.cwd === 'workspace' && result.exitCode === 0 && !result.timedOut) {
    const target = safeResolve(options.workspaceDir, parsed.redirect.path)
    await mkdir(dirname(target), { recursive: true })
    if (parsed.redirect.mode === 'append') await appendFile(target, result.stdout, 'utf8')
    else await writeFile(target, result.stdout, 'utf8')
    return { ...result, stdout: '' }
  }

  return result
}

function renderAiToneResult(result: AiTonePrediction): string {
  return JSON.stringify({ ok: true, ...result })
}

function commandErrorGuidance(error: string): { help: string; try: string } {
  if (error.startsWith('fetch ')) {
    return { help: 'help fetch', try: 'fetch reddit list technology hot 5' }
  }
  if (error.startsWith('db ')) {
    return { help: 'help db', try: 'db schema' }
  }
  if (error.startsWith('journal ')) {
    return { help: 'help journal', try: 'journal list 5' }
  }
  if (error.startsWith('style ')) {
    return { help: 'help style', try: 'style global' }
  }
  if (error.startsWith('openbb ')) {
    return { help: 'help openbb', try: 'help openbb' }
  }
  if (error.startsWith('ai_tone ')) {
    return { help: 'help ai_tone', try: 'help ai_tone' }
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
    groupCustomizations: deps.groupCustomizations ?? [],
  })
  const openbbTool = deps.openbbTool === undefined ? maybeCreateOpenbbCliTool() : deps.openbbTool
  const fetchTool = deps.fetchTool === undefined ? createFetchContentTool() : deps.fetchTool
  const aiTonePredictor = deps.aiTonePredictor ?? predictAiTone

  return {
    name: 'workspace_bash',
    description: [
      '受限 Bash. 默认 cwd=workspace, 用来整理你的私有工作文件、日记、梦、草稿和索引; 也可 cwd=repo 只读查看自己的仓库代码.',
      'workspace 允许少量文件命令: pwd/ls/rg/cat/head/tail/wc/mkdir/touch/printf; 还提供内置子命令: help、journal、db、style、ai_tone.',
      'repo 只允许读命令: pwd/ls/rg/cat/head/tail/wc; rg 支持普通搜索和 --files, 不能写, 也不能读 .env/logs/node_modules/.git/data/prompts/groups.yaml.',
      '可以用重定向把 printf 输出写入工作区文件, 例如 `printf "..." > notes/today.md`.',
      '常用路由不用先 help: 看 repo 传 cwd=repo 后用 `rg --files src` / `rg <pattern> src` / `cat <path>`; 查历史先 `db schema` 再 `db query <json>`; 日记/梦境用 `journal write|list|search|read`; 抓网页用 `fetch url <url> [hint]`; 看 reddit 用 `fetch reddit list technology hot 5`.',
      '不确定语法时先用 `help` 或 `help <topic>`; 聊天约束/风格用 `style global constraints|base|anti_patterns|special_cases` 或 `style group`; AI 腔调检测用 `ai_tone <json>`.',
      '数据库仍只读; ai_tone 只走内置模型; 不允许 psql/curl/node/cat .env/路径逃逸/任意 shell 组合.',
    ].join(' '),
    schema: argsSchema,
    async execute(args, ctx) {
      const parsed = parseWorkspaceBashCommand(args.command, args.cwd)
      if (!parsed.ok) {
        return {
          content: JSON.stringify({
            ok: false,
            error: `command not allowed: ${parsed.error}`,
            ...commandErrorGuidance(parsed.error),
          }),
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
        if (!openbbTool) return { content: JSON.stringify({ ok: false, error: 'openbb not configured' }) }
        return await openbbTool.execute(
          parsed.output === undefined ? { command: parsed.command } : { command: parsed.command, output: parsed.output },
          ctx,
        )
      }

      if (parsed.kind === 'fetch') {
        if (!fetchTool) return { content: JSON.stringify({ ok: false, error: 'fetch not configured' }) }
        return await fetchTool.execute(fetchArgsFromParsed(parsed), ctx)
      }

      if (parsed.kind === 'ai_tone') {
        return { content: renderAiToneResult(await aiTonePredictor(parsed.text, parsed.threshold)) }
      }

      const result = await runWorkspaceBashCommand(parsed, {
        workspaceDir,
        repoDir,
        timeoutMs,
        maxOutputChars,
        runner: deps.runner,
      })

      if (result.timedOut) return { content: JSON.stringify({ ok: false, error: 'command timeout' }) }
      if (result.exitCode !== 0) {
        return {
          content: JSON.stringify({
            ok: false,
            exitCode: result.exitCode,
            stderr: clamp(result.stderr, maxOutputChars),
            stdout: clamp(result.stdout, maxOutputChars),
          }),
        }
      }

      return { content: result.stdout || result.stderr || JSON.stringify({ ok: true }) }
    },
  }
}
