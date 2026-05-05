import OpenAI from 'openai'
import { z } from 'zod'
import type { AgentMessage } from './agent-context.types.js'
import type { Tool } from './tool.js'
import type { AssistantToolCall } from './agent-context.types.js'
import { config } from '../config/index.js'
import { recordCurrentTokenUsage, toTokenUsage } from '../llm/token-usage.js'

/**
 * LLM 调用契约 (BotLoopAgent runRound 用)。
 *
 * 关键不变量:
 *  - input.systemPrompt 和 input.messages 字节稳定 = cache 命中前提
 *  - 翻译成 OpenAI ChatCompletion params 是确定性纯函数,不引入随机字段
 */
export interface LlmCallInput {
  systemPrompt: string
  messages: AgentMessage[]
  tools: Tool[]
}

export interface LlmCallOutput {
  /** 模型在 assistant message 里写的"思考"内容(可空)。 */
  content: string
  toolCalls: AssistantToolCall[]
  /** 用于观测 cache 命中的 usage。 */
  usage: {
    inputTokens: number | null
    cachedTokens: number | null
    outputTokens: number | null
  }
  model: string
}

export interface LlmClient {
  chat(input: LlmCallInput): Promise<LlmCallOutput>
}

interface CreateLlmClientOptions {
  baseURL?: string
  apiKey?: string
  model?: string
}

/**
 * 默认走 config.llm 里 default provider 的 URL/API key + default model。
 * 当前 agent / compaction / fetch_url 摘要 共享同一个 default model;
 * 想把摘要类调用切到便宜模型 → 走 LLM_SCENARIO_SUMMARIZE_* 路由
 * (见 docs/idle-fetch-mvp.zh-CN.md §"已知 Trade-offs" 第 3 条).
 */
export function createLlmClient(options: CreateLlmClientOptions = {}): LlmClient {
  const defaultProvider = config.llm.providers[config.llm.defaultProvider]
  const baseURL = options.baseURL ?? defaultProvider.url
  const apiKey = options.apiKey ?? defaultProvider.apiKey
  const model = options.model ?? config.llm.defaultModel

  const client = new OpenAI({ baseURL, apiKey })

  return {
    async chat(input) {
      const response = await client.chat.completions.create({
        model,
        temperature: 0.8,
        messages: toOpenAIMessages(input.systemPrompt, input.messages),
        tools: toOpenAITools(input.tools),
        tool_choice: 'auto',
      })
      recordCurrentTokenUsage('agent.chat', toTokenUsage(response.usage))

      const choice = response.choices[0]
      const message = choice?.message
      const usage = {
        inputTokens: response.usage?.prompt_tokens ?? null,
        cachedTokens: response.usage?.prompt_tokens_details?.cached_tokens ?? null,
        outputTokens: response.usage?.completion_tokens ?? null,
      }

      const toolCalls = parseToolCalls(message?.tool_calls ?? [])
      const content = typeof message?.content === 'string' ? message.content : ''

      return {
        content,
        toolCalls,
        usage,
        model: response.model,
      }
    },
  }
}

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
      case 'assistant':
        if (msg.toolCalls.length > 0) {
          messages.push({
            role: 'assistant',
            content: msg.content || null,
            tool_calls: msg.toolCalls.map((call) => ({
              id: call.id,
              type: 'function' as const,
              function: { name: call.name, arguments: JSON.stringify(call.args) },
            })),
          })
        } else {
          messages.push({ role: 'assistant', content: msg.content })
        }
        break
      case 'tool':
        messages.push({
          role: 'tool',
          tool_call_id: msg.toolCallId,
          content: msg.content,
        })
        break
    }
  }

  return messages
}

export function toOpenAITools(tools: Tool[]): OpenAI.Chat.ChatCompletionTool[] {
  return tools.map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: z.toJSONSchema(tool.schema),
    },
  }))
}

interface FunctionToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export function parseToolCalls(
  toolCalls: OpenAI.Chat.ChatCompletionMessageToolCall[],
): AssistantToolCall[] {
  return toolCalls
    .filter((call): call is FunctionToolCall => call.type === 'function' && 'function' in call)
    .map((call) => ({
      id: call.id,
      name: call.function.name,
      args: safeParseJson(call.function.arguments),
    }))
}

function safeParseJson(input: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(input)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return {}
  } catch {
    return {}
  }
}
