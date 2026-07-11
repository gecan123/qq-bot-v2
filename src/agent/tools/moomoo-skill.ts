import { spawn } from 'node:child_process'
import { isAbsolute, resolve, sep } from 'node:path'
import { z } from 'zod'
import type { Tool } from '../tool.js'
import { config } from '../../config/index.js'

const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_OUTPUT_CAP_CHARS = 8_000
const RAW_CAPTURE_CAP_BYTES = 64 * 1024
const LOOPBACK_HOST = '127.0.0.1'

const ALLOWED_SCRIPTS = new Map<string, string>([
  ['check_env', 'scripts/check_env.py'],
  ['quote/get_snapshot', 'scripts/quote/get_snapshot.py'],
  ['quote/get_kline', 'scripts/quote/get_kline.py'],
  ['quote/get_orderbook', 'scripts/quote/get_orderbook.py'],
  ['quote/get_ticker', 'scripts/quote/get_ticker.py'],
  ['quote/get_rt_data', 'scripts/quote/get_rt_data.py'],
  ['quote/get_market_state', 'scripts/quote/get_market_state.py'],
  ['quote/get_stock_quote', 'scripts/quote/get_stock_quote.py'],
  ['quote/get_stock_filter', 'scripts/quote/get_stock_filter.py'],
  ['quote/get_plate_list', 'scripts/quote/get_plate_list.py'],
  ['quote/get_plate_stock', 'scripts/quote/get_plate_stock.py'],
  ['quote/get_capital_flow', 'scripts/quote/get_capital_flow.py'],
  ['quote/get_capital_distribution', 'scripts/quote/get_capital_distribution.py'],
  ['trade/get_accounts', 'scripts/trade/get_accounts.py'],
  ['trade/get_portfolio', 'scripts/trade/get_portfolio.py'],
  ['trade/get_orders', 'scripts/trade/get_orders.py'],
  ['trade/get_history_orders', 'scripts/trade/get_history_orders.py'],
  ['trade/get_order_fill_list', 'scripts/trade/get_order_fill_list.py'],
  ['trade/get_history_order_fill_list', 'scripts/trade/get_history_order_fill_list.py'],
  ['trade/place_order', 'scripts/trade/place_order.py'],
  ['trade/modify_order', 'scripts/trade/modify_order.py'],
  ['trade/cancel_order', 'scripts/trade/cancel_order.py'],
])

const SIMULATED_TRADE_SCRIPTS = new Set([
  'trade/place_order',
  'trade/modify_order',
  'trade/cancel_order',
])

export const MOOMOO_ALLOWED_COMMANDS = [...ALLOWED_SCRIPTS.keys()]

export interface MoomooSkillRunOptions {
  pythonBin: string
  skillDir: string
  opendPort: number
  timeoutMs: number
  captureCapBytes: number
}

export interface MoomooSkillRunResult {
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

export type MoomooSkillRunner = (
  script: string,
  args: string[],
  options: MoomooSkillRunOptions,
) => Promise<MoomooSkillRunResult>

export interface MoomooSkillDeps {
  runner?: MoomooSkillRunner
  pythonBin?: string
  skillDir?: string
  opendPort?: number
  timeoutMs?: number
  outputCapChars?: number
}

interface ParsedMoomooCommand {
  script: string
  args: string[]
}

function shellTokens(command: string): string[] | null {
  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let escaped = false

  for (const ch of command.trim()) {
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
      if (current) {
        tokens.push(current)
        current = ''
      }
      continue
    }
    current += ch
  }

  if (quote || escaped) return null
  if (current) tokens.push(current)
  return tokens
}

