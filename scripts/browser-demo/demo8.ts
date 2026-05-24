/**
 * demo 6: 累积 history + 每步注入战略提示 (永续上下文 + 全局观强化)
 *
 * 跟 demo 4 v3 / demo 5 区别:
 *   - 像 demo 4 一样累积 conversation (保留长期记忆, prefix cache 友好)
 *   - 每步 user content 头部 inject 字节稳定的"战略提示"文本块, 反复强化全局观
 *   - 战略提示字节恒定 → 不破坏 prefix cache (cliproxy 当前 strip cache 看不出收益, 但架构是 prod-ready)
 *
 * 假设: 对抗后期 dense board 的注意力衰减 / reason 错乱, 用 in-context 反复 reminder
 *
 * 用法: pnpm tsx scripts/browser-demo/demo8.ts
 */

import 'dotenv/config'
import { chromium, type Page } from 'playwright'
import sharp from 'sharp'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  buildClaudeCodeHeaders,
  CLAUDE_CODE_BILLING_HEADER,
  CLAUDE_CODE_SDK_PROMPT,
} from '../../src/agent/claude-code/headers.js'
import { parseClaudeMessageResponse } from '../../src/agent/claude-code/sse-parser.js'

const BASE_URL = process.env.LLM_PROVIDER_CLAUDE_URL ?? 'http://127.0.0.1:8317/v1'
const API_KEY = process.env.LLM_PROVIDER_CLAUDE_API_KEY ?? 'sk-local'
const MODEL = 'claude-opus-4-7'
const SHOT_DIR = 'scripts/browser-demo/screenshots/demo8'
const MAX_STEPS = 500
const THINKING_BUDGET = 16000
const MAX_TOKENS = 20000

