import { spawn } from 'node:child_process'
import { mkdir, writeFile, appendFile } from 'node:fs/promises'
import { dirname, isAbsolute, normalize, resolve } from 'node:path'
import { z } from 'zod'
import type { Tool } from '../tool.js'

const DEFAULT_WORKSPACE_DIR = 'data/agent-workspace'
const DEFAULT_TIMEOUT_MS = 5_000
const DB_TIMEOUT_MS = 8_000
const DEFAULT_OUTPUT_CAP_CHARS = 4_000
const DB_OUTPUT_CAP_CHARS = 8_000
const DEFAULT_PATH = process.env.PATH ?? '/usr/bin:/bin'

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
    .describe('受限 Bash 命令. workspace 可操作 data/agent-workspace; repo 可只读查看仓库代码; DB 只通过 pnpm db:query.'),
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

export interface ParsedDbQueryCommand {
  ok: true
  kind: 'db_query'
  cwd: 'workspace' | 'repo'
  args: string[]
}

export type ParsedWorkspaceBashCommand =
  | ParsedWorkspaceCommand
  | ParsedDbQueryCommand
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
  if (normalized === '.env' || normalized.startsWith('.env/')) return false
  return true
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

export function parseWorkspaceBashCommand(
  command: string,
  cwd: 'workspace' | 'repo' = 'workspace',
): ParsedWorkspaceBashCommand {
  const trimmed = command.trim()
  if (!trimmed) return { ok: false, error: 'command is required' }
  if (hasForbiddenShellSyntax(trimmed)) return { ok: false, error: 'shell control syntax is not allowed' }

  const tokens = shellTokens(trimmed)
  if (!tokens || tokens.length === 0) return { ok: false, error: 'could not parse command' }

  if (tokens[0] === 'pnpm') {
    if (tokens[1] !== 'db:query') return { ok: false, error: 'only pnpm db:query is allowed' }
    return { ok: true, kind: 'db_query', cwd, args: tokens.slice(2) }
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
  parsed: ParsedWorkspaceCommand | ParsedDbQueryCommand,
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

  if (parsed.kind === 'db_query') {
    return runner({
      executable: 'pnpm',
      args: ['db:query', ...parsed.args],
      cwd: options.repoDir,
      env: minimalEnv(),
      stdin: undefined,
      timeoutMs: DB_TIMEOUT_MS,
      maxOutputChars: DB_OUTPUT_CAP_CHARS,
    })
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

export function createWorkspaceBashTool(deps: WorkspaceBashDeps = {}): Tool<Args> {
  const workspaceDir = resolve(deps.workspaceDir ?? DEFAULT_WORKSPACE_DIR)
  const repoDir = resolve(deps.repoDir ?? process.cwd())
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxOutputChars = deps.maxOutputChars ?? DEFAULT_OUTPUT_CAP_CHARS

  return {
    name: 'workspace_bash',
    description: [
      '受限 Bash. 默认 cwd=workspace, 用来整理你的私有工作文件、日记、梦、草稿和索引; 也可 cwd=repo 只读查看自己的仓库代码.',
      'workspace 允许少量文件命令: pwd/ls/rg/cat/head/tail/wc/mkdir/touch/printf.',
      'repo 只允许读命令: pwd/ls/rg/cat/head/tail/wc; rg 支持普通搜索和 --files, 不能写, 也不能读 .env/logs/node_modules/.git/data/prompts/groups.yaml.',
      '可以用重定向把 printf 输出写入工作区文件, 例如 `printf "..." > journal/diary/today.md`.',
      '数据库只允许通过 `pnpm db:query` 做只读查询; 不允许 psql/curl/node/cat .env/路径逃逸/任意 shell 组合.',
    ].join(' '),
    schema: argsSchema,
    async execute(args) {
      const parsed = parseWorkspaceBashCommand(args.command, args.cwd)
      if (!parsed.ok) {
        return { content: JSON.stringify({ ok: false, error: `command not allowed: ${parsed.error}` }) }
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
