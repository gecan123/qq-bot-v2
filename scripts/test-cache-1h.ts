/**
 * 测试 cliproxy 是否支持 messages 级别的 1h cache_control。
 *
 * 策略:
 *   1. 构造一个带大 system + 几条 messages 的请求
 *   2. 第一次发送: system 有 1h cache, messages 没有 → 建 cache
 *   3. 第二次发送: 完全相同 → 验证 system cache 命中
 *   4. 第三次发送: messages 最后一块加 1h cache_control → 建 messages cache
 *   5. 第四次发送: 完全相同 → 验证 messages cache 命中
 *   6. 等 6 分钟 (超过 auto-cache 5min TTL)
 *   7. 第五次发送 (无 messages cache): 预期 messages miss
 *   8. 第六次发送 (有 messages cache): 预期 messages hit (1h TTL 兜底)
 *
 * 用法:
 *   pnpm tsx scripts/test-cache-1h.ts
 *   pnpm tsx scripts/test-cache-1h.ts --skip-wait   # 跳过 6 分钟等待 (只测基本功能)
 */
import 'dotenv/config'
import { buildClaudeCodeHeaders } from '../src/agent/claude-code/headers.js'
import { toClaudeSystemBlocks } from '../src/agent/claude-code/request.js'
import { parseClaudeMessageResponse } from '../src/agent/claude-code/sse-parser.js'

const CLIPROXY_URL = process.env.LLM_PROVIDER_CLAUDE_URL
const CLIPROXY_KEY = process.env.LLM_PROVIDER_CLAUDE_API_KEY
const MODEL = process.env.LLM_DEFAULT_MODEL ?? 'claude-sonnet-4-6'

if (!CLIPROXY_URL || !CLIPROXY_KEY) {
  console.error('需要 LLM_PROVIDER_CLAUDE_URL 和 LLM_PROVIDER_CLAUDE_API_KEY')
  process.exit(1)
}

const url = `${CLIPROXY_URL}/messages?beta=true`
const skipWait = process.argv.includes('--skip-wait')

const PADDING = '这是一段用于撑大 token 数的填充文本。'.repeat(200)

const systemPrompt = [
  '你是一个测试用 bot。',
  '以下是填充文本，目的是让 system prompt 有足够 token 触发 cache。',
  PADDING,
].join('\n')

interface CacheResult {
  inputTokens: number
  cacheRead: number
  cacheCreate: number
  uncached: number
  output: string
}

async function sendRequest(
  messages: unknown[],
  label: string,
): Promise<CacheResult> {
  const system = toClaudeSystemBlocks(systemPrompt)

  const body = {
    model: MODEL,
    stream: true,
    max_tokens: 64,
    system,
    messages,
  }

  const headers = buildClaudeCodeHeaders({
    accessToken: CLIPROXY_KEY!,
    timeoutMs: 30_000,
  })

  const start = Date.now()
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  })

  const text = await res.text()
  const elapsed = Date.now() - start

  if (!res.ok) {
    console.error(`[${label}] HTTP ${res.status}: ${text.slice(0, 300)}`)
    process.exit(1)
  }

  const parsed = parseClaudeMessageResponse(text)
  if (!parsed) {
    console.error(`[${label}] 无法解析 SSE 响应`)
    process.exit(1)
  }

  const u = parsed.usage ?? {}
  const cacheRead = u.cache_read_input_tokens ?? 0
  const cacheCreate = u.cache_creation_input_tokens ?? 0
  const inputTokens = (u.input_tokens ?? 0) + cacheRead + cacheCreate
  const uncached = u.input_tokens ?? 0
  const outputText = parsed.content?.map((b) => ('text' in b ? b.text : '')).join('') ?? ''

  console.log(
    `[${label}]  ${elapsed}ms  input=${inputTokens}  cacheRead=${cacheRead}  cacheCreate=${cacheCreate}  uncached=${uncached}  output=${(u.output_tokens ?? 0)}`,
  )

  return { inputTokens, cacheRead, cacheCreate, uncached, output: outputText }
}

function makeMessages(withCacheOnMessages: boolean): unknown[] {
  const userContent: Record<string, unknown>[] = [
    { type: 'text', text: '你好，请说 "pong"。' },
  ]

  if (withCacheOnMessages) {
    userContent[userContent.length - 1] = {
      ...userContent[userContent.length - 1],
      cache_control: { type: 'ephemeral', ttl: '1h' },
    }
  }

  return [
    { role: 'user', content: userContent },
  ]
}

