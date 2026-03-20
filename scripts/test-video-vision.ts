/**
 * 测试 gpt-5.4-mini 是否能直接理解视频
 *
 * 运行方式：
 *   pnpm tsx scripts/test-video-vision.ts
 *
 * 测试内容：
 *   1. 直接发 video/mp4 buffer → image_url（当前代码逻辑）
 *   2. 发一张静态 JPEG（对照基准，验证 vision 本身可用）
 */

import OpenAI from 'openai'

const MODEL = process.env.TEST_MODEL ?? process.env.LLM_DESCRIBE_IMAGE_MODEL ?? 'gpt-5.4-mini'
const BASE_URL = process.env.OPENAI_BASE_URL ?? 'http://127.0.0.1:8317/v1'
const API_KEY = process.env.OPENAI_API_KEY ?? 'sk-local'

const TEST_VIDEO_URL = 'https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4'
// 公开 JPEG 用作对照
const TEST_IMAGE_URL = 'https://www.gstatic.com/webp/gallery/1.jpg'

const client = new OpenAI({ baseURL: BASE_URL, apiKey: API_KEY })

async function fetchBuffer(url: string): Promise<{ buffer: Buffer; contentType: string }> {
  console.log(`下载: ${url}`)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`)
  const contentType = res.headers.get('content-type') ?? 'application/octet-stream'
  const buffer = Buffer.from(await res.arrayBuffer())
  console.log(`  ✓ ${buffer.length} bytes, contentType=${contentType}`)
  return { buffer, contentType }
}

async function testVisionWithBuffer(
  label: string,
  buffer: Buffer,
  contentType: string,
): Promise<void> {
  const base64 = buffer.toString('base64')
  const dataUrl = `data:${contentType};base64,${base64}`

  console.log(`\n── ${label} ──`)
  console.log(`  model=${MODEL}, contentType=${contentType}, size=${buffer.length} bytes`)

  try {
    const response = await client.chat.completions.create({
      model: MODEL,
      temperature: 0.3,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: '请用一句话描述这个内容。' },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        },
      ],
    })

    const text = response.choices[0]?.message.content?.trim()
    console.log(`  ✓ 成功回复: ${text}`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.log(`  ✗ 失败: ${msg}`)
  }
}

async function main() {
  console.log(`=== 视频 Vision 能力测试 ===`)
  console.log(`model: ${MODEL}`)
  console.log(`baseURL: ${BASE_URL}\n`)

  // 对照组：静态图片
  try {
    const img = await fetchBuffer(TEST_IMAGE_URL)
    await testVisionWithBuffer('对照：静态 JPEG 图片', img.buffer, 'image/jpeg')
  } catch (err) {
    console.log(`图片下载失败: ${err}`)
  }

  // 实验组：视频文件（当前代码逻辑）
  try {
    const video = await fetchBuffer(TEST_VIDEO_URL)
    // 当前代码用实际 contentType（video/mp4），下面也测试用 image/jpeg 伪装
    await testVisionWithBuffer('实验1：raw video/mp4 buffer（当前代码逻辑）', video.buffer, 'video/mp4')
  } catch (err) {
    console.log(`视频下载失败: ${err}`)
  }

  console.log('\n=== 测试完成 ===')
}

main().catch(console.error)
