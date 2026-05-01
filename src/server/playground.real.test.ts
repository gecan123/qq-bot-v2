import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { loadPrompt } from '../config/prompt-loader.js'
import { runPlayground } from './playground.js'

const RUN_REAL_API_TESTS = process.env.RUN_REAL_API_TESTS === '1'
const realTest = RUN_REAL_API_TESTS ? test : test.skip

describe('runPlayground real api', () => {
  realTest('uses real repository prompts in system prompt while db context is mocked', { timeout: 120_000 }, async () => {
    const defaultPersona = loadPrompt('./prompts/characters/default.md')
    const replyInstruction = loadPrompt('./prompts/reply-instruction.md')

    const result = await runPlayground(
      {
        groupId: '42',
        senderId: '10001',
        senderName: 'zzz',
        message: '@Luna 你找找新闻',
      },
      {
        buildContext: async () => ({
          contextText: [
            '[12:20] zzz: @Luna 我看他在搞芯片啊',
            '[12:21] Luna: @zzz 对，他确实在往“芯片/算力”方向布局，主要围绕 AI 芯片和算力基础设施。',
          ].join('\n'),
          history: [],
          recentMessages: [],
        }),
      },
    )

    assert.equal(result.state, 'final')
    assert.match(result.llmContext.systemPrompt, /\[统一认知基座\]/)
    assert.match(result.llmContext.systemPrompt, /\[任务约束\]/)
    assert.ok(result.llmContext.systemPrompt.includes(defaultPersona))
    assert.ok(result.llmContext.systemPrompt.includes(replyInstruction))
  })

  realTest('keeps topic continuity for ambiguous follow-up request', { timeout: 120_000 }, async () => {
    const result = await runPlayground(
      {
        groupId: '42',
        senderId: '10001',
        senderName: 'zzz',
        message: '@Luna 你找找新闻',
      },
      {
        buildContext: async () => ({
          contextText: [
            '[12:20] zzz: @Luna 我看他在搞芯片啊',
            '[12:21] Luna: @zzz 对，他确实在往“芯片/算力”方向布局，主要围绕 AI 芯片和算力基础设施。',
          ].join('\n'),
          history: [],
          recentMessages: [],
        }),
      },
    )

    assert.equal(result.state, 'final')
    assert.ok(result.answer)

    const payload = (result.finalAnswerPayload ?? {}) as {
      shouldReferenceContext?: boolean
      shouldAskClarifyingQuestion?: boolean
    }

    if (payload.shouldAskClarifyingQuestion === true) return

    assert.equal(payload.shouldReferenceContext, true)
    assert.match(result.answer, /芯片|算力|AI/i)
  })
})
