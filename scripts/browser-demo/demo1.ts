/**
 * demo 1: Claude Opus 4.7 看截图玩 2048, 跑 20 步
 *
 * 验证:
 *   - cliproxy + claude-code identity headers + vision content block 这条链路通
 *   - 模型看一张截图能识对棋盘 + 给出合理方向 JSON
 *   - 端到端单步延迟可接受
 *
 * 不验证 (留给 demo 2):
 *   - game over 自动检测
 *   - 历史 trim
 *   - 长时间持续稳定性
 *
 * 用法: pnpm tsx scripts/browser-demo/demo1.ts
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
const SHOT_DIR = 'scripts/browser-demo/screenshots/demo1'
const STEPS = 20

const SYSTEM_PROMPT = `你在玩 2048 游戏. 看截图判定棋盘当前状态, 输出下一步方向.

棋盘是 4x4. 方向键会把所有格子推向那个方向, 同值相邻格子合并. 目标是合出 2048.

输出格式严格 — 仅一行 JSON, 不要任何额外文字:
{"direction": "up", "reason": "一句中文理由"}

direction 必须是 "up" / "down" / "left" / "right" 之一.`

interface LlmDecision {
  direction: string
  reason: string
  raw: string
}

async function callLLM(jpegB64: string, step: number): Promise<LlmDecision> {
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
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: jpegB64 } },
          { type: 'text', text: `第 ${step} 步, 看图给方向.` },
        ],
      },
    ],
  }
  const headers = buildClaudeCodeHeaders({ accessToken: API_KEY, timeoutMs: 60_000 })
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) })
  const text = await res.text()
  if (!res.ok) throw new Error(`API ${res.status}: ${text.slice(0, 800)}`)

  const parsed = parseClaudeMessageResponse(text)
  if (!parsed) throw new Error(`SSE parse failed: ${text.slice(0, 500)}`)

  const textOut = (parsed.content ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('\n')
    .trim()

  // 容忍模型在 JSON 前后加 markdown fence / 说明
  const m = textOut.match(/\{[\s\S]*?"direction"[\s\S]*?\}/)
  if (!m) return { direction: '', reason: '', raw: textOut }
  try {
    const obj = JSON.parse(m[0]) as { direction?: string; reason?: string }
    return {
      direction: String(obj.direction ?? '').toLowerCase(),
      reason: String(obj.reason ?? ''),
      raw: textOut,
    }
  } catch {
    return { direction: '', reason: '', raw: textOut }
  }
}

const KEY_MAP: Record<string, string> = {
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
}

// 棋盘区域 — 视口 800x1000 下 modal 关掉后实测位置, 加 padding
const BOARD_CROP = { left: 360, top: 210, width: 430, height: 440 }

async function captureBoard(page: Page): Promise<{ b64: string; bytes: Buffer }> {
  const png = await page.screenshot({ type: 'png' })
  const jpeg = await sharp(png)
    .extract(BOARD_CROP)
    .jpeg({ quality: 75 })
    .toBuffer()
  return { b64: jpeg.toString('base64'), bytes: jpeg }
}

async function main(): Promise<void> {
  mkdirSync(SHOT_DIR, { recursive: true })
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 800, height: 1000 } })
  const page = await context.newPage()

  console.log(`[demo1] model=${MODEL} url=${BASE_URL}`)
  console.log('[demo1] opening play2048.co')
  await page.goto('https://play2048.co/', { waitUntil: 'domcontentloaded', timeout: 30_000 })
  await page.waitForTimeout(2500)
  // 真关 tutorial modal — 右上角圆形 close 按钮
  await page.locator('button.bg-near-black.rounded-full').click({ timeout: 3000 }).catch(() => {})
  await page.waitForTimeout(500)
  // focus body 确保键盘事件不被其他元素吃
  await page.locator('body').click({ position: { x: 200, y: 500 } }).catch(() => {})
  await page.waitForTimeout(200)

  interface LogEntry {
    step: number
    direction?: string
    reason?: string
    badRaw?: string
    latencyMs: number
    jpegBytes: number
  }
  const log: LogEntry[] = []
  let badCount = 0

  for (let step = 1; step <= STEPS; step++) {
    const { b64, bytes } = await captureBoard(page)
    writeFileSync(path.join(SHOT_DIR, `${String(step).padStart(2, '0')}-before.jpg`), bytes)

    const t0 = Date.now()
    let decision: LlmDecision
    try {
      decision = await callLLM(b64, step)
    } catch (err) {
      console.error(`[demo1] step ${step} LLM error:`, err)
      break
    }
    const dt = Date.now() - t0

    const key = KEY_MAP[decision.direction]
    if (!key) {
      badCount++
      console.log(
        `[demo1] step ${String(step).padStart(2)}: BAD direction="${decision.direction}" ` +
        `raw="${decision.raw.slice(0, 100).replace(/\n/g, ' ')}" (${dt}ms, ${bytes.byteLength}B)`,
      )
      log.push({ step, badRaw: decision.raw, latencyMs: dt, jpegBytes: bytes.byteLength })
      continue
    }

    await page.keyboard.press(key)
    await page.waitForTimeout(200)

    console.log(
      `[demo1] step ${String(step).padStart(2)}: ${decision.direction.padEnd(5)} ` +
      `(${dt}ms, ${bytes.byteLength}B) — ${decision.reason}`,
    )
    log.push({
      step,
      direction: decision.direction,
      reason: decision.reason,
      latencyMs: dt,
      jpegBytes: bytes.byteLength,
    })
  }

  await page.screenshot({ path: path.join(SHOT_DIR, '99-final.png') })
  writeFileSync(path.join(SHOT_DIR, 'log.json'), JSON.stringify(log, null, 2))

  const okSteps = log.filter((e) => e.direction).length
  const avgLatency = log.length > 0 ? Math.round(log.reduce((s, e) => s + e.latencyMs, 0) / log.length) : 0
  console.log(`[demo1] done: ${okSteps}/${log.length} good directions, ${badCount} bad parse, avg ${avgLatency}ms`)
  console.log(`[demo1] artifacts: ${SHOT_DIR}/`)

  await browser.close()
}

main().catch((err: unknown) => {
  console.error('[demo1] error:', err)
  process.exit(1)
})
