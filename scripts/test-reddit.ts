/**
 * 快速冒烟: 真打 reddit RSS 端点, 验证 list + get 两个工具能拿到数据。
 * 用法: npx tsx scripts/test-reddit.ts
 */

import { buildRedditRssUrl, parseRedditAtom } from '../src/agent/tools/reddit/list.js'
import { toRedditPostRssUrl, parseRedditPostRss } from '../src/agent/tools/reddit/get-post.js'
import { fetchRedditRss, DEFAULT_USER_AGENT } from '../src/agent/tools/reddit/shared.js'

const TIMEOUT_MS = 10_000

async function main() {
  // ── list ──
  const listUrl = buildRedditRssUrl('programming', 'hot')
  console.log(`[list] GET ${listUrl}`)
  const listOutcome = await fetchRedditRss(listUrl, {
    fetcher: fetch,
    userAgent: DEFAULT_USER_AGENT,
    timeoutMs: TIMEOUT_MS,
  })
  if (listOutcome.errorKind) {
    console.error(`[list] FAIL: ${listOutcome.errorKind}`)
    process.exit(1)
  }
  if (listOutcome.status < 200 || listOutcome.status >= 300) {
    console.error(`[list] FAIL: HTTP ${listOutcome.status}`)
    process.exit(1)
  }
  const entries = parseRedditAtom(listOutcome.body)
  console.log(`[list] OK — ${entries.length} entries, ${listOutcome.bytes} bytes`)
  for (const entry of entries.slice(0, 3)) {
    console.log(`  - ${entry.title.slice(0, 60)} | ${entry.author ?? '?'}`)
  }

  // ── get ──
  const firstLink = entries[0]?.link
  if (!firstLink) {
    console.error('[get] SKIP: no entries from list to test with')
    process.exit(1)
  }
  const rssUrl = toRedditPostRssUrl(firstLink)
  console.log(`\n[get] GET ${rssUrl}`)
  const postOutcome = await fetchRedditRss(rssUrl, {
    fetcher: fetch,
    userAgent: DEFAULT_USER_AGENT,
    timeoutMs: TIMEOUT_MS,
  })
  if (postOutcome.errorKind) {
    console.error(`[get] FAIL: ${postOutcome.errorKind}`)
    process.exit(1)
  }
  if (postOutcome.status < 200 || postOutcome.status >= 300) {
    console.error(`[get] FAIL: HTTP ${postOutcome.status}`)
    process.exit(1)
  }
  const detail = parseRedditPostRss(postOutcome.body)
  if (!detail) {
    console.error('[get] FAIL: parsed null')
    process.exit(1)
  }
  console.log(`[get] OK — "${detail.title.slice(0, 60)}"`)
  console.log(`  ${detail.comments.length} comments parsed:`)
  for (const c of detail.comments) {
    console.log(`    - ${c.author}: ${c.body.slice(0, 80)}`)
  }

  console.log('\n✅ Both list + get succeeded.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
