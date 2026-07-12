import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import type { Tool } from '../tool.js'
import { config } from '../../config/index.js'
import { logFetch } from '../../ops/fetch-log.js'
import { createLogger } from '../../logger.js'
import { formatBeijingIso } from '../../utils/beijing-time.js'

const log = createLogger('TOOL_OPENBB_CLI')

export const OPENBB_CLI_OUTPUT_CAP = 1500
const RAW_CAPTURE_CAP_BYTES = 64 * 1024
const ERROR_SNIPPET_CAP = 500
const ALLOWED_ROOTS = new Set([
  'alternative',
  'commodity',
  'crypto',
  'currency',
  'derivatives',
  'econometrics',
  'economy',
  'equity',
  'etf',
  'fixedincome',
  'forecast',
  'fund',
  'index',
  'news',
  'portfolio',
  'regulators',
  'technical',
])

export interface OpenbbCliRunOptions {
  cliBin: string
  timeoutMs: number
  captureCapBytes: number
}

export interface OpenbbCliRunResult {
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

export type OpenbbCliRunner = (
  command: string,
  options: OpenbbCliRunOptions,
) => Promise<OpenbbCliRunResult>

export interface OpenbbCliDeps {
  runner?: OpenbbCliRunner
  fileReader?: (path: string) => Promise<string>
  cliBin?: string
  timeoutMs?: number
  logPath?: string
  appender?: (path: string, line: string) => Promise<void>
  now?: () => Date
  clockMs?: () => number
}

function clipOutputField(raw: string, cap: number): { value: string; truncated: boolean } {
  if (raw.length <= cap) return { value: raw, truncated: false }
  return { value: raw.slice(0, cap), truncated: true }
}

function commandEnvelope(input: {
  ok: boolean
  exitCode: number | null
  format: 'text' | 'json'
  content: string
  stderr: string
  cap: number
  code?: string
  error?: string
}): string {
  const content = clipOutputField(input.content, input.cap)
  const stderr = clipOutputField(input.stderr, input.cap)
  return JSON.stringify({
    ok: input.ok,
    exitCode: input.exitCode,
    format: input.format,
    content: content.value,
    stderr: stderr.value,
    truncated: content.truncated || stderr.truncated,
    ...(input.code ? { code: input.code } : {}),
    ...(input.error ? { error: input.error } : {}),
  })
}

function extractSavedFilePath(output: string): string | null {
  const matches = [...output.matchAll(/^Saved file:\s+(.+\.(?:json|csv|txt))\s*$/gm)]
  const last = matches.at(-1)?.[1]?.trim()
  return last && last.includes('/OpenBBUserData/exports/') ? last : null
}

function shellTokens(segment: string): string[] | null {
  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let escaped = false

  for (const ch of segment.trim()) {
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

export function isAllowedOpenbbCommand(command: string): boolean {
  const trimmed = command.trim()
  if (trimmed.length === 0) return false
  if (/[\r;&<>`|]/.test(trimmed)) return false
  if (trimmed.includes('$(')) return false

  const lines = trimmed.split('\n').map((line) => line.trim()).filter((line) => line.length > 0)
  for (const line of lines) {
    const tokens = shellTokens(line)
    if (!tokens || tokens.length === 0) return false
    const firstToken = tokens[0]
    const root = firstToken.replace(/^\//, '').split('/')[0]
    if (!root || !ALLOWED_ROOTS.has(root)) return false
    if (!firstToken.startsWith('/') && !/^[A-Za-z][A-Za-z0-9_-]*(\/[A-Za-z0-9_-]+)*$/.test(firstToken)) {
      return false
    }
  }

  return true
}

const argsSchema = z.object({
  command: z
    .string()
    .trim()
    .min(1)
    .max(1000)
    .refine(isAllowedOpenbbCommand, {
      message: 'command 必须是 OpenBB CLI 内部命令, 如 /equity/price/historical --symbol AAPL',
    })
    .describe('要发送给 OpenBB CLI 的内部命令, 如 `/equity/price/historical --symbol AAPL --provider yfinance --export json`.'),
  output: z
    .object({
      rowOffset: z.number().int().min(0).default(0).describe('导出 JSON 是表格时, 从第几行开始返回. 默认 0.'),
      rowLimit: z.number().int().min(1).max(1000).default(50).describe('导出 JSON 是表格时, 最多返回多少行. 默认 50, 最大 1000.'),
      maxChars: z.number().int().min(1000).max(50_000).default(OPENBB_CLI_OUTPUT_CAP).describe('最终 tool result 最大字符数. 默认 1500, 最大 50000.'),
    })
    .optional()
    .describe('输出窗口控制. 大表不要一次全塞进 context, 用 rowOffset/rowLimit 分页读取.'),
})

interface OutputOptions {
  rowOffset: number
  rowLimit: number
  maxChars: number
}

type Args = {
  command: string
  output?: Partial<OutputOptions>
}

function formatExportedContent(path: string, raw: string, output: OutputOptions): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return `[exported ${path}]\n${raw}`
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return JSON.stringify({ exportedFile: path, data: parsed })
  }

  const table = parsed as Record<string, unknown>
  const columns = Object.keys(table)
  const rowKeys = Array.from(new Set(
    columns.flatMap((column) => {
      const values = table[column]
      if (!values || typeof values !== 'object' || Array.isArray(values)) return []
      return Object.keys(values as Record<string, unknown>)
    }),
  )).sort((a, b) => Number(a) - Number(b))

  if (columns.length === 0 || rowKeys.length === 0) {
    return JSON.stringify({ exportedFile: path, data: parsed })
  }

  const selectedKeys = rowKeys.slice(output.rowOffset, output.rowOffset + output.rowLimit)
  const rows = selectedKeys.map((rowKey) => {
    const row: Record<string, unknown> = {}
    for (const column of columns) {
      const values = table[column]
      row[column] = values && typeof values === 'object' && !Array.isArray(values)
        ? (values as Record<string, unknown>)[rowKey]
        : null
    }
    return row
  })

  return JSON.stringify({
    exportedFile: path,
    rows: {
      offset: output.rowOffset,
      limit: output.rowLimit,
      returned: rows.length,
      total: rowKeys.length,
    },
    columns,
    data: rows,
  })
}

export function createOpenbbCliTool(deps: OpenbbCliDeps = {}): Tool<Args> {
  const runner = deps.runner ?? runOpenbbCommand
  const fileReader = deps.fileReader ?? ((path: string) => readFile(path, 'utf8'))
  const cliBin = deps.cliBin ?? config.openbb?.cliBin ?? 'openbb'
  const timeoutMs = deps.timeoutMs ?? config.openbb?.cliTimeoutMs ?? 15_000
  const now = deps.now ?? (() => new Date())
  const clockMs = deps.clockMs ?? (() => Date.now())

  return {
    name: 'openbb_cli',
    description: [
      '通过本机 OpenBB CLI 查股票 / 金融数据.',
      '传一条或多条 OpenBB CLI 内部命令, 例如 `/equity/price/historical --symbol AAPL --provider yfinance --export json`.',
      '想拿到原始数据正文时加 `--export json`; 工具会读取 OpenBB 保存的 JSON 并返回内容.',
      '工具会启动 openbb CLI, 把 command 写入 stdin, 再收集 stdout/stderr. 只做查询, 不要执行 exe/record/退出命令或 shell 命令.',
      `单次输出最多 ${OPENBB_CLI_OUTPUT_CAP} 字符; 需要更多维度就多次调用.`,
      '大表会返回 rows.total 和当前 data 窗口; 要继续看后续行, 用 output.rowOffset/output.rowLimit 分页.',
    ].join(' '),
    schema: argsSchema,
    async execute(rawArgs, ctx) {
      const args = rawArgs as Args
      const outputOptions = argsSchema.shape.output.parse(args.output ?? {}) as OutputOptions
      const startedAt = clockMs()
      const result = await runner(args.command, {
        cliBin,
        timeoutMs,
        captureCapBytes: RAW_CAPTURE_CAP_BYTES,
      })
      const durationMs = Math.max(0, Math.round(clockMs() - startedAt))
      const output = result.stdout || result.stderr
      const status = result.exitCode ?? -1
      const bytes = Buffer.byteLength(output, 'utf8')
      const baseLog = {
        ts: formatBeijingIso(now()),
        source: 'openbb_cli',
        url: args.command,
        status,
        bytes,
        toolCallId: `round-${ctx.roundIndex}`,
        durationMs,
      }

      if (result.timedOut) {
        await logFetch(
          { ...baseLog, errorKind: 'timeout' },
          { path: deps.logPath, appender: deps.appender },
        )
        log.warn({ command: args.command }, 'openbb_cli_timeout')
        return {
          content: commandEnvelope({
            ok: false,
            exitCode: null,
            format: 'text',
            content: result.stdout,
            stderr: result.stderr,
            cap: outputOptions.maxChars,
            code: 'timeout',
            error: 'command timeout',
          }),
          outcome: { ok: false, code: 'timeout' },
        }
      }

      if (result.exitCode !== 0) {
        await logFetch(
          { ...baseLog, errorKind: `exit_${result.exitCode ?? 'unknown'}` },
          { path: deps.logPath, appender: deps.appender },
        )
        return {
          content: commandEnvelope({
            ok: false,
            exitCode: result.exitCode,
            format: 'text',
            content: result.stdout,
            stderr: result.stderr,
            cap: ERROR_SNIPPET_CAP,
          }),
          outcome: { ok: false, code: `exit_${result.exitCode ?? 'unknown'}` },
        }
      }

      await logFetch(baseLog, { path: deps.logPath, appender: deps.appender })

      let content = result.stdout || result.stderr || '[no output]'
      let format: 'text' | 'json' = 'text'
      const savedFilePath = extractSavedFilePath(`${result.stdout}\n${result.stderr}`)
      if (savedFilePath) {
        try {
          const exported = await fileReader(savedFilePath)
          content = formatExportedContent(savedFilePath, exported, outputOptions)
          format = 'json'
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          content = `${content}\n[export read failed: ${message}]`
        }
      }
      return {
        content: commandEnvelope({
          ok: true,
          exitCode: result.exitCode,
          format,
          content,
          stderr: result.stderr,
          cap: outputOptions.maxChars,
        }),
        outcome: { ok: true },
      }
    },
  }
}

export function maybeCreateOpenbbCliTool(): Tool<Args> | null {
  if (!config.openbb) return null
  return createOpenbbCliTool({ cliBin: config.openbb.cliBin, timeoutMs: config.openbb.cliTimeoutMs })
}

export async function runOpenbbCommand(
  command: string,
  options: OpenbbCliRunOptions,
): Promise<OpenbbCliRunResult> {
  return new Promise((resolve) => {
    const cliTokens = shellTokens(options.cliBin)
    if (!cliTokens || cliTokens.length === 0) {
      resolve({
        exitCode: null,
        stdout: '',
        stderr: `invalid OpenBB CLI binary: ${options.cliBin}`,
        timedOut: false,
      })
      return
    }

    const child = spawn(cliTokens[0], cliTokens.slice(1), {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    })

    let stdout = ''
    let stderr = ''
    let stdoutBytes = 0
    let stderrBytes = 0
    let settled = false
    let timedOut = false

    const appendCapped = (current: string, currentBytes: number, chunk: Buffer): [string, number] => {
      if (currentBytes >= options.captureCapBytes) return [current, currentBytes]
      const remaining = options.captureCapBytes - currentBytes
      const kept = chunk.subarray(0, remaining)
      return [current + kept.toString('utf8'), currentBytes + kept.length]
    }

    const finish = (result: OpenbbCliRunResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      setTimeout(() => {
        if (!settled) child.kill('SIGKILL')
      }, 1000).unref()
    }, options.timeoutMs)
    timer.unref()

    child.stdin?.end(command.trim() + '\nquit\n')

    child.stdout?.on('data', (chunk: Buffer) => {
      ;[stdout, stdoutBytes] = appendCapped(stdout, stdoutBytes, chunk)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      ;[stderr, stderrBytes] = appendCapped(stderr, stderrBytes, chunk)
    })
    child.on('error', (err) => {
      finish({
        exitCode: null,
        stdout,
        stderr: stderr || err.message,
        timedOut,
      })
    })
    child.on('close', (code) => {
      finish({
        exitCode: code,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        timedOut,
      })
    })
  })
}
