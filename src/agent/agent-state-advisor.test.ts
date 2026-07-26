import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { LlmCallInput, LlmCallOutput } from './llm-client.js'
import {
  createAgentStateAdvisor,
  renderAgentStateAdvice,
} from './agent-state-advisor.js'

describe('AgentStateAdvisor', () => {
  test('uses a bounded recent transcript with no tools and parses a concrete thought', async () => {
    const requests: LlmCallInput[] = []
    const advisor = createAgentStateAdvisor({
      llm: {
        async chat(input) {
          requests.push(input)
          return output(JSON.stringify({
            state: 'directionless',
            reason: '近期确实留下了一个具体文章线索',
            thought: '我想重新打开那篇文章，只确认作者对长期记忆边界的定义。',
          }))
        },
      },
      systemPrompt: 'main agent prompt',
      getMessages: () => Array.from({ length: 65 }, (_, index) => ({
        role: 'user' as const,
        content: `真实线索 ${index}`,
      })),
    })

    assert.deepEqual(await advisor.evaluate({ consecutiveIdleRounds: 3 }), {
      state: 'directionless',
      reason: '近期确实留下了一个具体文章线索',
      thought: '我想重新打开那篇文章，只确认作者对长期记忆边界的定义。',
    })

    const request = requests[0]
    assert.deepEqual(request?.tools, [])
    assert.equal(request?.maxOutputTokens, 300)
    assert.match(request?.systemPrompt ?? '', /只读状态顾问/)
    assert.match(userMessageContent(request, 0), /真实线索 64/)
    assert.doesNotMatch(userMessageContent(request, 0), /真实线索 0(?:\\D|$)/)
    assert.match(userMessageContent(request, 1), /"consecutiveIdleRounds":3/)
  })

  test('renders thought and anxiety advice as controlled non-task events', () => {
    const thought = JSON.parse(renderAgentStateAdvice({
      state: 'directionless',
      reason: '有一个真实线索',
      thought: '我想确认那份设计稿里尚未回答的问题。',
    })) as Record<string, unknown>
    assert.equal(thought.event, 'agent_state_advice')
    assert.equal(thought.innerThought, '我想确认那份设计稿里尚未回答的问题。')
    assert.match(String(thought.guidance), /不是任务/)

    const anxiety = JSON.parse(renderAgentStateAdvice({
      state: 'anxiety_loop',
      reason: '正在重复读取同一份内容',
      nextStep: '停止重复读取，等待新的外部证据。',
    })) as Record<string, unknown>
    assert.equal(anxiety.nextStep, '停止重复读取，等待新的外部证据。')
    assert.match(String(anxiety.guidance), /停止重复/)
  })

  test('rejects malformed or embellished advisor output', async () => {
    const advisor = createAgentStateAdvisor({
      llm: {
        async chat() {
          return output('```json\n{"state":"healthy_rest","reason":"没有牵引力"}\n```')
        },
      },
      systemPrompt: '',
      getMessages: () => [{ role: 'user', content: '近期上下文' }],
    })

    await assert.rejects(advisor.evaluate({ consecutiveIdleRounds: 3 }))
  })
})

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
