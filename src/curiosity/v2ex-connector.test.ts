import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildV2exFeedUrl,
  extractV2exPostDetail,
  parseV2exFeedTarget,
  parseV2exFeedTargets,
  parseV2exRssItems,
  pollV2exFeed,
  scoreV2exTitleInterest,
  V2exRssConnector,
} from './v2ex-connector.js'
import type { ForumReadInput, ForumReadResult } from './forum-read-executor.js'

const sampleRss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>V2EX</title>
    <item>
      <title>测试帖子</title>
      <link>https://www.v2ex.com/t/123</link>
      <guid>https://www.v2ex.com/t/123</guid>
      <author>alice</author>
      <description><![CDATA[<p>source fact only</p>]]></description>
      <pubDate>Wed, 29 Apr 2026 12:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>`

const sampleTopicHtml = `<!doctype html>
<html>
  <body>
    <h1>测试帖子详情标题</h1>
    <div class="topic_content markdown_body"><p>主帖正文，包含完整讨论背景。</p></div>
    <div class="reply_content">第一条回帖</div>
    <div class="reply_content">第二条回帖</div>
  </body>
</html>`

function forumReadResult(overrides: Partial<ForumReadResult> = {}): ForumReadResult {
  return {
    sceneId: 'forum:v2ex:latest',
    feedSourceId: 'feed-source-1',
    feedItemId: 'feed-item-1',
    runtimeEventId: 'event-1',
    opportunityId: 'opportunity-1',
    decisionId: 'decision-1',
    actionIntentId: 'intent-1',
    actionRecordId: 'record-1',
    readSessionId: 'read-session-1',
    sourceSummaryId: 'summary-1',
    thoughtArtifactId: 'thought-1',
    rationaleArtifactId: 'rationale-1',
    ...overrides,
  }
}

describe('V2EX RSS connector', () => {
  test('builds supported V2EX feed URLs', () => {
    assert.equal(buildV2exFeedUrl({ type: 'latest' }), 'https://www.v2ex.com/index.xml')
    assert.equal(buildV2exFeedUrl({ type: 'node', name: 'programmer' }), 'https://www.v2ex.com/feed/programmer.xml')
    assert.equal(buildV2exFeedUrl({ type: 'tab', name: 'tech' }), 'https://www.v2ex.com/feed/tab/tech.xml')
    assert.equal(buildV2exFeedUrl({ type: 'member', name: 'Livid' }), 'https://www.v2ex.com/feed/member/Livid.xml')
  })

  test('parses env-style V2EX feed targets', () => {
    assert.deepEqual(parseV2exFeedTarget('latest'), { type: 'latest' })
    assert.deepEqual(parseV2exFeedTarget('node:programmer'), { type: 'node', name: 'programmer' })
    assert.deepEqual(parseV2exFeedTarget('tab:tech'), { type: 'tab', name: 'tech' })
    assert.deepEqual(parseV2exFeedTarget('member:Livid'), { type: 'member', name: 'Livid' })
    assert.deepEqual(parseV2exFeedTargets('latest,node:programmer,tab:tech,member:Livid'), [
      { type: 'latest' },
      { type: 'node', name: 'programmer' },
      { type: 'tab', name: 'tech' },
      { type: 'member', name: 'Livid' },
    ])
  })

  test('maps RSS items into source facts for the read-only forum pipeline', () => {
    const items = parseV2exRssItems(sampleRss)

    assert.equal(items.length, 1)
    assert.equal(items[0]?.externalId, 'https://www.v2ex.com/t/123')
    assert.equal(items[0]?.url, 'https://www.v2ex.com/t/123')
    assert.equal(items[0]?.title, '测试帖子')
    assert.equal(items[0]?.author, 'alice')
    assert.equal(items[0]?.rawContent, 'source fact only')
    assert.equal(items[0]?.publishedAt?.toISOString(), '2026-04-29T12:00:00.000Z')
  })

  test('scores title interest with a minimal keyword gate', () => {
    assert.deepEqual(scoreV2exTitleInterest('Claude Code 使用体验', ['claude']), {
      interested: true,
      score: 1,
      matchedKeywords: ['claude'],
      reason: 'title matched interest keyword(s): claude',
    })
    assert.equal(scoreV2exTitleInterest('出一台显示器', ['claude']).interested, false)
    assert.equal(scoreV2exTitleInterest('随便看看', []).interested, true)
  })

  test('extracts V2EX topic body and replies from a detail page', () => {
    const detail = extractV2exPostDetail(sampleTopicHtml, 1)

    assert.equal(detail.title, '测试帖子详情标题')
    assert.equal(detail.mainText, '主帖正文，包含完整讨论背景。')
    assert.deepEqual(detail.replies, ['1. 第一条回帖'])
    assert.match(detail.rawContent ?? '', /主帖：主帖正文/)
    assert.match(detail.rawContent ?? '', /回帖摘录：/)
  })

  test('fetches V2EX RSS without adding any sender path', async () => {
    const requested: Array<{ url: string; userAgent?: string }> = []
    const connector = new V2exRssConnector({
      target: { type: 'latest' },
      interestKeywords: ['测试'],
      fetch: async (url, init) => {
        requested.push({ url, userAgent: init?.headers?.['User-Agent'] })
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          text: async () => url.endsWith('/index.xml') ? sampleRss : sampleTopicHtml,
        }
      },
    })

    const items = await connector.poll()

    assert.equal(connector.source.kind, 'v2ex')
    assert.equal(connector.source.externalId, 'latest')
    assert.equal(connector.source.config?.readOnly, true)
    assert.equal(requested[0]?.url, 'https://www.v2ex.com/index.xml')
    assert.equal(requested[1]?.url, 'https://www.v2ex.com/t/123')
    assert.match(requested[0]?.userAgent ?? '', /read-only forum connector/)
    assert.equal(items.length, 1)
    assert.match(items[0]?.rawContent ?? '', /兴趣判断/)
    assert.match(items[0]?.rawContent ?? '', /主帖正文/)
  })

  test('skips RSS items when the title is outside current interests', async () => {
    const connector = new V2exRssConnector({
      target: { type: 'latest' },
      interestKeywords: ['claude'],
      fetchDetails: true,
      fetch: async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => sampleRss,
      }),
    })

    const items = await connector.poll()

    assert.equal(items.length, 0)
  })

  test('pollV2exFeed reuses the generic forum connector ingestion path', async () => {
    const inputs: ForumReadInput[] = []
    const results = await pollV2exFeed({ type: 'node', name: 'programmer' }, {
      fetch: async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => sampleRss,
      }),
      interestKeywords: ['测试'],
      fetchDetails: false,
      readForumItem: async (input) => {
        inputs.push(input)
        return forumReadResult()
      },
      now: new Date('2026-04-29T13:00:00Z'),
    })

    assert.equal(results.length, 1)
    assert.equal(inputs.length, 1)
    assert.equal(inputs[0]?.source.kind, 'v2ex')
    assert.equal(inputs[0]?.source.externalId, 'node:programmer')
    assert.equal(inputs[0]?.selectionReason, 'read-only V2EX RSS poll from node:programmer')
    assert.equal(inputs[0]?.item.title, '测试帖子')
  })
})
