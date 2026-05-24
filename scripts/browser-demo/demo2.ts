/**
 * demo 2: 累积截图历史 — 每步只追加, 不重写
 *
 * 跟 demo 1 区别:
 *   - messages 数组每步只在尾部 append 2 条 (new user-image + last assistant)
 *   - LLM 看历史截图序列, 自己推断"上一步有没有效", 避免重复无效操作
 *   - 前面所有 message 字节不变, Anthropic prompt cache 一路命中
 *
 * 验证:
 *   - 多步累积截图能不能打破 demo 1 的死循环
 *   - cache 命中后单步延迟是否下降
 *   - context 长度对模型决策质量的影响
 *
 * 用法: pnpm tsx scripts/browser-demo/demo2.ts
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
const SHOT_DIR = 'scripts/browser-demo/screenshots/demo2'
const STEPS = 30

const SYSTEM_PROMPT = `你在玩 2048 游戏. 看截图序列判定棋盘状态变化, 输出下一步方向.

棋盘是 4x4. 方向键把所有格子推向那个方向, 同值相邻格子合并.

历史截图都在 context 里 — 对比连续两张图可知上一步是否生效:
- 如果新图跟上一张完全一样, 说明上次方向无效 (没格子能往那个方向推), 必须换别的方向
- 不要重复发无效方向

输出格式严格 — 仅一行 JSON, 不要任何额外文字:
{"direction": "up", "reason": "一句中文理由"}

direction 必须是 "up" / "down" / "left" / "right" 之一.`

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
    max_tokens: 256,
    system: [
      { type: 'text', text: CLAUDE_CODE_BILLING_HEADER },
      { type: 'text', text: CLAUDE_CODE_SDK_PROMPT },
      { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral', ttl: '1h' } },
    ],
    messages,
  }
  const headers = buildClaudeCodeHeaders({ accessToken: API_KEY, timeoutMs: 90_000 })

  // 简单 retry: 上游 5xx 或 transport 错误 retry 至多 3 次, 指数退避
  let lastErr = ''
  let lastStatus = 0
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, 2000 * attempt))
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

  const m = textOut.match(/\{[\s\S]*?"direction"[\s\S]*?\}/)
  let direction = ''
  let reason = ''
  if (m) {
    try {
      const obj = JSON.parse(m[0]) as { direction?: string; reason?: string }
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
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 800, height: 1000 } })
  const page = await context.newPage()

  console.log(`[demo2] model=${MODEL} steps=${STEPS}`)
  console.log('[demo2] opening play2048.co')
  await page.goto('https://play2048.co/', { waitUntil: 'domcontentloaded', timeout: 30_000 })
  await page.waitForTimeout(2500)
  await page.locator('button.bg-near-black.rounded-full').click({ timeout: 3000 }).catch(() => {})
  await page.waitForTimeout(500)
  await page.locator('body').click({ position: { x: 200, y: 500 } }).catch(() => {})
  await page.waitForTimeout(200)

  const conversation: ConvMsg[] = []
  const log: Array<Record<string, unknown>> = []
  let badCount = 0

  for (let step = 1; step <= STEPS; step++) {
    const { b64, bytes } = await captureBoard(page)
    writeFileSync(path.join(SHOT_DIR, `${String(step).padStart(2, '0')}-before.jpg`), bytes)

    // append user turn (image + text)
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
      console.error(`[demo2] step ${step} LLM error:`, err)
      // 回滚 user turn 以保持 user/assistant 交替不变, 然后退出
      conversation.pop()
      break
    }
    const dt = Date.now() - t0

    // append assistant response (保留原文, 下轮 messages 仍然合法)
    conversation.push({ role: 'assistant', content: turn.raw })

    const key = KEY_MAP[turn.direction]
    const u = turn.usage
    const usageStr = `in=${u.input ?? '?'} cR=${u.cacheRead ?? '?'} cC=${u.cacheCreate ?? '?'} out=${u.output ?? '?'}`

    if (!key) {
      badCount++
      console.log(
        `[demo2] step ${String(step).padStart(2)}: BAD "${turn.direction}" raw="${turn.raw.slice(0, 80).replace(/\n/g, ' ')}" (${dt}ms ${bytes.byteLength}B)`,
      )
      log.push({ step, badRaw: turn.raw, latencyMs: dt, jpegBytes: bytes.byteLength, usage: u })
      continue
    }

    await page.keyboard.press(key)
    await page.waitForTimeout(200)

    console.log(
      `[demo2] step ${String(step).padStart(2)}: ${turn.direction.padEnd(5)} (${dt}ms ${bytes.byteLength}B) [${usageStr}] — ${turn.reason}`,
    )
    log.push({
      step,
      direction: turn.direction,
      reason: turn.reason,
      latencyMs: dt,
      jpegBytes: bytes.byteLength,
      usage: u,
    })
  }

  await page.screenshot({ path: path.join(SHOT_DIR, '99-final.png') })
  writeFileSync(path.join(SHOT_DIR, 'log.json'), JSON.stringify(log, null, 2))

  const okSteps = log.filter((e) => e.direction).length
  const avgLatency = log.length > 0 ? Math.round(log.reduce((s, e) => s + (e.latencyMs as number), 0) / log.length) : 0
  console.log(`[demo2] done: ${okSteps}/${log.length} good, ${badCount} bad, avg ${avgLatency}ms`)
  console.log(`[demo2] conversation grew to ${conversation.length} messages (${conversation.filter((m) => m.role === 'user').length} images)`)
  console.log(`[demo2] artifacts: ${SHOT_DIR}/`)

  await browser.close()
}

main().catch((err: unknown) => {
  console.error('[demo2] error:', err)
  process.exit(1)
})
