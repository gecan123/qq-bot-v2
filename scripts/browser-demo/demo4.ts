/**
 * demo 4: demo 3 配置, 玩到 game over
 *
 * 跟 demo 3 区别:
 *   - 不再固定 30 步, while 循环直到 game over 或 context overflow 或安全上限
 *   - 每步后用 page.evaluate 检查 innerText 是否包含 "Game Over" / "Try Again"
 *   - 安全上限 500 步 (够看, 防意外)
 *
 * 用法: pnpm tsx scripts/browser-demo/demo4.ts
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
const SHOT_DIR = 'scripts/browser-demo/screenshots/demo4'
const MAX_STEPS = 500
const THINKING_BUDGET = 16000
const MAX_TOKENS = 20000

const SYSTEM_PROMPT_OLD = `你在玩 2048 游戏。你的任务是根据截图序列判断当前棋盘，并输出下一步方向。

棋盘规则：
- 棋盘是 4x4。
- 方向键会把所有格子推向该方向。
- 同值相邻格子在移动方向上会合并一次。
- 每次有效移动后会随机出现一个新数字。

你必须先从最新截图中还原当前棋盘：
- 按行列标记位置：r1c1 到 r4c4。
- r1 是最上面一行，c1 是最左边一列。
- 空格记为 0。

你还要利用历史截图判断上一步是否有效：
- 如果最新截图和上一张截图完全一样，说明上一次方向无效。
- 无效方向本轮不要重复。
- 如果某个方向推演后棋盘完全不变，该方向也是非法方向，不要选择。

核心策略，优先级从高到低：

1. 锁定最大数字角落
- 2048 的核心赢法是把当前最大数字固定在一个角落。
- 一旦最大数字在某个角落，就不要轻易选择会把它推出角落的方向。
- 如果最大数字已经在右下角，优先保持它在右下角，主方向通常是 down 和 right。
- 如果最大数字已经在左下角，主方向通常是 down 和 left。
- 如果最大数字已经在右上角，主方向通常是 up 和 right。
- 如果最大数字已经在左上角，主方向通常是 up 和 left。
- 不要频繁换角。除非当前角落已经明显崩坏，否则继续围绕已有最大数字角落布局。

2. 维持蛇形单调结构
理想棋盘应像蛇形一样从最大数字角落向外递减。例如最大数字在右下角时，理想梯度类似：
小 → 中 → 大 → 更大
更小 ← 中 ← 大 ← 更大
小 → 中 → 大 → 更大
更小 ← 中 ← 大 ← 最大

目标：
- 大数字集中在目标角附近。
- 相邻大数字尽量排成链，方便 128+128、256+256、512+512 继续合并。
- 避免把小数字插进大数字链中间。
- 避免把最大数字旁边的位置变成无法合并的小孤岛。

3. 优先保留空格
- 空格越多，局面越安全。
- 一步移动后如果能增加空格，通常是好选择。
- 但不要为了一个小合并破坏最大数字角落和蛇形结构。

4. 合并优先级
优先选择：
- 能合并靠近最大数字角落的大数字的方向。
- 能形成连续合并链的方向，例如 64+64 后靠近 128，或者 128+128 后贴近 256。
- 能把相同数字推到同一行/列，为下一步合并做准备的方向。

不要贪：
- 只合并 2+2 或 4+4，但会破坏大数字角落的方向。
- 会把最大数字从角落移走的方向。
- 会让棋盘变得更乱、空格更少的方向。

5. 主方向原则
如果目标角在下方：
- 尽量使用 down 作为主方向。
- 根据目标角在左还是右，使用 left 或 right 作为第二主方向。
- 尽量避免 up，除非没有别的安全有效移动，或者 up 能产生关键合并且不会破坏最大数字角落。

如果目标角在上方：
- 尽量使用 up 作为主方向。
- 根据目标角在左还是右，使用 left 或 right 作为第二主方向。
- 尽量避免 down，除非没有别的安全有效移动。

6. 每一步都要推演四个方向
你必须在脑中分别推演 up/down/left/right：
- 移动后棋盘是否变化？
- 哪些格子会合并？
- 最大数字是否仍在目标角？
- 空格数量是增加还是减少？
- 大数字链是否更单调？
- 是否会制造孤立小数字？
- 是否会让下一步无路可走？

选择评分最高的合法方向。

决策顺序：
1. 排除无效方向。
2. 排除会把最大数字推出稳定角落的危险方向，除非别无选择。
3. 优先选择能保持角落、增加空格、合并大数字、维持蛇形单调的方向。
4. 如果多个方向都可以，选更符合主方向原则的方向。
5. 如果局面危险，优先选择能打开空间的方向，而不是小额合并。

最终只输出一行 JSON，不要输出 Markdown，不要输出多余解释：

{"direction": "up", "reason": "一句中文理由，必须具体说明选择原因，例如保住右下角最大数、r3c4 与 r4c4 可合并、或避免重复无效方向"}

direction 必须是 "up" / "down" / "left" / "right" 之一。`;

const SYSTEM_PROMPT = `你在玩 2048 游戏。根据历史截图判断当前 4x4 棋盘，输出下一步方向。

你必须还原最新棋盘，坐标为 r1c1 到 r4c4，空格为 0。对比最新图和上一张图：
- 如果棋盘完全相同，说明上次方向无效，本轮不要重复该方向。
- 推演后棋盘不变的方向也是无效方向。

2048 的长期目标：
- 让最大数字尽量稳定在一个角落。
- 围绕最大数字维持大致单调的蛇形梯度。
- 但角落和蛇形只是手段，不是绝对目标。真正目标是持续合并、保留空格、避免死亡。

每一步必须评估四个方向，并按以下评分选择：

高优先级：
1. 合法：移动后棋盘必须变化。
2. 生存：如果空格很少，优先选择能增加空格、制造合并机会、避免下一步无路可走的方向。
3. 合并潜力：优先让相同数字相邻或直接合并，尤其是 32+32、64+64、128+128 这类中大数字。
4. 角落稳定：最大数字在角落时，通常避免把它推出角落。
5. 结构：尽量保持大数字靠近最大数字，维持大致单调链。

重要例外：
- 如果棋盘拥挤，允许临时破坏蛇形或移动最大数字旁边的小结构来换取空格和合并机会。
- 不要为了守住一条漂亮但无法继续合并的蛇形链而放弃救场。
- 完美单调但没有相邻同值、没有空格、没有下一步合并潜力，是坏局面。
- 小合并不是永远差：如果 2+2 或 4+4 能打开空间、制造连锁、避免死亡，可以选择。
- 如果主方向无效，不要执着主方向，立刻换能改善局面的方向。

两步思考：
- 不只看这一步合并多少，还要看移动后下一步是否容易继续合并。
- 好方向通常会让相同数字靠近、让大数字链有延续空间、让空格集中而不是碎裂。

最终只输出一行 JSON：
{"direction": "up", "reason": "一句中文理由，具体说明当前选择，例如增加空格、形成 r2c3/r3c3 合并、避免重复无效方向、或临时破坏蛇形来救场"}

direction 必须是 "up" / "down" / "left" / "right" 之一。`;

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

  // 上游 EOF 500 偶发, 5 次指数退避: 4s/8s/16s/32s/64s
  let lastErr = ''
  let lastStatus = 0
  const backoffs = [4000, 8000, 16000, 32000, 64000]
  for (let attempt = 0; attempt < backoffs.length; attempt++) {
    if (attempt > 0) {
      console.log(`[demo4] retry attempt ${attempt + 1} after ${backoffs[attempt - 1]! / 1000}s (last=${lastStatus} ${lastErr.slice(0, 100)})`)
      await new Promise((r) => setTimeout(r, backoffs[attempt - 1]!))
    }
    try {
      const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) })
      const text = await res.text()
      if (res.ok) return parseLlmResponse(text)
      lastStatus = res.status
      lastErr = text.slice(0, 500)
      if (res.status < 500) break // 4xx 不 retry
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
  // headed 模式 + 用户本机 Chrome.app, 实时可见 (无 slowMo)
  const browser = await chromium.launch({
    headless: false,
    channel: 'chrome',
    args: ['--window-position=20,20', '--window-size=900,1100'],
  })
  const context = await browser.newContext({ viewport: { width: 800, height: 1000 } })
  const page = await context.newPage()

  console.log(`[demo4] model=${MODEL} max_steps=${MAX_STEPS} thinking=${THINKING_BUDGET}`)
  console.log('[demo4] opening play2048.co')
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
    const { b64, bytes } = await captureBoard(page)
    writeFileSync(path.join(SHOT_DIR, `${String(step).padStart(3, '0')}-before.jpg`), bytes)

    conversation.push({
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } },
        { type: 'text', text: `第 ${step} 步.` },
      ],
    })

    const t0 = Date.now()
    let turn: LlmTurn
    try {
      turn = await callLLM(conversation)
    } catch (err) {
      console.error(`[demo4] step ${step} LLM error:`, err)
      conversation.pop()
      endReason = 'llm_error'
      break
    }
    const dt = Date.now() - t0

    conversation.push({ role: 'assistant', content: turn.raw })

    const key = KEY_MAP[turn.direction]
    const u = turn.usage
    const usageStr = `in=${u.input ?? '?'} out=${u.output ?? '?'}`

    if (!key) {
      badCount++
      console.log(
        `[demo4] step ${String(step).padStart(3)}: BAD "${turn.direction}" raw="${turn.raw.slice(0, 80).replace(/\n/g, ' ')}" (${dt}ms ${bytes.byteLength}B [${usageStr}])`,
      )
      log.push({ step, badRaw: turn.raw, latencyMs: dt, jpegBytes: bytes.byteLength, usage: u })
      // 连续 3 个 bad 就放弃 (避免无限烧)
      if (badCount >= 3 && log.slice(-3).every((e) => e.badRaw)) {
        endReason = 'bad_parse_streak'
        break
      }
      continue
    }

    await page.keyboard.press(key)
    await page.waitForTimeout(250)

    console.log(
      `[demo4] step ${String(step).padStart(3)}: ${turn.direction.padEnd(5)} (${dt}ms ${bytes.byteLength}B [${usageStr}]) — ${turn.reason}`,
    )
    log.push({
      step,
      direction: turn.direction,
      reason: turn.reason,
      latencyMs: dt,
      jpegBytes: bytes.byteLength,
      usage: u,
    })

    // 检查 game over
    if (await isGameOver(page)) {
      endReason = 'game_over'
      console.log(`[demo4] *** GAME OVER at step ${step} ***`)
      break
    }

    // 每 10 步 flush log + final 截图 (防止崩了丢数据)
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
  const elapsedMin = Math.round((Date.now() - startTime) / 60_000)
  console.log('')
  console.log(`[demo4] ====== SUMMARY ======`)
  console.log(`[demo4] end_reason: ${endReason}`)
  console.log(`[demo4] total steps: ${log.length} (${okSteps} good, ${badCount} bad)`)
  console.log(`[demo4] elapsed: ${elapsedMin} min, avg ${avgLatency}ms/step`)
  console.log(`[demo4] tokens: input total ${totalIn}, output total ${totalOut}`)
  console.log(`[demo4] artifacts: ${SHOT_DIR}/`)

  await browser.close()
}

main().catch((err: unknown) => {
  console.error('[demo4] error:', err)
  process.exit(1)
})
