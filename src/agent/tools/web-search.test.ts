import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import * as webSearchModule from './web-search.js'
import type { ToolContext } from '../tool.js'

const moduleApi = webSearchModule as unknown as {
  formatWebSearchResults?: (results: Array<{ title: string; url: string; content: string }>) => string
  createWebSearchTool?: (deps: {
    search: (query: string, maxResults: number) => Promise<Array<{ title: string; url: string; content: string }>>
  }) => {
    execute: (args: { query: string; maxResults?: number }, ctx: ToolContext) => Promise<{
      content: string
      outcome?: { ok: boolean; code?: string; error?: string }
    }>
  }
}

describe('web_search structured results', () => {
  test('keeps oversized search results as bounded valid JSON', () => {
    assert.equal(typeof moduleApi.formatWebSearchResults, 'function')
    const content = moduleApi.formatWebSearchResults!(Array.from({ length: 10 }, (_, index) => ({
      title: `title-${index}-${'t'.repeat(500)}`,
      url: `https://example.com/${index}/${'u'.repeat(500)}`,
      content: `snippet-${index}-${'s'.repeat(2_000)}`,
    })))

    assert.ok(content.length <= 2_000)
    const payload = JSON.parse(content)
    assert.equal(payload.ok, true)
    assert.equal(payload.source, 'web_search')
    assert.equal(payload.truncated, true)
    assert.ok(payload.results.length > 0)
    assert.equal(typeof payload.results[0].url, 'string')
  })

  test('returns structured failure content and runtime outcome', async () => {
    assert.equal(typeof moduleApi.createWebSearchTool, 'function')
    const tool = moduleApi.createWebSearchTool!({
      async search() {
        throw new Error('provider unavailable')
      },
    })

    const result = await tool.execute({ query: 'test' }, undefined as never)
    const payload = JSON.parse(result.content)

    assert.deepEqual(payload, {
      ok: false,
      source: 'web_search',
      code: 'search_failed',
      error: '搜索失败: provider unavailable',
    })
    assert.deepEqual(result.outcome, {
      ok: false,
      code: 'search_failed',
      error: '搜索失败: provider unavailable',
    })
  })
})
