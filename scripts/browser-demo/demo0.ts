/**
 * demo 0: 纯 Playwright 验证 play2048.co 操控链路
 *
 * 只验证 Playwright 这层:
 *   - 能开 play2048.co
 *   - 能 dismiss tutorial modal
 *   - keyboard.press 方向键真的进了游戏
 *   - 截图能存盘 + 视觉上棋盘有变化
 *
 * 不读 DOM 状态 (React + svelte hash class 不稳定, 且 demo 1/2 走 vision 路线根本不需要).
 *
 * 用法: pnpm tsx scripts/browser-demo/demo0.ts
 */

import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import path from 'node:path'

const SHOT_DIR = 'scripts/browser-demo/screenshots/demo0'

async function main(): Promise<void> {
  mkdirSync(SHOT_DIR, { recursive: true })

  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 800, height: 1000 } })
  const page = await context.newPage()

  console.log('[demo0] opening play2048.co')
  await page.goto('https://play2048.co/', { waitUntil: 'load', timeout: 30_000 })
  await page.waitForTimeout(2000)

  await page.screenshot({ path: path.join(SHOT_DIR, '00-loaded.png') })

  // dismiss tutorial modal — 试三种方法 (ESC / 点 modal 外 / 点 close 按钮)
  console.log('[demo0] dismissing tutorial')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
  // 兜底: 找右上角圆形 close 按钮 (HTML 里 .bg-near-black.absolute.right-0.top-0.rounded-full)
  const closeBtn = page.locator('button.rounded-full').first()
  if (await closeBtn.isVisible().catch(() => false)) {
    await closeBtn.click().catch(() => {})
    await page.waitForTimeout(300)
  }
  await page.screenshot({ path: path.join(SHOT_DIR, '01-after-dismiss.png') })

  // focus 到 body 确保键盘事件不被 modal 吃
  await page.locator('body').click({ position: { x: 400, y: 500 } }).catch(() => {})
  await page.waitForTimeout(200)

  const sequence = [
    'ArrowUp', 'ArrowUp', 'ArrowRight', 'ArrowRight',
    'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowLeft',
    'ArrowUp', 'ArrowRight', 'ArrowDown', 'ArrowLeft',
    'ArrowUp', 'ArrowRight', 'ArrowDown', 'ArrowLeft',
    'ArrowUp', 'ArrowRight', 'ArrowDown', 'ArrowLeft',
  ] as const

  console.log(`[demo0] pressing ${sequence.length} arrow keys`)
  for (let i = 0; i < sequence.length; i++) {
    const key = sequence[i]!
    await page.keyboard.press(key)
    await page.waitForTimeout(200) // 等动画 + 新格子

    const shotPath = path.join(SHOT_DIR, `${String(i + 2).padStart(2, '0')}-${key}.png`)
    await page.screenshot({ path: shotPath })
    console.log(`[demo0] step ${String(i + 1).padStart(2)}: ${key}`)
  }

  await page.screenshot({ path: path.join(SHOT_DIR, '99-final.png') })
  console.log(`[demo0] done, ${sequence.length + 3} screenshots in ${SHOT_DIR}`)

  await browser.close()
}

main().catch((err: unknown) => {
  console.error('[demo0] error:', err)
  process.exit(1)
})