const SYSTEM_PROMPT = `你在玩 2048 游戏。根据历史截图判断当前 4x4 棋盘，输出下一步方向。

你必须还原最新棋盘，坐标为 r1c1 到 r4c4，空格为 0。对比最新图和上一张图：
- 如果棋盘完全相同，说明上次方向无效，本轮不要重复该方向。
- 推演后棋盘不变的方向也是无效方向。

═══════════════════════════════════════════
绝对底线 — 死亡是不可接受的失败
═══════════════════════════════════════════

死局 = 棋盘塞满 16 格 + 任意相邻两格都无法合并 = 游戏结束 = **之前所有努力归零**。

死亡的代价：
- 你之前合的所有 4 / 8 / 16 / 32 / 64 / 128 / 256 全部作废。
- 之前的 100+ 步推理 / 数十次合并链规划 / 所有 thinking 全部白费。
- 你不会得到任何 partial credit。死亡就是从 0 开始。

激励结构 (你必须内化)：
- 合大数字 = 奖励。合到 1024 / 2048 / 4096 = 大奖励。
- 死亡 = **绝对禁止**。死亡的负面价值 >> 任何合并的正面价值。
- 哪怕你能再合一个 256, 但代价是 3 步内死亡 — 不合, 选别的。
- 哪怕这一步丑陋无收益、破坏漂亮蛇形, 只要它让你**继续活着 + 保留更多空格**, 就是对的。

绝不为以下任何理由选择会让你 1-3 步内死亡的方向：
- ❌ "这步能合一个大数字" — 不行, 合了之后死还是死。
- ❌ "这步能守住右下角的 256" — 不行, 守着 256 死了 256 也归零。
- ❌ "这步维持完美蛇形单调链" — 不行, 漂亮的死局还是死局。
- ❌ "其他方向看起来比较丑" — 不行, 丑活胜过帅死。

═══════════════════════════════════════════
两层目标 — 顺序绝不能颠倒
═══════════════════════════════════════════

第一层 (绝对) — 活下去：
- 死局 = 之前所有合并归零。任何会让你 1-3 步内死亡的方向都不能选。
- "活下去才能凑更大的数。" 没活下去之前, 凑大数没意义。

第二层 (在不死前提下) — 凑大数：
- 长期目标合 1024 / 2048 / 4096, 不是单步合 4+4=8。
- "在不妨碍活着的时候, 才能考虑凑更大的数。"
- 主战角落 + 蛇形单调梯度是凑大数的**手段**, 不是绝对原则。手段服从"活着 + 继续凑"。

═══════════════════════════════════════════
棋盘判读 — 每步先看空格数
═══════════════════════════════════════════

- 空格 ≥ 5: 宽松, 优先守角落 / 守梯度 / 凑大合并。
- 空格 3-4: 中等, 平衡守梯度和救场, 偏向能保持空格的方向。
- 空格 ≤ 2: **紧张, 优先生存**。可以临时破坏角落 / 蛇形换空格。
- 空格 0-1: **危险, 唯一目标不死**。其他全部放下, 选能制造空格 / 触发合并的任何方向。

═══════════════════════════════════════════
具体决策顺序
═══════════════════════════════════════════

1. 排除会让你 1-3 步内死亡的所有方向 (推演后空格 ≤ 1 且无相邻同值 = 接近死局)。
2. 排除当前确认无效的方向 (棋盘不变 / 之前确认过无效)。
3. 剩下的方向里, **在不死的前提下**, 选最有合并价值 / 维持梯度的方向。
4. 如果只剩一个合法方向, 不管它多难看也选它 — 活着比维持梯度重要 100 倍。

═══════════════════════════════════════════
关键技能 — 激进救场 (避免死亡的真正方法)
═══════════════════════════════════════════

"避免死亡" ≠ "保守缩在角落小心翼翼"。真正的避免死亡是：在棋盘紧张时**主动重组**, 做大动作拯救局面。

激进救场的标准动作模式 (2048 高手玩法)：
- **right → left 拉回**：先 right 把所有数字推右侧腾出整个左侧, 下一步 left 让大数字拉回左下角, 同时多列触发合并
- **up → down 拉回**：先 up 把数字往上集中, 下一步 down 拉回, 触发列内连锁
- **反向操作 + 立即拉回** = 多列同时合并 + 空格爆发 (从 1 个空格瞬间变成 4-6 个)

这种激进操作会**暂时**让最大数字离开角落, 但下一步立刻拉回来, **不是丢角, 是高级救场**。

判断激进救场是否正确, 看 2-3 步序列的最终结果, 不只看当前一步：
- ✅ "right 让 256 离角, 但下一步 left 能拉回, 同时 c2/c3 多重合并产生 4 个空格" = 正确激进救场
- ❌ "right 让 256 离角, 接下来无法拉回, 局面更糟" = 错误激进

棋盘紧张时绝不能做的事：
- ❌ **害怕任何大动作**, 只敢 down/left 微调 → 微调到死还是死
- ❌ 还在算"这步合 2+2 收益不大" → 紧张时需要大动作不是小算账
- ❌ 拒绝所有让大数字暂时离角的方向 → 灵活拉回才是正解
- ❌ 把"保守"误当成"避免死亡" → 保守往往就是慢性自杀

重要例外 — 当棋盘紧张时 (空格 ≤ 3)：
- **主动重组**：角落 / 梯度 / 蛇形都可以临时打破, 只要换更多空格 + 更多未来合并机会。
- 完美单调但无空格无合并 = 必死。**宁可破链救场, 也绝不被"漂亮结构"卡死**。
- 小合并不是永远差：2+2 或 4+4 如果能打开关键空间, 价值大于守一条不能再合的蛇形链。
- 主方向 (down/right 等) 无效时, **立刻换能改善局面的方向**, 不要执着。

"丑活胜过帅死" + "敢于激进重组才是真活"。死亡的反面是**行动**, 不是保守。

两步思考：
- 不只看这一步合并多少, 还要看移动后下一步是否更接近死局 / 还能不能继续合并。
- 好方向通常让相同数字靠近、大数字链有延续空间、**空格集中而不是碎裂**。

═══════════════════════════════════════════
输出格式
═══════════════════════════════════════════

最终只输出一行 JSON：
{"direction": "up", "reason": "一句中文理由, 必须明确说明: (a) 当前空格数; (b) 是否有方向 1-3 步内致死已排除; (c) 选这个方向的具体收益。例如: '空格剩 3 个, up/right 会让 256 旁的小数堵死, 选 down 让 r3c2 r4c2 双 8 合 16 紧贴 256'"}

direction 必须是 "up" / "down" / "left" / "right" 之一。`

