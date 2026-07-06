import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  createGetRedditPostTool,
  toRedditPostRssUrl,
  parseRedditPostRss,
} from './get-post.js'
import { InMemoryEventQueue } from '../../event-queue.js'
import type { BotEvent } from '../../event.js'
import type { ToolContext } from '../../tool.js'

function makeCtx(): ToolContext {
  return { eventQueue: new InMemoryEventQueue<BotEvent>(), roundIndex: 1 }
}

const SAMPLE_POST_RSS = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Rust 1.99 released with great new things</title>
  <entry>
    <title>/u/alice on Rust 1.99 released</title>
    <content type="html">&lt;p&gt;Love the async closures! This is a game changer.&lt;/p&gt;</content>
    <author><name>/u/alice</name></author>
    <link href="https://www.reddit.com/r/programming/comments/abc1/rust_1_99/comment1/" rel="alternate"/>
  </entry>
  <entry>
    <title>/u/bob on Rust 1.99 released</title>
    <content type="html">&lt;p&gt;Any benchmarks yet? Would love to see perf comparison.&lt;/p&gt;</content>
    <author><name>/u/bob</name></author>
    <link href="https://www.reddit.com/r/programming/comments/abc1/rust_1_99/comment2/" rel="alternate"/>
  </entry>
  <entry>
    <title>/u/charlie on Rust 1.99 released</title>
    <content type="html">&lt;p&gt;The diagnostics improvements alone make it worth upgrading.&lt;/p&gt;</content>
    <author><name>/u/charlie</name></author>
    <link href="https://www.reddit.com/r/programming/comments/abc1/rust_1_99/comment3/" rel="alternate"/>
  </entry>
</feed>`

describe('toRedditPostRssUrl', () => {
  test('appends .rss to clean permalink', () => {
    assert.equal(
      toRedditPostRssUrl('https://www.reddit.com/r/programming/comments/abc1/rust_1_99/'),
      'https://www.reddit.com/r/programming/comments/abc1/rust_1_99.rss',
    )
  })
  test('strips query and hash', () => {
    assert.equal(
      toRedditPostRssUrl('https://www.reddit.com/r/rust/comments/xyz/post/?ref=share#top'),
      'https://www.reddit.com/r/rust/comments/xyz/post.rss',
    )
  })
  test('handles no trailing slash', () => {
    assert.equal(
      toRedditPostRssUrl('https://www.reddit.com/r/rust/comments/xyz/post'),
      'https://www.reddit.com/r/rust/comments/xyz/post.rss',
    )
  })
  test('old.reddit.com works', () => {
    assert.equal(
      toRedditPostRssUrl('https://old.reddit.com/r/rust/comments/xyz/post/'),
      'https://old.reddit.com/r/rust/comments/xyz/post.rss',
    )
  })
})

describe('parseRedditPostRss', () => {
  test('extracts post title + comments from valid RSS', () => {
    const detail = parseRedditPostRss(SAMPLE_POST_RSS)
    assert.ok(detail)
    assert.equal(detail.title, 'Rust 1.99 released with great new things')
    assert.equal(detail.comments.length, 3)
    assert.equal(detail.comments[0]!.author, '/u/alice')
    assert.match(detail.comments[0]!.body, /async closures/)
    assert.equal(detail.comments[1]!.author, '/u/bob')
    assert.match(detail.comments[1]!.body, /benchmarks/)
  })

  test('no comments → empty array', () => {
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom">
      <title>Empty post</title>
    </feed>`
    const detail = parseRedditPostRss(xml)
    assert.ok(detail)
    assert.equal(detail.comments.length, 0)
  })

  test('extracts post image URL from t3 entry and skips it from comments', () => {
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/">
      <title>Meme title</title>
      <entry>
        <id>t3_abc</id>
        <content type="html">&lt;table&gt;&lt;tr&gt;&lt;td&gt;&lt;img src=&quot;https://preview.redd.it/abc.png?width=320&amp;amp;crop=smart&quot; /&gt;&lt;/td&gt;&lt;td&gt;&lt;a href=&quot;https://i.redd.it/abc.png&quot;&gt;[link]&lt;/a&gt;&lt;/td&gt;&lt;/tr&gt;&lt;/table&gt;</content>
        <media:thumbnail url="https://preview.redd.it/abc.png?width=320&amp;crop=smart" />
        <author><name>/u/poster</name></author>
      </entry>
      <entry>
        <id>t1_comment</id>
        <content type="html">&lt;p&gt;actual comment&lt;/p&gt;</content>
        <author><name>/u/commenter</name></author>
      </entry>
    </feed>`
    const detail = parseRedditPostRss(xml)
    assert.ok(detail)
    assert.equal(detail.imageUrl, 'https://i.redd.it/abc.png')
    assert.equal(detail.comments.length, 1)
    assert.equal(detail.comments[0]!.author, '/u/commenter')
    assert.match(detail.comments[0]!.body, /actual comment/)
  })

  test('returns null for malformed input', () => {
    assert.equal(parseRedditPostRss('<feed/>'), null)
    assert.equal(parseRedditPostRss('<feed xmlns="http://www.w3.org/2005/Atom"></feed>'), null)
  })

  test('caps at TOP_N_COMMENTS (5)', () => {
    const entries = Array.from({ length: 10 }, (_, i) =>
      `<entry>
        <content type="html">comment ${i}</content>
        <author><name>/u/user${i}</name></author>
      </entry>`,
    ).join('\n')
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom">
      <title>Many comments</title>
      ${entries}
    </feed>`
    const detail = parseRedditPostRss(xml)
    assert.ok(detail)
    assert.equal(detail.comments.length, 5)
  })
})

