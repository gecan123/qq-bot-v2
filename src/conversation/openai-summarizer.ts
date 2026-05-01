import type OpenAI from 'openai'
import { agentClient, agentModel } from '../agent/runtime.js'
import { toOpenAIMessages } from '../agent/openai-compat.js'
import { recordCurrentTokenUsage, toTokenUsage } from '../llm/token-usage.js'
import { createLogger } from '../logger.js'
import {
  SUMMARIZER_SYSTEM_PROMPT,
  buildSummarizerHistory,
  type ConversationSummarizer,
  type SummarizeInput,
} from './summarizer.js'

const log = createLogger('SUMMARIZER')

export interface CreateOpenAISummarizerOptions {
  /** 默认 agentClient (复用 agent 的 OpenAI-compatible 配置)。测试可注入 mock。 */
  client?: OpenAI
  /** 默认 agentModel。测试可注入。 */
  model?: string
  /** 默认 0.3 (摘要任务低发散)。 */
  temperature?: number
}

export function createOpenAISummarizer(options: CreateOpenAISummarizerOptions = {}): ConversationSummarizer {
  const client = options.client ?? agentClient
  const model = options.model ?? agentModel
  const temperature = options.temperature ?? 0.3

  return {
    async summarize(input: SummarizeInput): Promise<string> {
      const history = buildSummarizerHistory(input)
      const messages = toOpenAIMessages(SUMMARIZER_SYSTEM_PROMPT, history)

      const response = await client.chat.completions.create({
        model,
        temperature,
        messages,
      })
      recordCurrentTokenUsage('compaction.summarize', toTokenUsage(response.usage))

      const content = response.choices[0]?.message?.content
      if (typeof content !== 'string') {
        log.warn({ choices: response.choices.length }, 'summarizer_empty_response')
        return ''
      }

      return content.trim()
    },
  }
}
