import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  createListRedditTool,
  buildRedditRssUrl,
  parseRedditAtom,
} from './list.js'
import { InMemoryEventQueue } from '../../event-queue.js'
import type { BotEvent } from '../../event.js'
import type { ToolContext } from '../../tool.js'

function makeCtx(): ToolContext {
  return { eventQueue: new InMemoryEventQueue<BotEvent>(), roundIndex: 1 }
}

const SAMPLE_ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>/r/programming</title>
  <entry>
    <title>Rust 1.99 released with great new things</title>
    <link href="https://www.reddit.com/r/programming/comments/abc1/rust_1_99/" rel="alternate"/>
    <summary type="html">&lt;div&gt;The new release brings &lt;strong&gt;async closures&lt;/strong&gt; and improved diagnostics.&lt;/div&gt;</summary>
    <author><name>/u/ferris</name></author>
    <published>2026-05-04T12:00:00+00:00</published>
  </entry>
  <entry>
    <title>Why I switched from Vim to Helix</title>
    <link href="https://www.reddit.com/r/programming/comments/abc2/helix/" rel="alternate"/>
    <summary type="html">&lt;p&gt;Modal editing without the .vimrc archaeology.&lt;/p&gt;</summary>
    <author><name>/u/editorlife</name></author>
    <published>2026-05-04T11:00:00+00:00</published>
  </entry>
</feed>`

describe('buildRedditRssUrl', () => {
  test('subreddit + hot → /r/{name}/hot.rss', () => {
    assert.equal(
      buildRedditRssUrl('programming', 'hot'),
      'https://www.reddit.com/r/programming/hot.rss',
    )
  })
  test('subreddit + top → /r/{name}/top.rss', () => {
    assert.equal(
      buildRedditRssUrl('rust', 'top'),
      'https://www.reddit.com/r/rust/top.rss',
    )
  })
  test('no subreddit + hot → frontpage /.rss', () => {
    assert.equal(buildRedditRssUrl(undefined, 'hot'), 'https://www.reddit.com/.rss')
  })
  test('no subreddit + new → /new.rss', () => {
    assert.equal(buildRedditRssUrl(undefined, 'new'), 'https://www.reddit.com/new.rss')
  })
})

describe('parseRedditAtom', () => {
  test('extracts title, link, summary, author, published from each entry', () => {
    const entries = parseRedditAtom(SAMPLE_ATOM)
    assert.equal(entries.length, 2)
    assert.equal(entries[0]!.title, 'Rust 1.99 released with great new things')
    assert.equal(
      entries[0]!.link,
      'https://www.reddit.com/r/programming/comments/abc1/rust_1_99/',
    )
    assert.equal(entries[0]!.author, '/u/ferris')
    assert.equal(entries[0]!.published, '2026-05-04T12:00:00+00:00')
  })

  test('strips HTML tags from summary', () => {
    const entries = parseRedditAtom(SAMPLE_ATOM)
    assert.equal(entries[0]!.summary.includes('<'), false)
    assert.equal(entries[0]!.summary.includes('strong'), false)
    assert.match(entries[0]!.summary, /async closures/)
    assert.match(entries[0]!.summary, /improved diagnostics/)
  })

  test('handles single-entry feeds (parser produces object not array)', () => {
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom">
      <entry>
        <title>only one</title>
        <link href="https://x" rel="alternate"/>
        <summary type="html">body</summary>
      </entry>
    </feed>`
    const entries = parseRedditAtom(xml)
    assert.equal(entries.length, 1)
    assert.equal(entries[0]!.title, 'only one')
  })

  test('empty feed returns empty array', () => {
    assert.deepEqual(parseRedditAtom('<feed xmlns="http://www.w3.org/2005/Atom"/>'), [])
  })
})