describe('get_reddit_post tool', () => {
  test('happy path: 200 + valid RSS → structured output + NDJSON line', async () => {
    const writes: string[] = []
    const tool = createGetRedditPostTool({
      fetcher: async () => new Response(SAMPLE_POST_RSS, { status: 200 }),
      appender: async (_p, line) => { writes.push(line) },
      logPath: '/tmp/test-get-post.ndjson',
    })
    const result = await tool.execute(
      { url: 'https://www.reddit.com/r/programming/comments/abc1/rust_1_99/' },
      makeCtx(),
    )
    const payload = JSON.parse(result.content as string)
    assert.equal(payload.ok, true)
    assert.equal(payload.source, 'reddit_post')
    assert.equal(payload.title, 'Rust 1.99 released with great new things')
    assert.equal(payload.comments.length, 3)
    assert.equal(payload.comments[0].author, '/u/alice')
    assert.match(payload.comments[0].body, /async closures/)
    assert.deepEqual(result.outcome, { ok: true })
    assert.equal(writes.length, 1)
    const logged = JSON.parse(writes[0]!.trim())
    assert.equal(logged.source, 'reddit_post')
    assert.equal(logged.status, 200)
  })

  test('comment body is clipped at 200 chars', async () => {
    const longComment = 'Y'.repeat(500)
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom">
      <title>T</title>
      <entry>
        <content type="html">${longComment}</content>
        <author><name>/u/c</name></author>
      </entry>
    </feed>`
    const tool = createGetRedditPostTool({
      fetcher: async () => new Response(xml, { status: 200 }),
      appender: async () => {},
    })
    const result = await tool.execute(
      { url: 'https://www.reddit.com/r/test/comments/z/t/' },
      makeCtx(),
    )
    const payload = JSON.parse(result.content as string)
    assert.ok(payload.comments[0].body.length <= 200)
    assert.equal(payload.truncated, true)
  })

  test('total output clamped at 2000 chars', async () => {
    const entries = Array.from({ length: 5 }, (_, i) =>
      `<entry>
        <content type="html">${'W'.repeat(200)}</content>
        <author><name>/u/u${i}</name></author>
      </entry>`,
    ).join('\n')
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom">
      <title>T</title>
      ${entries}
    </feed>`
    const tool = createGetRedditPostTool({
      fetcher: async () => new Response(xml, { status: 200 }),
      appender: async () => {},
    })
    const result = await tool.execute(
      { url: 'https://www.reddit.com/r/test/comments/z/t/' },
      makeCtx(),
    )
    assert.ok((result.content as string).length <= 2000, `output too long (${(result.content as string).length})`)
    JSON.parse(result.content as string)
  })

  test('HTTP 404 → error content, not throw', async () => {
    const writes: string[] = []
    const tool = createGetRedditPostTool({
      fetcher: async () => new Response('not found', { status: 404 }),
      appender: async (_p, line) => { writes.push(line) },
    })
    const result = await tool.execute(
      { url: 'https://www.reddit.com/r/test/comments/deleted/x/' },
      makeCtx(),
    )
    const payload = JSON.parse(result.content as string)
    assert.equal(payload.code, 'http_error')
    assert.equal(payload.status, 404)
    assert.deepEqual(result.outcome, { ok: false, code: 'http_error' })
    const logged = JSON.parse(writes[0]!.trim())
    assert.equal(logged.errorKind, 'http_404')
  })

  test('rejects non-reddit URL via zod', () => {
    const tool = createGetRedditPostTool({ fetcher: async () => new Response('', { status: 200 }) })
    assert.equal(tool.schema.safeParse({ url: 'https://example.com/foo' }).success, false)
    assert.equal(tool.schema.safeParse({ url: 'https://reddit.com/r/foo' }).success, false, 'no /comments/')
  })

  test('accepts old.reddit.com URL via zod', () => {
    const tool = createGetRedditPostTool({ fetcher: async () => new Response('', { status: 200 }) })
    assert.equal(
      tool.schema.safeParse({ url: 'https://old.reddit.com/r/rust/comments/abc/post/' }).success,
      true,
    )
  })

  test('network error → status -1', async () => {
    const writes: string[] = []
    const tool = createGetRedditPostTool({
      fetcher: async () => { throw new Error('ENOTFOUND') },
      appender: async (_p, line) => { writes.push(line) },
    })
    const result = await tool.execute(
      { url: 'https://www.reddit.com/r/test/comments/z/t/' },
      makeCtx(),
    )
    const payload = JSON.parse(result.content as string)
    assert.equal(payload.code, 'network_error')
    assert.deepEqual(result.outcome, { ok: false, code: 'network_error' })
    const logged = JSON.parse(writes[0]!.trim())
    assert.equal(logged.errorKind, 'network_error')
  })
})
