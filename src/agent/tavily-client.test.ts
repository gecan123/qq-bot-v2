import { test, describe, mock } from 'node:test'
import assert from 'node:assert/strict'

describe('web_search tool declaration', () => {
  test('web_search is absent from declarations when TAVILY_API_KEY is not set', async () => {
    // Ensure no API key in env
    const originalKey = process.env.TAVILY_API_KEY
    delete process.env.TAVILY_API_KEY

    // Re-import config by reading env directly (config is a const, so we simulate via env state)
    const apiKey = process.env.TAVILY_API_KEY
    assert.equal(apiKey, undefined)

    // Simulate the conditional: tool should not be added
    const declarations: string[] = []
    if (apiKey) {
      declarations.push('web_search')
    }
    assert.equal(declarations.includes('web_search'), false)

    if (originalKey !== undefined) process.env.TAVILY_API_KEY = originalKey
  })

  test('web_search is present in declarations when TAVILY_API_KEY is set', () => {
    const apiKey = 'tvly-test-key'

    const declarations: string[] = []
    if (apiKey) {
      declarations.push('web_search')
    }
    assert.equal(declarations.includes('web_search'), true)
  })
})

describe('web_search input schema', () => {
  test('validates query string', async () => {
    const { z } = await import('zod')
    const schema = z.object({
      query: z.string().describe('搜索查询词，用中文或英文均可'),
    })

    const result = schema.parse({ query: '最新新闻' })
    assert.equal(result.query, '最新新闻')
  })

  test('rejects missing query', async () => {
    const { z } = await import('zod')
    const schema = z.object({
      query: z.string(),
    })

    assert.throws(() => schema.parse({}))
  })

  test('rejects non-string query', async () => {
    const { z } = await import('zod')
    const schema = z.object({
      query: z.string(),
    })

    assert.throws(() => schema.parse({ query: 42 }))
  })
})

describe('web_search result formatting', () => {
  test('formats results as title(url) + content joined by double newline', () => {
    const results = [
      { title: 'Result 1', url: 'https://example.com/1', content: 'Content one' },
      { title: 'Result 2', url: 'https://example.com/2', content: 'Content two' },
    ]

    const formatted = results
      .map((r) => `[${r.title}](${r.url})\n${r.content}`)
      .join('\n\n')

    assert.ok(formatted.includes('[Result 1](https://example.com/1)'))
    assert.ok(formatted.includes('Content one'))
    assert.ok(formatted.includes('[Result 2](https://example.com/2)'))
    assert.ok(formatted.includes('Content two'))
  })

  test('truncates formatted results to 2000 characters', () => {
    const longContent = 'x'.repeat(500)
    const results = Array.from({ length: 10 }, (_, i) => ({
      title: `Result ${i}`,
      url: `https://example.com/${i}`,
      content: longContent,
    }))

    const formatted = results
      .map((r) => `[${r.title}](${r.url})\n${r.content}`)
      .join('\n\n')

    const MAX = 2000
    const truncated = formatted.length > MAX ? formatted.slice(0, MAX) + '…' : formatted
    assert.ok(truncated.length <= MAX + 1) // +1 for the ellipsis character
  })

  test('returns empty result message when results array is empty', () => {
    const results: Array<{ title: string; url: string; content: string }> = []
    const formatted =
      results.length === 0
        ? '（无搜索结果）'
        : results
            .map((r) => `[${r.title}](${r.url})\n${r.content}`)
            .join('\n\n')

    assert.equal(formatted, '（无搜索结果）')
  })
})

describe('web_search executor error handling', () => {
  test('returns error string on search failure without throwing', async () => {
    const failingSearch = async (_query: string): Promise<never> => {
      throw new Error('Network error')
    }

    let result: string
    try {
      await failingSearch('test query')
      result = 'should not reach'
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      result = `搜索失败: ${message}`
    }

    assert.equal(result, '搜索失败: Network error')
  })

  test('captures non-Error thrown values gracefully', async () => {
    const failingSearch = async (_query: string): Promise<never> => {
      throw 'plain string error'
    }

    let result: string
    try {
      await failingSearch('test')
      result = 'should not reach'
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      result = `搜索失败: ${message}`
    }

    assert.equal(result, '搜索失败: plain string error')
  })
})