// 每步注入到 user content 头部的战略提示, 字节恒定不变 → prefix cache 友好
const STRATEGY_REMINDER = `[每步必读 — 死亡禁止 + 激进救场]

⚠️ 死局 = 棋盘满 + 无相邻同值 = **之前所有努力归零**。
⚠️ 但**保守也是慢性自杀**: 害怕大动作 / 只敢微调 / 拒绝让大数离角 = 最终被自己卡死。

死亡的反面**不是保守**, 是**敢于行动**。

每步必须按顺序问 4 件事 — 顺序不能颠倒：

1. **会死吗?** 推演这步后空格 ≤ 1 且无相邻同值 = 接近死亡。排除致死方向。
2. **棋盘紧张吗 (空格 ≤ 3)?** 紧张就该**激进救场**, 不是小算账。
3. **激进救场怎么做?** right → left 拉回 / up → down 拉回。暂时让大数离角, 下一步立刻拉回, 换多列连环合并 + 空格爆发。**这不是丢角, 是 2048 高手玩法**。
4. **不紧张时 (空格 ≥ 4), 凑大数**: 长期目标 1024 / 2048 / 4096。守角落 + 维持蛇形梯度。

激励 vs 惩罚 — 三类结果不对等：
- ✅ 敢做激进重组 + 多列连环合并 + 大数升级 = **最高分**
- ⚠️ 保守微调 / 慢性磨耗 / 最终被卡死 = **零分**, 跟激进失败一样归零
- ❌ 一步导致 1-3 步内死亡 = **零分**

"丑活胜过帅死" + "**敢于激进重组才是真活**"。
被自己保守卡死和被自己激进卡死, 结果一样。所以宁可激进尝试翻盘。`

const KEY_MAP: Record<string, string> = {
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
}

const BOARD_CROP = { left: 360, top: 210, width: 430, height: 440 }

async function captureBoard(page: Page): Promise<{ b64: string; bytes: Buffer }> {
  const png = await page.screenshot({ type: 'png' })
  const jpeg = await sharp(png).extract(BOARD_CROP).jpeg({ quality: 75 }).toBuffer()
  return { b64: jpeg.toString('base64'), bytes: jpeg }
}

async function isGameOver(page: Page): Promise<boolean> {
  const txt = (await page.evaluate('document.body.innerText')) as string
  return /game over|try again|游戏结束|再玩一次/i.test(txt)
}

interface UserMsg {
  role: 'user'
  content: Array<
    | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
    | { type: 'text'; text: string }
  >
}
interface AssistantMsg {
  role: 'assistant'
  content: string
}
type ConvMsg = UserMsg | AssistantMsg

interface LlmTurn {
  direction: string
  reason: string
  raw: string
  usage: { input?: number; cacheRead?: number; cacheCreate?: number; output?: number }
}

