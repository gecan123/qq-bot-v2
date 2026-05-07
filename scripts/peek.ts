/**
 * peek: 实时观察 BotAgentContext 在想啥.
 *
 * 读 bot_agent_snapshot 单行表 (LLM 真看到的那份), 格式化 messages 流式打印.
 * 不动 bot 进程, 不影响 prompt cache, 不影响主循环 — bot 挂了也照样能 dump 历史.
 *
 * 用法:
 *   pnpm peek                 # dump 最近 20 条
 *   pnpm peek -n 50           # 改数量
 *   pnpm peek -f              # follow, 每秒 poll, 新增就打印
 *   pnpm peek -f --interval 500  # 调 poll 间隔 (ms)
 *   pnpm peek --no-color      # 关 ANSI 颜色 (pipe 到文件 / grep 时建议关)
 *
 * 自然交互:
 *   - 检测到 compaction (messages.length 变小) 会打印一条标记线再继续.
 *   - Ctrl-C 干净退出.
 */
import { prisma } from '../src/database/client.js'

interface ToolCall {
  id: string
  name: string
  args: Record<string, unknown>
}

interface AssistantMsg {
  role: 'assistant'
  content?: string
  toolCalls?: ToolCall[]
}

interface UserMsg {
  role: 'user'
  content: string
}

interface ToolMsg {
  role: 'tool'
  content: string
  toolCallId?: string
}

type Msg = AssistantMsg | UserMsg | ToolMsg

interface Args {
  count: number
  follow: boolean
  intervalMs: number
  color: boolean
}

function parseArgs(argv: readonly string[]): Args {
  const out: Args = { count: 20, follow: false, intervalMs: 1000, color: process.stdout.isTTY }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '-f' || a === '--follow') out.follow = true
    else if (a === '-n' || a === '--count') out.count = Math.max(1, Number(argv[++i]))
    else if (a === '--interval') out.intervalMs = Math.max(100, Number(argv[++i]))
    else if (a === '--no-color') out.color = false
    else if (a === '--color') out.color = true
    else if (a === '-h' || a === '--help') {
      console.log(USAGE)
      process.exit(0)
    } else {
      console.error(`unknown arg: ${a}\n\n${USAGE}`)
      process.exit(2)
    }
  }
  return out
}

const USAGE = `usage: pnpm peek [-n N] [-f] [--interval MS] [--no-color]

  -n, --count N      显示最近 N 条 (默认 20)
  -f, --follow       follow 模式, 每 ${1000}ms poll 一次
      --interval MS  自定义 poll 间隔
      --no-color     关 ANSI 颜色`

const ANSI = {
  user: '\x1b[34m',
  asst: '\x1b[33m',
  tool: '\x1b[90m',
  toolCall: '\x1b[36m',
  meta: '\x1b[35m',
  reset: '\x1b[0m',
}

function paint(args: Args, color: keyof typeof ANSI, text: string): string {
  if (!args.color) return text
  return `${ANSI[color]}${text}${ANSI.reset}`
}

function clip(s: string, max: number): string {
  if (s.length <= max) return s
  return `${s.slice(0, max)}…(+${s.length - max})`
}

function formatToolArgs(name: string, raw: unknown): string {
  const args = (raw ?? {}) as Record<string, unknown>
  if (name === 'send_message') {
    const t = (args.target ?? {}) as Record<string, unknown>
    const target = t.type === 'group' ? `group:${t.groupId}` : `private:${t.userId}`
    const text = clip(String(args.text ?? ''), 200)
    const reply = args.replyToMessageId ? ` reply=${args.replyToMessageId}` : ''
    return `→ ${target}${reply} text=${JSON.stringify(text)}`
  }
  if (name === 'wait') {
    return args.reason ? `reason=${JSON.stringify(args.reason)}` : ''
  }
  if (name === 'fetch_reddit') {
    const sub = args.subreddit ?? '(home)'
    return `r/${sub} sort=${args.sort ?? 'hot'} limit=${args.limit ?? 10}`
  }
  if (name === 'fetch_url') {
    return `url=${args.url}`
  }
  if (name === 'db_read') {
    return `sql=${JSON.stringify(clip(String(args.sql ?? ''), 200))}`
  }
  if (name === 'db_schema') {
    return ''
  }
  if (name === 'web_search') {
    return `q=${JSON.stringify(clip(String(args.query ?? ''), 120))}`
  }
  return clip(JSON.stringify(args), 200)
}

function formatMessage(args: Args, i: number, m: Msg): string {
  const idx = String(i).padStart(4, ' ')
  if (m.role === 'user') {
    const c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
    return paint(args, 'user', `[${idx}] user`) + ` ${clip(c, 600)}`
  }
  if (m.role === 'assistant') {
    const lines: string[] = []
    const head = paint(args, 'asst', `[${idx}] assistant`)
    const content = String(m.content ?? '')
    if (content.length > 0) {
      lines.push(`${head} ${clip(content, 600)}`)
    } else {
      lines.push(head)
    }
    for (const tc of m.toolCalls ?? []) {
      const argStr = formatToolArgs(tc.name, tc.args)
      const tcLine = `         ${paint(args, 'toolCall', `→ ${tc.name}`)} ${argStr}`
      lines.push(tcLine)
    }
    return lines.join('\n')
  }
  if (m.role === 'tool') {
    const c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
    return paint(args, 'tool', `[${idx}] tool   `) + ` ${clip(c, 600)}`
  }
  return paint(args, 'meta', `[${idx}] ${(m as { role: string }).role}`)
}

async function loadMessages(): Promise<Msg[] | null> {
  const row = await prisma.botAgentSnapshot.findUnique({ where: { id: 1 } })
  if (!row) return null
  const snap = row.contextSnapshot as { messages?: Msg[] }
  return snap.messages ?? []
}

function printRange(args: Args, msgs: Msg[], from: number, to: number): void {
  for (let i = from; i < to; i++) {
    process.stdout.write(formatMessage(args, i, msgs[i]) + '\n')
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  let msgs = await loadMessages()
  if (msgs == null) {
    console.error('no snapshot yet (bot 还没启动过, 或 bot_agent_snapshot 表为空)')
    process.exit(0)
  }
  const start = Math.max(0, msgs.length - args.count)
  printRange(args, msgs, start, msgs.length)
  let lastLen = msgs.length

  if (!args.follow) return

  process.stderr.write(
    paint(args, 'meta', `\n[follow] watching... (Ctrl-C to quit)\n`) ?? '',
  )

  // SIGINT clean exit
  process.on('SIGINT', () => {
    process.stderr.write(paint(args, 'meta', '\n[follow] stopped\n'))
    process.exit(0)
  })

  while (true) {
    await sleep(args.intervalMs)
    const next = await loadMessages()
    if (next == null) continue
    if (next.length > lastLen) {
      printRange(args, next, lastLen, next.length)
    } else if (next.length < lastLen) {
      // compaction rewrote the prefix — re-baseline
      const banner = `\n--- compaction detected: ${lastLen} → ${next.length} messages, re-baseline ---\n`
      process.stdout.write(paint(args, 'meta', banner) + '\n')
      const reStart = Math.max(0, next.length - args.count)
      printRange(args, next, reStart, next.length)
    }
    lastLen = next.length
  }
}

main()
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
  .finally(() => {
    // follow 模式不会到这里 (while true), 一次性模式会自动 disconnect
    if (!process.argv.includes('-f') && !process.argv.includes('--follow')) {
      void prisma.$disconnect()
    }
  })
