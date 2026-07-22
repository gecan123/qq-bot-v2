import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { isAbsolute, normalize, resolve } from 'node:path'
import { z } from 'zod'
import type { Tool } from '../tool.js'

const DEFAULT_WORKSPACE_DIR = 'data/agent-workspace'
const DEFAULT_TIMEOUT_MS = 5_000
const DEFAULT_OUTPUT_CAP_CHARS = 4_000
const DEFAULT_PATH = process.env.PATH ?? '/usr/bin:/bin'

const READ_COMMANDS = new Set(['pwd', 'ls', 'rg', 'cat', 'head', 'tail', 'wc'])
const RG_FLAGS = new Set([
  '--files', '-n', '--line-number', '-i', '--ignore-case', '-S', '--smart-case', '-F', '--fixed-strings',
])
const LS_FLAGS = new Set(['-l', '-a', '-la', '-al', '-1'])
const WC_FLAGS = new Set(['-l', '-w', '-c', '-m'])
const REPO_BLOCKED_PATH_PREFIXES = [
  '.env', '.git', 'data', 'logs', 'node_modules', 'prompts/groups.md',
]

const argsSchema = z.object({
  cwd: z
    .enum(['workspace', 'repo'])
    .default('workspace')
    .describe('读取视图. workspace=私有工作区; repo=仓库代码和公开文档.'),
  command: z
    .string()
    .trim()
    .min(1)
    .max(2_000)
    .describe('受限只读命令: pwd/ls/rg/cat/head/tail/wc. 不经过 shell.'),
})

type Args = z.infer<typeof argsSchema>

export interface ParsedWorkspaceCommand {
  ok: true
  cwd: 'workspace' | 'repo'
  command: string
  args: string[]
}

export type ParsedWorkspaceBashCommand = ParsedWorkspaceCommand | { ok: false; error: string }

export interface WorkspaceBashRunInput {
  executable: string
  args: string[]
  cwd: string
  env: Record<string, string>
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

export function parseWorkspaceBashCommand(
  command: string,
  cwd: 'workspace' | 'repo' = 'workspace',
): ParsedWorkspaceBashCommand {
  const trimmed = command.trim()
  if (!trimmed) return { ok: false, error: 'command is required' }
  if (/\r|\n|[;&|`<>]/.test(trimmed) || trimmed.includes('$(')) {
    return { ok: false, error: 'shell control syntax is not allowed' }
  }

  const tokens = shellTokens(trimmed)
  if (!tokens || tokens.length === 0) return { ok: false, error: 'could not parse command' }
  const executable = tokens[0]!
  if (!READ_COMMANDS.has(executable)) {
    return { ok: false, error: `command is not allowed: ${executable}` }
  }

  const args = tokens.slice(1)
  const argumentError = validateArguments(executable, args, cwd)
  if (argumentError) return { ok: false, error: argumentError }
  return { ok: true, cwd, command: executable, args }
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
      if (current) tokens.push(current)
      current = ''
      continue
    }
    current += ch
  }
  if (quote || escaped) return null
  if (current) tokens.push(current)
  return tokens
}

function validateArguments(
  command: string,
  args: readonly string[],
  cwd: 'workspace' | 'repo',
): string | null {
  if (command === 'pwd') return args.length === 0 ? null : 'pwd does not accept arguments'

  if (command === 'rg') {
    for (const arg of args) {
      if (arg.startsWith('-') && !RG_FLAGS.has(arg)) return `rg option is not allowed: ${arg}`
    }
  } else if (command === 'ls') {
    for (const arg of args) {
      if (arg.startsWith('-') && !LS_FLAGS.has(arg)) return `ls option is not allowed: ${arg}`
    }
  } else if (command === 'head' || command === 'tail') {
    const optionError = validateHeadTailOptions(args)
    if (optionError) return optionError
  } else if (command === 'wc') {
    for (const arg of args) {
      if (arg.startsWith('-') && !WC_FLAGS.has(arg)) return `wc option is not allowed: ${arg}`
    }
  } else if (args.some((arg) => arg.startsWith('-'))) {
    return `${command} options are not allowed`
  }

  for (const arg of pathArguments(command, args)) {
    if (!isSafeRelativePath(arg)) return `path is not allowed: ${arg}`
    if (cwd === 'repo' && !isSafeRepoPath(arg)) return `repo path is not allowed: ${arg}`
  }
  return null
}

function validateHeadTailOptions(args: readonly string[]): string | null {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (/^-\d+$/.test(arg)) continue
    if (arg === '-n') {
      if (!/^\d+$/.test(args[index + 1] ?? '')) return '-n requires a non-negative integer'
      index++
      continue
    }
    if (arg.startsWith('-')) return `option is not allowed: ${arg}`
  }
  return null
}

function pathArguments(command: string, args: readonly string[]): string[] {
  if (command === 'rg') {
    const positional = args.filter((arg) => !arg.startsWith('-'))
    return args.includes('--files') ? positional : positional.slice(1)
  }
  if (command === 'head' || command === 'tail') {
    const paths: string[] = []
    for (let index = 0; index < args.length; index++) {
      const arg = args[index]!
      if (arg === '-n') {
        index++
        continue
      }
      if (!arg.startsWith('-')) paths.push(arg)
    }
    return paths
  }
  return args.filter((arg) => !arg.startsWith('-'))
}

function isSafeRelativePath(value: string): boolean {
  if (!value || isAbsolute(value) || value.startsWith('~')) return false
  const normalized = normalize(value).replace(/\\/g, '/')
  if (normalized === '..' || normalized.startsWith('../')) return false
  return !normalized.split('/').some((segment) => segment === '.env' || segment.startsWith('.env.'))
}

function isSafeRepoPath(value: string): boolean {
  const normalized = normalize(value).replace(/\\/g, '/')
  return !REPO_BLOCKED_PATH_PREFIXES.some(
    (prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`),
  )
}

export async function runCommand(input: WorkspaceBashRunInput): Promise<WorkspaceBashRunResult> {
  return await new Promise((resolveResult) => {
    const child = spawn(input.executable, input.args, {
      cwd: input.cwd,
      env: input.env,
      stdio: ['ignore', 'pipe', 'pipe'],
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
      }, 1_000).unref()
    }, input.timeoutMs)
    timer.unref()
    child.stdout?.on('data', (chunk: Buffer) => { stdout = append(stdout, chunk) })
    child.stderr?.on('data', (chunk: Buffer) => { stderr = append(stderr, chunk) })
    child.on('error', (error) => finish({ exitCode: null, stdout, stderr: stderr || error.message, timedOut }))
    child.on('close', (exitCode) => finish({ exitCode, stdout, stderr, timedOut }))
  })
}

