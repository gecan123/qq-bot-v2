import OpenAI from 'openai'
import { z } from 'zod'
import { recordCurrentTokenUsage, toTokenUsage } from '../llm/token-usage.js'
import { log } from '../logger.js'
import type { AgentMessage, AgentToolDeclaration, AgentTurnResult, ToolCall } from './types.js'

export function toOpenAIMessages(
  systemPrompt: string,
  history: AgentMessage[],
): OpenAI.Chat.ChatCompletionMessageParam[] {
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
  ]

  for (const msg of history) {
    switch (msg.role) {
      case 'user':
        messages.push({ role: 'user', content: msg.content })
        break
      case 'model':
        messages.push({ role: 'assistant', content: msg.content })
        break
      case 'tool_calls':
        messages.push({
          role: 'assistant',
          content: null,
          tool_calls: msg.calls.map((call) => ({
            id: call.id,
            type: 'function' as const,
            function: { name: call.name, arguments: JSON.stringify(call.args) },
          })),
        })
        break
      case 'tool_results':
        for (const result of msg.results) {
          messages.push({
            role: 'tool',
            tool_call_id: result.callId,
            content: result.error ? `Error: ${result.error}` : result.output,
          })
        }
        break
    }
  }

  return messages
}

export function toOpenAITools(declarations: AgentToolDeclaration[]): OpenAI.Chat.ChatCompletionTool[] {
  return declarations.map((declaration) => ({
    type: 'function' as const,
    function: {
      name: declaration.name,
      description: declaration.description,
      parameters: z.toJSONSchema(declaration.inputSchema),
    },
  }))
}

interface FunctionToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export function parseToolCalls(toolCalls: OpenAI.Chat.ChatCompletionMessageToolCall[]): ToolCall[] {
  return toolCalls
    .filter((toolCall): toolCall is FunctionToolCall => toolCall.type === 'function' && 'function' in toolCall)
    .map((toolCall) => ({
      id: toolCall.id,
      name: toolCall.function.name,
      args: (() => {
        try {
          return JSON.parse(toolCall.function.arguments) as Record<string, unknown>
        } catch {
          return {}
        }
      })(),
    }))
}

export function createAgentOpenAIConfig(): { baseURL: string; apiKey: string; model: string } {
  const defaultProviderName = process.env.LLM_DEFAULT_PROVIDER?.toLowerCase()
  const defaultProviderUrl = defaultProviderName
    ? process.env[`LLM_PROVIDER_${defaultProviderName.toUpperCase()}_URL`]
    : undefined
  const defaultProviderApiKey = defaultProviderName
    ? process.env[`LLM_PROVIDER_${defaultProviderName.toUpperCase()}_API_KEY`]
    : undefined

  return {
    baseURL: process.env.LLM_AGENT_BASE_URL ?? defaultProviderUrl ?? process.env.OPENAI_BASE_URL ?? 'http://127.0.0.1:8317/v1',
    apiKey: process.env.LLM_AGENT_API_KEY ?? defaultProviderApiKey ?? process.env.OPENAI_API_KEY ?? 'sk-local',
    model: process.env.LLM_AGENT_MODEL ?? process.env.LLM_DEFAULT_MODEL ?? process.env.OPENAI_MODEL ?? 'gpt-5.1',
  }
}

export function createOpenAIChatFn(
  client: OpenAI,
  model: string,
  opts?: { reasoningEffort?: OpenAI.Chat.ChatCompletionReasoningEffort },
): (params: {
  systemPrompt: string
  history: AgentMessage[]
  tools: AgentToolDeclaration[]
}) => Promise<AgentTurnResult> {
  return async ({ systemPrompt, history, tools }) => {
    const response = await client.chat.completions.create({
      model,
      temperature: 0.7,
      ...(opts?.reasoningEffort ? { reasoning_effort: opts.reasoningEffort } : {}),
      messages: toOpenAIMessages(systemPrompt, history),
      tools: toOpenAITools(tools),
      tool_choice: 'auto',
    })
    recordCurrentTokenUsage('agent.chat', toTokenUsage(response.usage))

    const choice = response.choices[0]
    if (!choice) return { type: 'empty' }

    const message = choice.message
    const responseModel = response.model
    const messageContent = typeof message.content === 'string' ? message.content.trim() : undefined

    if (message.tool_calls && message.tool_calls.length > 0) {
      const calls = parseToolCalls(message.tool_calls)
      log.debug({ calls: calls.map((call) => call.name) }, 'agent_tool_calls')
      return messageContent
        ? { type: 'tool_calls', calls, model: responseModel, content: messageContent }
        : { type: 'tool_calls', calls, model: responseModel }
    }

    const content = messageContent
    if (!content) return { type: 'empty' }

    return { type: 'text', content, model: responseModel }
  }
}