async function sleep(ms: number, label: string): Promise<void> {
  const secs = Math.round(ms / 1000)
  console.log(`\n⏳ 等待 ${secs}s (${label})...`)
  const interval = setInterval(() => {
    const remaining = Math.max(0, Math.round((ms - (Date.now() - start)) / 1000))
    process.stdout.write(`\r  剩余 ${remaining}s   `)
  }, 5_000)
  const start = Date.now()
  await new Promise((r) => setTimeout(r, ms))
  clearInterval(interval)
  process.stdout.write('\r                    \r')
}

async function main(): Promise<void> {
  console.log(`模型: ${MODEL}`)
  console.log(`cliproxy: ${CLIPROXY_URL}`)
  console.log(`skip-wait: ${skipWait}\n`)

  // ── Phase 1: 无 messages cache ──
  console.log('═══ Phase 1: 仅 system 有 1h cache, messages 无 cache_control ═══')

  const msgsNone = makeMessages(false)
  const r1 = await sendRequest(msgsNone, '1a-cold')
  const r2 = await sendRequest(msgsNone, '1b-warm')

  console.log(
    r2.cacheRead > r1.cacheRead
      ? '  ✅ system cache 命中 (auto-cache 生效)'
      : '  ⚠️  system cache 未明显增长',
  )

  // ── Phase 2: messages 加 1h cache ──
  console.log('\n═══ Phase 2: messages 最后一块加 cache_control ttl=1h ═══')

  const msgsWithCache = makeMessages(true)
  const r3 = await sendRequest(msgsWithCache, '2a-cold')
  const r4 = await sendRequest(msgsWithCache, '2b-warm')

  console.log(
    r4.cacheRead > r3.cacheRead
      ? '  ✅ messages 1h cache 命中'
      : '  ⚠️  messages cache 未明显增长',
  )

  if (r3.cacheCreate > 0) {
    console.log(`  ℹ️  2a cacheCreate=${r3.cacheCreate} — 说明 1h cache 被接受并创建`)
  } else {
    console.log('  ⚠️  2a cacheCreate=0 — cliproxy 可能剥离了 1h cache_control')
  }

  // ── Phase 3: 等 6 分钟后对比 ──
  if (skipWait) {
    console.log('\n═══ Phase 3: 跳过 (--skip-wait) ═══')
    console.log('完成。加 --skip-wait 以外再跑一次可测 6 分钟后 cache 存活。')
    return
  }

  await sleep(370_000, '等 6m10s 让 auto-cache 5min TTL 过期')

  console.log('═══ Phase 3a: 6min 后, 无 messages cache_control ═══')
  const r5 = await sendRequest(msgsNone, '3a-no-msg-cache')

  console.log('\n═══ Phase 3b: 6min 后, 有 messages 1h cache_control ═══')
  const r6 = await sendRequest(msgsWithCache, '3b-msg-cache-1h')

  // ── 结论 ──
  console.log('\n═══ 结论 ═══')

  if (r5.uncached > r5.cacheRead) {
    console.log('  ✅ 3a: 无 msg cache → 6min 后 auto-cache 过期, uncached 占大头 (符合预期)')
  } else {
    console.log('  ❓ 3a: 无 msg cache → 6min 后仍有大量 cache hit (auto-cache TTL > 5min?)')
  }

  if (r6.cacheRead > r5.cacheRead) {
    console.log('  ✅ 3b: 有 msg 1h cache → 6min 后 cache 仍在, 证明 1h TTL 生效!')
    console.log('  → 可以安全地在 request.ts 给 messages 加 1h cache breakpoint')
  } else {
    console.log('  ❌ 3b: 有 msg 1h cache → 6min 后 cache 也过期了, 1h TTL 不被 cliproxy 支持')
    console.log('  → 需要排查 cliproxy 是否剥离了 ttl 字段, 或 Anthropic 不支持 messages 级 1h')
  }

  console.log('\n原始数据:')
  for (const [label, r] of [
    ['1a-cold', r1], ['1b-warm', r2],
    ['2a-cold', r3], ['2b-warm', r4],
    ['3a-no-msg-cache', r5], ['3b-msg-cache-1h', r6],
  ] as const) {
    console.log(`  ${label}: input=${r.inputTokens} read=${r.cacheRead} create=${r.cacheCreate} uncached=${r.uncached}`)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
