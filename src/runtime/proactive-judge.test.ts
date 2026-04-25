import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  createProactiveJudge,
  normalizeProactiveJudgeResult,
  parseProactiveJudgeContent,
  type ProactiveJudgePolicy,
} from './proactive-judge.js'

const policy: ProactiveJudgePolicy = {
  enabled: true,
  timeoutMs: 50,
  maxCallsPerHour: 10,
  minConfidence: 0.6,
  minUsefulness: 0.6,
  minNovelty: 0.3,
  maxInterruptionCost: 0.4,
  maxSocialRisk: 0.3,
  maxSuggestedDelayMs: 300_000,
}

describe('proactive judge', () => {
  test('normalizes valid structured output and clamps score fields', () => {
    const advice = normalizeProactiveJudgeResult({
      shouldSpeak: true,
      usefulness: 2,
      novelty: -1,
      confidence: 0.8,
      interruptionCost: 0.2,
      socialRisk: 9,
      suggestedDelayMs: 400_000,
      reason: 'x'.repeat(400),
    }, policy)

    assert.equal(advice.status, 'valid')
    assert.equal(advice.shouldSpeak, true)
    assert.equal(advice.usefulness, 1)
    assert.equal(advice.novelty, 0)
    assert.equal(advice.socialRisk, 1)
    assert.equal(advice.suggestedDelayMs, 300_000)
    assert.equal(advice.reason.length, 280)
  })

  test('malformed schema, invalid json, and bad delay fail closed', () => {
    const malformed = normalizeProactiveJudgeResult({ shouldSpeak: true }, policy)
    const invalidJson = parseProactiveJudgeContent('{not json', policy)
    const badDelay = normalizeProactiveJudgeResult({
      shouldSpeak: true,
      usefulness: 0.8,
      novelty: 0.7,
      confidence: 0.9,
      interruptionCost: 0.1,
      socialRisk: 0.1,
      suggestedDelayMs: -1,
      reason: 'bad delay',
    }, policy)

    assert.equal(malformed.status, 'invalid')
    assert.equal(malformed.shouldSpeak, false)
    assert.equal(invalidJson.status, 'invalid')
    assert.equal(badDelay.status, 'invalid')
  })

  test('parses fenced and repaired json responses', () => {
    const advice = parseProactiveJudgeContent(`\`\`\`json
{
  shouldSpeak: true,
  usefulness: 0.7,
  novelty: 0.6,
  confidence: 0.8,
  interruptionCost: 0.1,
  socialRisk: 0.1,
  reason: "有锚点",
}
\`\`\``, policy)

    assert.equal(advice.status, 'valid')
    assert.equal(advice.reason, '有锚点')
  })

  test('disabled judge fails closed without calling the client', async () => {
    let calls = 0
    const judge = createProactiveJudge({
      policy: { ...policy, enabled: false },
      client: {
        create: async () => {
          calls++
          throw new Error('should not call client')
        },
      } as any,
      model: 'test-model',
    })

    const advice = await judge.evaluate({
      groupId: 1,
      messageRowId: 42,
      senderId: 20,
      senderNickname: '用户20',
      segments: [{ type: 'text', content: '怎么处理这个？' }],
      createdAt: new Date('2026-04-24T00:00:00Z'),
      replyProbability: 0.1,
    })

    assert.equal(calls, 0)
    assert.equal(advice.status, 'disabled')
    assert.equal(advice.shouldSpeak, false)
  })

  test('timeout and empty response fail closed', async () => {
    const timeoutJudge = createProactiveJudge({
      policy: { ...policy, timeoutMs: 1 },
      client: { create: async () => new Promise(() => undefined) } as any,
      model: 'test-model',
    })
    const emptyJudge = createProactiveJudge({
      policy,
      client: { create: async () => ({ choices: [{ message: { content: '' } }] }) } as any,
      model: 'test-model',
    })
    const input = {
      groupId: 1,
      messageRowId: 42,
      senderId: 20,
      senderNickname: '用户20',
      segments: [{ type: 'text' as const, content: '怎么处理这个？' }],
      createdAt: new Date('2026-04-24T00:00:00Z'),
      replyProbability: 0.1,
    }

    assert.equal((await timeoutJudge.evaluate(input)).status, 'timeout')
    assert.equal((await emptyJudge.evaluate(input)).status, 'invalid')
  })

  test('sends strict json-only judge request without candidate reply text', async () => {
    let request: any
    const judge = createProactiveJudge({
      policy,
      client: {
        create: async (input: any) => {
          request = input
          return {
            choices: [{
              message: {
                content: JSON.stringify({
                  shouldSpeak: true,
                  usefulness: 0.8,
                  novelty: 0.7,
                  confidence: 0.9,
                  interruptionCost: 0.1,
                  socialRisk: 0.1,
                  reason: '有锚点',
                }),
              },
            }],
          }
        },
      } as any,
      model: 'test-model',
    })

    const advice = await judge.evaluate({
      groupId: 1,
      messageRowId: 42,
      senderId: 20,
      senderNickname: '用户20',
      segments: [{ type: 'text', content: '有人知道这个怎么处理吗？' }],
      recentMessages: [{
        messageRowId: 41,
        senderId: 19,
        content: '[QQ消息]\n用户19: hello',
        createdAt: '2026-04-24T00:00:00.000Z',
      }],
      createdAt: new Date('2026-04-24T00:00:00Z'),
      replyProbability: 0.1,
    })

    const userPayload = JSON.parse(request.messages[1].content)
    assert.equal(advice.status, 'valid')
    assert.equal(request.model, 'test-model')
    assert.equal(request.response_format.type, 'json_schema')
    assert.equal(request.response_format.json_schema.name, 'proactive_judge')
    assert.match(request.messages[0].content, /不要输出候选回复文本/)
    assert.deepEqual(userPayload.recentMessages, [{
      messageRowId: 41,
      senderId: 19,
      content: '[QQ消息]\n用户19: hello',
      createdAt: '2026-04-24T00:00:00.000Z',
    }])
  })
})
