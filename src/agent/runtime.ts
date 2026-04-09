import OpenAI from 'openai'
import { createAgentOpenAIConfig, createOpenAIChatFn } from './openai-compat.js'

const config = createAgentOpenAIConfig()

export const agentClient = new OpenAI({ baseURL: config.baseURL, apiKey: config.apiKey })
export const agentModel = config.model

export function createAgentChatFn(opts?: { reasoningEffort?: OpenAI.Chat.ChatCompletionReasoningEffort }) {
  return createOpenAIChatFn(agentClient, agentModel, opts)
}
