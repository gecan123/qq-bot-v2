import type OpenAI from 'openai'
import { agentClient, agentModel } from '../../agent/runtime.js'
import { loadPrompt } from '../../config/prompt-loader.js'
import { createLogger } from '../../logger.js'
import type { JudgeResult } from './types.js'

const JUDGE_PROMPT = loadPrompt('./prompts/proactive-judge.md')
const log = createLogger('PROACTIVE_JUDGE')

export async function judgeProactive(recentMessagesText: string, persona: string): Promise<JudgeResult> {
  const systemPrompt = [
    JUDGE_PROMPT,
    '',
    '[你的人设摘要]',
    persona.slice(0, 500),
  ].join('\n')

  try {
    const response = await agentClient.chat.completions.create({
      model: agentModel,
      temperature: 0.3,
      reasoning_effort: 'low' as OpenAI.Chat.ChatCompletionReasoningEffort,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: recentMessagesText },
      ],
      response_format: { type: 'json_object' },
    })

    const content = response.choices[0]?.message?.content?.trim()
    if (!content) return { shouldReply: false }

    const parsed = JSON.parse(content) as Record<string, unknown>
    const shouldReply = parsed.shouldReply === true
    const topic = typeof parsed.topic === 'string' ? parsed.topic : undefined

    log.info({ shouldReply, topic }, 'proactive_judge_result')
    return { shouldReply, topic }
  } catch (error) {
    log.error({ error }, 'proactive judge 调用失败')
    return { shouldReply: false }
  }
}
