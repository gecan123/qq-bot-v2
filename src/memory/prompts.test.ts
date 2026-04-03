import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { buildGroupSummaryPrompt, buildUserProfilePrompt } from './prompts.js'

describe('buildGroupSummaryPrompt', () => {
  test('includes old summary when present', () => {
    const prompt = buildGroupSummaryPrompt('旧摘要内容', '消息内容')
    assert.ok(prompt.includes('旧摘要内容'))
    assert.ok(prompt.includes('消息内容'))
  })

  test('handles null old summary gracefully', () => {
    const prompt = buildGroupSummaryPrompt(null, '消息内容')
    assert.ok(prompt.includes('消息内容'))
    assert.ok(!prompt.includes('null'))
  })

  test('includes schema-oriented guidance for structured history', () => {
    const prompt = buildGroupSummaryPrompt(
      JSON.stringify({
        summary: '旧摘要',
        topics: ['旧话题'],
        activePatterns: ['晚上活跃'],
        styleTags: ['热闹'],
      }),
      '消息内容',
    )
    assert.ok(prompt.includes('旧摘要'))
    assert.ok(prompt.toLowerCase().includes('json'))
    assert.ok(prompt.includes('topics'))
  })
})

describe('buildUserProfilePrompt', () => {
  test('includes old profile and examples when present', () => {
    const prompt = buildUserProfilePrompt('旧画像', ['例句1', '例句2'], '用户消息')
    assert.ok(prompt.includes('旧画像'))
    assert.ok(prompt.includes('例句1'))
    assert.ok(prompt.includes('用户消息'))
  })

  test('handles null old profile gracefully', () => {
    const prompt = buildUserProfilePrompt(null, [], '用户消息')
    assert.ok(prompt.includes('用户消息'))
    assert.ok(!prompt.includes('null'))
  })

  test('requests JSON output', () => {
    const prompt = buildUserProfilePrompt(null, [], '消息')
    assert.ok(prompt.toLowerCase().includes('json'))
  })

  test('includes structured old profile context when profile is stored as json string', () => {
    const prompt = buildUserProfilePrompt(
      JSON.stringify({
        profile: '旧画像',
        traits: ['直接'],
        interests: ['聚餐'],
        speakingStyle: ['短句'],
        examples: ['旧例句'],
      }),
      [],
      '消息',
    )
    assert.ok(prompt.includes('旧画像'))
    assert.ok(prompt.includes('traits'))
    assert.ok(prompt.includes('旧例句'))
  })
})