function clamp(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}\n[...truncated at ${maxChars} chars]`
}

export function createWorkspaceBashTool(deps: WorkspaceBashDeps = {}): Tool<Args> {
  const workspaceDir = resolve(deps.workspaceDir ?? DEFAULT_WORKSPACE_DIR)
  const repoDir = resolve(deps.repoDir ?? process.cwd())
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxOutputChars = deps.maxOutputChars ?? DEFAULT_OUTPUT_CAP_CHARS
  const runner = deps.runner ?? runCommand

  return {
    name: 'workspace_bash',
    description: [
      '受限只读检索工具. cwd=workspace 查看私有工作文件; cwd=repo 查看仓库源码和公开文档.',
      '只允许 pwd/ls/rg/cat/head/tail/wc，直接 spawn 固定 executable，不经过 shell.',
      'repo 禁止读取 .env、.git、data、logs、node_modules 和 prompts/groups.md.',
      '文件修改使用 workspace_file；数据库、指标和仓库维护交给 operator，外部内容、聊天风格和金融使用各自 typed tool.',
    ].join(' '),
    schema: argsSchema,
    async execute(args) {
      const parsed = parseWorkspaceBashCommand(args.command, args.cwd)
      if (!parsed.ok) {
        const error = `command not allowed: ${parsed.error}`
        return {
          content: JSON.stringify({ ok: false, code: 'command_not_allowed', error }),
          outcome: { ok: false, code: 'command_not_allowed', error, progress: false },
        }
      }
      await mkdir(workspaceDir, { recursive: true })
      const result = await runner({
        executable: parsed.command,
        args: parsed.args,
        cwd: parsed.cwd === 'repo' ? repoDir : workspaceDir,
        env: { PATH: DEFAULT_PATH },
        timeoutMs,
        maxOutputChars,
      })
      const ok = !result.timedOut && result.exitCode === 0
      return {
        content: JSON.stringify({
          ok,
          exitCode: result.exitCode,
          content: result.stdout,
          stderr: result.stderr,
          truncated: result.stdout.includes('[...truncated at ')
            || result.stderr.includes('[...truncated at '),
          ...(result.timedOut ? { code: 'timeout', error: 'command timed out' } : {}),
        }),
        outcome: {
          ok,
          code: result.timedOut ? 'timeout' : ok ? 'completed' : 'command_failed',
          progress: ok,
        },
      }
    },
  }
}
