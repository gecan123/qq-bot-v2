/** 关掉 modal 后截图, 让我量棋盘 bbox. */
import { chromium } from 'playwright'

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 800, height: 1000 } })
await page.goto('https://play2048.co/', { waitUntil: 'load', timeout: 30_000 })
await page.waitForTimeout(2000)

// 真 dismiss tutorial
await page.locator('button.bg-near-black.rounded-full').click({ timeout: 3000 }).catch(() => {})
await page.waitForTimeout(800)
await page.screenshot({ path: 'scripts/browser-demo/screenshots/probe-after-dismiss.png' })

// 找 tile 的 bbox (任意含数字 2 的格子)
const tileBox = (await page.evaluate(`
  const tiles = Array.from(document.querySelectorAll('*')).filter(el => {
    const t = (el.textContent || '').trim()
    return t === '2' && el.children.length === 0
  })
  tiles.map(el => {
    const r = el.getBoundingClientRect()
    return JSON.stringify({ w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y) })
  }).join('\\n')
`)) as string
console.log('--- elements with text "2" ---')
console.log(tileBox)

await browser.close()