async function callLLM(messages: ConvMsg[]): Promise<LlmTurn> {
  const url = `${BASE_URL}/messages?beta=true`
  const body = {
    model: MODEL,
    stream: true,
    max_tokens: MAX_TOKENS,
    thinking: { type: 'enabled', budget_tokens: THINKING_BUDGET },
    system: [
      { type: 'text', text: CLAUDE_CODE_BILLING_HEADER },
      { type: 'text', text: CLAUDE_CODE_SDK_PROMPT },
      { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral', ttl: '1h' } },
    ],
    messages,
  }
  const headers = buildClaudeCodeHeaders({ accessToken: API_KEY, timeoutMs: 180_000 })

  let lastErr = ''
  let lastStatus = 0
  const backoffs = [4000, 8000, 16000, 32000, 64000]
  for (let attempt = 0; attempt < backoffs.length; attempt++) {
    if (attempt > 0) {
      console.log(`[demo8] retry attempt ${attempt + 1} after ${backoffs[attempt - 1]! / 1000}s (last=${lastStatus} ${lastErr.slice(0, 100)})`)
      await new Promise((r) => setTimeout(r, backoffs[attempt - 1]!))
    }
    try {
      const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) })
      const text = await res.text()
      if (res.ok && text.length > 0) return parseLlmResponse(text)
      lastStatus = res.status
      lastErr = res.ok ? '(empty body)' : text.slice(0, 500)
      if (res.status < 500 && res.ok === false) break
    } catch (err) {
      lastErr = String(err)
    }
  }
  throw new Error(`API ${lastStatus} after retry: ${lastErr}`)
}