describe('list_reddit tool', () => {
  test('happy path: 200 + valid atom → formatted markdown list + NDJSON line', async () => {
    const writes: string[] = []
    const fetcher: typeof fetch = async (url) => {
      assert.equal(url, 'https://www.reddit.com/r/technology/hot.rss')
      return new Response(SAMPLE_ATOM, { status: 200 })
    }
    const tool = createListRedditTool({
      fetcher,
      appender: async (_p, line) => {
        writes.push(line)
      },
      logPath: '/tmp/test-list-reddit.ndjson',
    })
    const result = await tool.execute({ subreddit: 'technology', sort: 'hot', limit: 10 }, makeCtx())
    assert.match(result.content, /\[reddit \/r\/technology hot/)
    assert.match(result.content, /Rust 1\.99/)
    assert.match(result.content, /async closures/)
    assert.equal(writes.length, 1, 'exactly one NDJSON line per call')
    const logged = JSON.parse(writes[0]!.trim())
    assert.equal(logged.source, 'reddit_list')
    assert.equal(logged.status, 200)
  })

  test('limit > 10 rejected by schema', () => {
    const tool = createListRedditTool({
      fetcher: async () => new Response(SAMPLE_ATOM, { status: 200 }),
      appender: async () => {},
    })
    const parsed = tool.schema.safeParse({ subreddit: 'technology', sort: 'hot', limit: 100 })
    assert.equal(parsed.success, false)
  })

  test('title and summary are clipped (80 / 120 chars)', async () => {
    const longTitle = 'A'.repeat(200)
    const longSummary = 'B'.repeat(500)
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom">
      <entry>
        <title>${longTitle}</title>
        <link href="https://x" rel="alternate"/>
        <summary type="html">${longSummary}</summary>
      </entry>
    </feed>`
    const tool = createListRedditTool({
      fetcher: async () => new Response(xml, { status: 200 }),
      appender: async () => {},
    })
    const result = await tool.execute({ subreddit: 'technology', sort: 'hot', limit: 10 }, makeCtx())
    const line = result.content.split('\n').find((l) => l.startsWith('- '))!
    const aRun = line.match(/A+/)?.[0] ?? ''
    assert.ok(aRun.length <= 80, `title not clipped (got ${aRun.length})`)
    const bRun = line.match(/B+/)?.[0] ?? ''
    assert.ok(bRun.length <= 120, `summary not clipped (got ${bRun.length})`)
  })

  test('HTTP 404 → returns ok content with HTTP error tag', async () => {
    const writes: string[] = []
    const tool = createListRedditTool({
      fetcher: async () => new Response('not found', { status: 404 }),
      appender: async (_p, line) => {
        writes.push(line)
      },
    })
    const result = await tool.execute({ subreddit: 'technology', sort: 'hot', limit: 10 }, makeCtx())
    assert.match(result.content, /HTTP 404/)
    const logged = JSON.parse(writes[0]!.trim())
    assert.equal(logged.errorKind, 'http_404')
  })

  test('network error → status -1 / network_error', async () => {
    const writes: string[] = []
    const tool = createListRedditTool({
      fetcher: async () => {
        throw new Error('ENOTFOUND')
      },
      appender: async (_p, line) => {
        writes.push(line)
      },
    })
    const result = await tool.execute({ subreddit: 'ClaudeAI', sort: 'hot', limit: 10 }, makeCtx())
    assert.match(result.content, /失败/)
    const logged = JSON.parse(writes[0]!.trim())
    assert.equal(logged.status, -1)
    assert.equal(logged.errorKind, 'network_error')
  })

  test('timeout via AbortController', async () => {
    const writes: string[] = []
    const tool = createListRedditTool({
      timeoutMs: 5,
      fetcher: async (_url, init) => {
        return new Promise((_resolve, reject) => {
          const signal = (init as RequestInit | undefined)?.signal
          signal?.addEventListener('abort', () => {
            const err = new Error('aborted')
            err.name = 'AbortError'
            reject(err)
          })
        })
      },
      appender: async (_p, line) => {
        writes.push(line)
      },
    })
    const result = await tool.execute({ subreddit: 'OpenAI', sort: 'hot', limit: 10 }, makeCtx())
    assert.match(result.content, /timeout/)
    const logged = JSON.parse(writes[0]!.trim())
    assert.equal(logged.errorKind, 'timeout')
  })

  test('User-Agent header is set explicitly', async () => {
    let capturedUA = ''
    const tool = createListRedditTool({
      userAgent: 'qq-bot-v2/test-suite',
      fetcher: async (_url, init) => {
        const headers = (init as RequestInit | undefined)?.headers as Record<string, string> | undefined
        capturedUA = headers?.['user-agent'] ?? ''
        return new Response(SAMPLE_ATOM, { status: 200 })
      },
      appender: async () => {},
    })
    await tool.execute({ subreddit: 'wallstreetbets', sort: 'hot', limit: 10 }, makeCtx())
    assert.equal(capturedUA, 'qq-bot-v2/test-suite')
  })

  test('rejects non-whitelisted subreddit via zod', () => {
    const tool = createListRedditTool({ fetcher: async () => new Response('', { status: 200 }) })
    assert.equal(tool.schema.safeParse({ subreddit: 'programming', sort: 'hot' }).success, false)
    assert.equal(tool.schema.safeParse({ subreddit: 'rust', sort: 'hot' }).success, false)
    assert.equal(tool.schema.safeParse({ subreddit: 'has spaces', sort: 'hot' }).success, false)
  })

  test('accepts whitelisted subreddits via zod', () => {
    const tool = createListRedditTool({ fetcher: async () => new Response('', { status: 200 }) })
    assert.equal(tool.schema.safeParse({ subreddit: 'technology' }).success, true)
    assert.equal(tool.schema.safeParse({ subreddit: 'ClaudeAI' }).success, true)
    assert.equal(tool.schema.safeParse({ subreddit: 'OpenAI' }).success, true)
    assert.equal(tool.schema.safeParse({ subreddit: 'wallstreetbets' }).success, true)
  })
})