export function parseMoomooSkillCommand(command: string): ParsedMoomooCommand | null {
  const trimmed = command.trim()
  if (!trimmed || /[\r\n;&<>`|]/.test(trimmed) || trimmed.includes('$(')) return null
  const tokens = shellTokens(trimmed)
  if (!tokens || tokens.length === 0) return null
  const script = tokens[0]!
  if (!ALLOWED_SCRIPTS.has(script)) return null
  const args = tokens.slice(1)
  if (args.some((arg) => arg.includes('\0'))) return null
  if (args.some((arg) => arg === '--confirmed' || arg.startsWith('--confirmed='))) return null
  if (SIMULATED_TRADE_SCRIPTS.has(script)) {
    const trdEnvs = args.flatMap((arg, index) => {
      if (arg === '--trd-env') return args[index + 1] == null ? [] : [args[index + 1]!]
      if (arg.startsWith('--trd-env=')) return [arg.slice('--trd-env='.length)]
      return []
    })
    if (trdEnvs.length !== 1 || trdEnvs[0]!.toUpperCase() !== 'SIMULATE') return null
  }
  return { script, args }
}

export function isAllowedMoomooSkillCommand(command: string): boolean {
  return parseMoomooSkillCommand(command) !== null
}

const argsSchema = z.object({
  command: z
    .string()
    .trim()
    .min(1)
    .max(2_000)
    .refine(isAllowedMoomooSkillCommand, {
      message: `command 必须使用允许的 Moomoo 查询或模拟交易脚本: ${MOOMOO_ALLOWED_COMMANDS.join(', ')}`,
    })
    .describe('Moomoo Skill 内部命令, 如 `quote/get_snapshot US.AAPL HK.00700`. 不接受 Python 代码或脚本路径.'),
})

type Args = z.infer<typeof argsSchema>

function commandEnvelope(input: {
  ok: boolean
  exitCode: number | null
  content: string
  stderr: string
  cap: number
  code?: string
  error?: string
}): string {
  const clip = (value: string) => ({
    value: value.length <= input.cap ? value : value.slice(0, input.cap),
    truncated: value.length > input.cap,
  })
  const content = clip(input.content)
  const stderr = clip(input.stderr)
  return JSON.stringify({
    ok: input.ok,
    exitCode: input.exitCode,
    format: 'text',
    content: content.value,
    stderr: stderr.value,
    truncated: content.truncated || stderr.truncated,
    ...(input.code ? { code: input.code } : {}),
    ...(input.error ? { error: input.error } : {}),
  })
}

export function createMoomooSkillTool(deps: MoomooSkillDeps): Tool<Args> {
  const runner = deps.runner ?? runMoomooSkillCommand
  const pythonBin = deps.pythonBin ?? 'python3'
  const skillDir = deps.skillDir
  if (!skillDir) throw new Error('Moomoo skill directory is required')
  if (!isAbsolute(skillDir)) throw new Error('Moomoo skill directory must be an absolute path')
  const opendPort = deps.opendPort ?? 11_111
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const outputCapChars = deps.outputCapChars ?? DEFAULT_OUTPUT_CAP_CHARS

  return {
    name: 'moomoo_skill',
    description: [
      '通过本机 Moomoo OpenD 和官方 Skill Python 脚本查询行情、账户、订单、资金与持仓, 并操作普通证券模拟仓.',
      '下单、改单、撤单必须显式传 `--trd-env SIMULATE`; REAL、--confirmed、加密货币、组合订单和长时间订阅全部拒绝.',
      '不接受任意 Python 或脚本路径.',
      `OpenD 固定连接 ${LOOPBACK_HOST}:${opendPort}; 输出和执行时间都有上限.`,
      '模拟限价买入示例: `trade/place_order --code US.AAPL --side BUY --quantity 1 --price 100 --trd-env SIMULATE`.',
    ].join(' '),
    schema: argsSchema,
    async execute(rawArgs) {
      const args = argsSchema.parse(rawArgs)
      const parsed = parseMoomooSkillCommand(args.command)!
      const script = ALLOWED_SCRIPTS.get(parsed.script)!
      const scriptArgs = parsed.args.includes('--json') ? parsed.args : [...parsed.args, '--json']
      const result = await runner(script, scriptArgs, {
        pythonBin,
        skillDir,
        opendPort,
        timeoutMs,
        captureCapBytes: RAW_CAPTURE_CAP_BYTES,
      })

      if (result.timedOut) {
        return {
          content: commandEnvelope({
            ok: false,
            exitCode: null,
            content: result.stdout,
            stderr: result.stderr,
            cap: outputCapChars,
            code: 'timeout',
            error: 'Moomoo command timeout',
          }),
          outcome: { ok: false, code: 'timeout' },
        }
      }
      if (result.exitCode !== 0) {
        return {
          content: commandEnvelope({
            ok: false,
            exitCode: result.exitCode,
            content: result.stdout,
            stderr: result.stderr,
            cap: outputCapChars,
          }),
          outcome: { ok: false, code: `exit_${result.exitCode ?? 'unknown'}` },
        }
      }
      return {
        content: commandEnvelope({
          ok: true,
          exitCode: result.exitCode,
          content: result.stdout || result.stderr || '[no output]',
          stderr: result.stderr,
          cap: outputCapChars,
        }),
        outcome: { ok: true },
      }
    },
  }
}

export function maybeCreateMoomooSkillTool(): Tool<Args> | null {
  if (!config.moomoo) return null
  return createMoomooSkillTool(config.moomoo)
}

export async function runMoomooSkillCommand(
  script: string,
  args: string[],
  options: MoomooSkillRunOptions,
): Promise<MoomooSkillRunResult> {
  const skillRoot = resolve(options.skillDir)
  const scriptPath = resolve(skillRoot, script)
  if (!scriptPath.startsWith(`${skillRoot}${sep}`)) {
    return { exitCode: null, stdout: '', stderr: 'Moomoo script path escaped skill directory', timedOut: false }
  }

  return await new Promise((resolveResult) => {
    const child = spawn(options.pythonBin, [scriptPath, ...args], {
      cwd: skillRoot,
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: process.env.HOME ?? '',
        PYTHONUNBUFFERED: '1',
        MOOMOO_OPEND_HOST: LOOPBACK_HOST,
        MOOMOO_OPEND_PORT: String(options.opendPort),
        // The official 0.1.1 moomoo scripts still read the legacy FUTU_* names
        // from common.py, while check_env.py accepts MOOMOO_* first.
        FUTU_OPEND_HOST: LOOPBACK_HOST,
        FUTU_OPEND_PORT: String(options.opendPort),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    let stdoutBytes = 0
    let stderrBytes = 0
    let settled = false
    let timedOut = false
    const append = (current: string, currentBytes: number, chunk: Buffer): [string, number] => {
      if (currentBytes >= options.captureCapBytes) return [current, currentBytes]
      const kept = chunk.subarray(0, options.captureCapBytes - currentBytes)
      return [current + kept.toString('utf8'), currentBytes + kept.length]
    }
    const finish = (result: MoomooSkillRunResult) => {
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
    }, options.timeoutMs)
    timer.unref()

    child.stdout?.on('data', (chunk: Buffer) => {
      ;[stdout, stdoutBytes] = append(stdout, stdoutBytes, chunk)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      ;[stderr, stderrBytes] = append(stderr, stderrBytes, chunk)
    })
    child.on('error', (error) => {
      finish({ exitCode: null, stdout, stderr: stderr || error.message, timedOut })
    })
    child.on('close', (code) => {
      finish({ exitCode: code, stdout: stdout.trim(), stderr: stderr.trim(), timedOut })
    })
  })
}