function parseLlmResponse(text: string): LlmTurn {
  const parsed = parseClaudeMessageResponse(text)
  if (!parsed) throw new Error(`SSE parse failed: ${text.slice(0, 500)}`)

  const textOut = (parsed.content ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('\n')
    .trim()

  const matches = textOut.match(/\{[\s\S]*?"direction"[\s\S]*?\}/g) ?? []
  const lastJson = matches[matches.length - 1]
  let direction = ''
  let reason = ''
  if (lastJson) {
    try {
      const obj = JSON.parse(lastJson) as { direction?: string; reason?: string }
      direction = String(obj.direction ?? '').toLowerCase()
      reason = String(obj.reason ?? '')
    } catch {
      /* ignore */
    }
  }

  return {
    direction,
    reason,
    raw: textOut,
    usage: {
      input: parsed.usage?.input_tokens ?? undefined,
      cacheRead: parsed.usage?.cache_read_input_tokens ?? undefined,
      cacheCreate: parsed.usage?.cache_creation_input_tokens ?? undefined,
      output: parsed.usage?.output_tokens ?? undefined,
    },
  }
}

async function main(): Promise<void> {
  mkdirSync(SHOT_DIR, { recursive: true })
  const browser = await chromium.launch({
    headless: false,
    channel: 'chrome',
    args: ['--window-position=20,20', '--window-size=900,1100'],
  })
  const context = await browser.newContext({ viewport: { width: 800, height: 1000 } })
  const page = await context.newPage()

  console.log(`[demo8] model=${MODEL} max_steps=${MAX_STEPS} accumulating history + per-step strategy inject`)
  console.log('[demo8] opening play2048.co')
  await page.goto('https://play2048.co/', { waitUntil: 'domcontentloaded', timeout: 30_000 })
  await page.waitForTimeout(2500)
  await page.locator('button.bg-near-black.rounded-full').click({ timeout: 3000 }).catch(() => {})
  await page.waitForTimeout(500)
  await page.locator('body').click({ position: { x: 200, y: 500 } }).catch(() => {})
  await page.waitForTimeout(200)

  const conversation: ConvMsg[] = []
  const log: Array<Record<string, unknown>> = []
  let badCount = 0
  let endReason = 'unknown'
  const startTime = Date.now()

  for (let step = 1; step <= MAX_STEPS; step++) {
    const shot = await captureBoard(page)
    writeFileSync(path.join(SHOT_DIR, `${String(step).padStart(3, '0')}-before.jpg`), shot.bytes)

    // 累积 user turn: 战略提示 (恒定字节) → image → step number
    conversation.push({
      role: 'user',
      content: [
        { type: 'text', text: STRATEGY_REMINDER },
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: shot.b64 } },
        { type: 'text', text: `第 ${step} 步.` },
      ],
    })

    const t0 = Date.now()
    let turn: LlmTurn
    try {
      turn = await callLLM(conversation)
    } catch (err) {
      console.error(`[demo8] step ${step} LLM error:`, err)
      conversation.pop()
      endReason = 'llm_error'
      break
    }
    const dt = Date.now() - t0

    conversation.push({ role: 'assistant', content: turn.raw })

    const key = KEY_MAP[turn.direction]
    const u = turn.usage
    const usageStr = `in=${u.input ?? '?'} cR=${u.cacheRead ?? '?'} cC=${u.cacheCreate ?? '?'} out=${u.output ?? '?'}`

    if (!key) {
      badCount++
      console.log(`[demo8] step ${String(step).padStart(3)}: BAD "${turn.direction}" raw="${turn.raw.slice(0, 80).replace(/\n/g, ' ')}" (${dt}ms ${shot.bytes.byteLength}B [${usageStr}])`)
      log.push({ step, badRaw: turn.raw, latencyMs: dt, jpegBytes: shot.bytes.byteLength, usage: u })
      if (badCount >= 3 && log.slice(-3).every((e) => e.badRaw)) {
        endReason = 'bad_parse_streak'
        break
      }
      continue
    }

    await page.keyboard.press(key)
    await page.waitForTimeout(250)

    console.log(`[demo8] step ${String(step).padStart(3)}: ${turn.direction.padEnd(5)} (${dt}ms ${shot.bytes.byteLength}B [${usageStr}]) — ${turn.reason}`)
    log.push({ step, direction: turn.direction, reason: turn.reason, latencyMs: dt, jpegBytes: shot.bytes.byteLength, usage: u })

    if (await isGameOver(page)) {
      endReason = 'game_over'
      console.log(`[demo8] *** GAME OVER at step ${step} ***`)
      break
    }

    if (step % 10 === 0) {
      await page.screenshot({ path: path.join(SHOT_DIR, '99-checkpoint.png') })
      writeFileSync(path.join(SHOT_DIR, 'log.json'), JSON.stringify(log, null, 2))
    }
  }

  if (endReason === 'unknown') endReason = 'max_steps_reached'

  await page.screenshot({ path: path.join(SHOT_DIR, '99-final.png') })
  writeFileSync(path.join(SHOT_DIR, 'log.json'), JSON.stringify(log, null, 2))

  const okSteps = log.filter((e) => e.direction).length
  const avgLatency = log.length > 0 ? Math.round(log.reduce((s, e) => s + (e.latencyMs as number), 0) / log.length) : 0
  const totalOut = log.reduce((s, e) => s + ((e.usage as LlmTurn['usage'])?.output ?? 0), 0)
  const totalIn = log.reduce((s, e) => s + ((e.usage as LlmTurn['usage'])?.input ?? 0), 0)
  const totalCacheRead = log.reduce((s, e) => s + ((e.usage as LlmTurn['usage'])?.cacheRead ?? 0), 0)
  const elapsedMin = Math.round((Date.now() - startTime) / 60_000)
  console.log('')
  console.log(`[demo8] ====== SUMMARY ======`)
  console.log(`[demo8] end_reason: ${endReason}`)
  console.log(`[demo8] total steps: ${log.length} (${okSteps} good, ${badCount} bad)`)
  console.log(`[demo8] elapsed: ${elapsedMin} min, avg ${avgLatency}ms/step`)
  console.log(`[demo8] tokens: input total ${totalIn}, output total ${totalOut}, cache_read total ${totalCacheRead}`)
  console.log(`[demo8] artifacts: ${SHOT_DIR}/`)

  await browser.close()
}

main().catch((err: unknown) => {
  console.error('[demo8] error:', err)
  process.exit(1)
})
