import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { AgentGoal } from './goal-store.js'
import type { LlmCallInput, LlmCallOutput } from './llm-client.js'
import { createGoalCompletionJudge } from './goal-completion-judge.js'

describe('GoalCompletionJudge', () => {
  test('sends only the current goal window with no tools and parses acceptance', async () => {
    const requests: LlmCallInput[] = []
    const goal = makeGoal('11111111-1111-4111-8111-111111111111')
    const judge = createGoalCompletionJudge({
      llm: {
        async chat(input) {
          requests.push(input)
          return output('{"ok":true,"reason":"测试输出显示全部通过"}')
        },
      },
      getMessages: () => [
        { role: 'user', content: 'older unrelated history' },
        {
          role: 'user',
          content: JSON.stringify({ event: 'goal_state_changed', goal: { goalId: goal.goalId } }),
        },
        { role: 'tool', toolCallId: 'test-1', content: 'All tests passed' },
      ],
    })

    assert.deepEqual(await judge.evaluate({ goal, evidence: ['pnpm test exit 0'] }), {
      ok: true,
      reason: '测试输出显示全部通过',
    })
    assert.deepEqual(requests[0]?.tools, [])
    assert.doesNotMatch(userMessageContent(requests[0], 0), /older unrelated history/)
    assert.match(userMessageContent(requests[0], 0), /All tests passed/)
  })

  test('uses the complete projection when the goal marker is absent and parses rejection', async () => {
    const requests: LlmCallInput[] = []
    const goal = makeGoal('22222222-2222-4222-8222-222222222222')
    const judge = createGoalCompletionJudge({
      llm: {
        async chat(input) {
          requests.push(input)
          return output('{"ok":false,"reason":"缺少仓库级测试输出"}')
        },
      },
      getMessages: () => [
        { role: 'user', content: 'old but canonical evidence' },
        { role: 'tool', toolCallId: 'test-2', content: 'focused tests passed' },
      ],
    })

    assert.deepEqual(await judge.evaluate({ goal, evidence: ['focused tests passed'] }), {
      ok: false,
      reason: '缺少仓库级测试输出',
    })
    assert.match(userMessageContent(requests[0], 0), /old but canonical evidence/)
    assert.match(userMessageContent(requests[0], 1), new RegExp(goal.goalId))
  })

  test('rejects markdown fences, malformed JSON and empty reasons', async (t) => {
    const invalidResponses = [
      ['markdown fences', '```json\n{"ok":true,"reason":"done"}\n```'],
      ['malformed JSON', '{"ok":true'],
      ['empty reason', '{"ok":true,"reason":"   "}'],
    ] as const

    for (const [name, content] of invalidResponses) {
      await t.test(name, async () => {
        const goal = makeGoal('33333333-3333-4333-8333-333333333333')
        const judge = createGoalCompletionJudge({
          llm: { async chat() { return output(content) } },
          getMessages: () => [{ role: 'user', content: 'canonical evidence' }],
        })

        await assert.rejects(judge.evaluate({ goal, evidence: ['submitted evidence'] }))
      })
    }
  })
})

function makeGoal(goalId: string): AgentGoal {
  const now = new Date('2026-07-21T00:00:00.000Z')
  return {
    goalId,
    objective: '完成 Goal 完成验收实现并通过测试',
    origin: 'owner',
    motivation: null,
    completionCriteria: [],
    currentCommitment: null,
    status: 'active',
    tokenBudget: null,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    roundsUsed: 0,
    revision: 1,
    sourceMessageRowId: 1,
    lastControlMessageRowId: 1,
    blockerKey: null,
    blockerTurns: 0,
    lastBlockerRound: null,
    blockedReason: null,
    completionEvidence: null,
    selfGoalWindowStartedAt: null,
    selfGoalWindowCount: 0,
    lastSelfGoalCreatedAt: null,
    createdAt: now,
    updatedAt: now,
  }
}

function output(content: string): LlmCallOutput {
  return {
    content,
    toolCalls: [],
    usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 5 },
    model: 'mock',
    contextWindowTokens: 200_000,
    stopReason: 'end_turn',
  }
}

function userMessageContent(input: LlmCallInput | undefined, index: number): string {
  const message = input?.messages[index]
  assert.equal(message?.role, 'user')
  return message.content
}
