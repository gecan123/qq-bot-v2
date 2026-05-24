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
 * 用法: pnpm tsx scripts/browser-demo/demo6.ts
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
const SHOT_DIR = 'scripts/browser-demo/screenshots/demo6'
const MAX_STEPS = 500
const THINKING_BUDGET = 16000
const MAX_TOKENS = 20000

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

direction 必须是 "up" / "down" / "left" / "right" 之一。`

// 每步注入到 user content 头部的战略提示, 字节恒定不变 → prefix cache 友好
const STRATEGY_REMINDER = `[战略提醒 — 每步先想]

1. 不要只看短期决策。你在凑的是 1024 / 2048 / 4096 这种大数字, 不是单步合 4 出 8 的局部贪婪。
2. 用全局观先看棋盘整体: 最大数在哪个角? 大数链有没有维持单调? 空格够不够? 哪里有合并潜力?
3. 确定大方向 (主攻哪个角, 沿什么链合下去) 后再做这一步的具体方向选择。
4. 不要为了眼前一个 2+2 而破坏长期合并路径; 也不要执着角落到一步都不能动的地步。
5. 后期棋盘满了的时候, 重点是"保留空格 + 制造未来合并机会", 必要时主动重组结构。`

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
      console.log(`[demo6] retry attempt ${attempt + 1} after ${backoffs[attempt - 1]! / 1000}s (last=${lastStatus} ${lastErr.slice(0, 100)})`)
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

  console.log(`[demo6] model=${MODEL} max_steps=${MAX_STEPS} accumulating history + per-step strategy inject`)
  console.log('[demo6] opening play2048.co')
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
      console.error(`[demo6] step ${step} LLM error:`, err)
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
      console.log(`[demo6] step ${String(step).padStart(3)}: BAD "${turn.direction}" raw="${turn.raw.slice(0, 80).replace(/\n/g, ' ')}" (${dt}ms ${shot.bytes.byteLength}B [${usageStr}])`)
      log.push({ step, badRaw: turn.raw, latencyMs: dt, jpegBytes: shot.bytes.byteLength, usage: u })
      if (badCount >= 3 && log.slice(-3).every((e) => e.badRaw)) {
        endReason = 'bad_parse_streak'
        break
      }
      continue
    }

    await page.keyboard.press(key)
    await page.waitForTimeout(250)

    console.log(`[demo6] step ${String(step).padStart(3)}: ${turn.direction.padEnd(5)} (${dt}ms ${shot.bytes.byteLength}B [${usageStr}]) — ${turn.reason}`)
    log.push({ step, direction: turn.direction, reason: turn.reason, latencyMs: dt, jpegBytes: shot.bytes.byteLength, usage: u })

    if (await isGameOver(page)) {
      endReason = 'game_over'
      console.log(`[demo6] *** GAME OVER at step ${step} ***`)
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
  console.log(`[demo6] ====== SUMMARY ======`)
  console.log(`[demo6] end_reason: ${endReason}`)
  console.log(`[demo6] total steps: ${log.length} (${okSteps} good, ${badCount} bad)`)
  console.log(`[demo6] elapsed: ${elapsedMin} min, avg ${avgLatency}ms/step`)
  console.log(`[demo6] tokens: input total ${totalIn}, output total ${totalOut}, cache_read total ${totalCacheRead}`)
  console.log(`[demo6] artifacts: ${SHOT_DIR}/`)

  await browser.close()
}

main().catch((err: unknown) => {
  console.error('[demo6] error:', err)
  process.exit(1)
})
