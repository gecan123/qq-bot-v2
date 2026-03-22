import OpenAI from 'openai'
import { z } from 'zod'
import type { AgentLlmAdapter, AgentMessage, AgentToolDeclaration, AgentTurnResult, ToolCall } from './types.js'
import { log } from '../logger.js'

function toOpenAIMessages(
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
          tool_calls: msg.calls.map((c) => ({
            id: c.id,
            type: 'function' as const,
            function: { name: c.name, arguments: JSON.stringify(c.args) },
          })),
        })
        break
      case 'tool_results':
        for (const r of msg.results) {
          messages.push({
            role: 'tool',
            tool_call_id: r.callId,
            content: r.error ? `Error: ${r.error}` : r.output,
          })
        }
        break
    }
  }

  return messages
}

function toOpenAITools(declarations: AgentToolDeclaration[]): OpenAI.Chat.ChatCompletionTool[] {
  return declarations.map((d) => ({
    type: 'function' as const,
    function: {
      name: d.name,
      description: d.description,
      parameters: z.toJSONSchema(d.inputSchema),
    },
  }))
}

interface FunctionToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

function parseToolCalls(toolCalls: OpenAI.Chat.ChatCompletionMessageToolCall[]): ToolCall[] {
  return toolCalls
    .filter((tc): tc is FunctionToolCall => tc.type === 'function' && 'function' in tc)
    .map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      args: (() => {
        try {
          return JSON.parse(tc.function.arguments) as Record<string, unknown>
        } catch {
          return {}
        }
      })(),
    }))
}

export class OpenAIAgentAdapter implements AgentLlmAdapter {
  private client: OpenAI
  private model: string

  constructor(baseURL: string, apiKey: string, model: string) {
    this.client = new OpenAI({ baseURL, apiKey })
    this.model = model
  }

  async chat(params: {
    systemPrompt: string
    history: AgentMessage[]
    tools: AgentToolDeclaration[]
  }): Promise<AgentTurnResult> {
    const messages = toOpenAIMessages(params.systemPrompt, params.history)
    const tools = toOpenAITools(params.tools)

    const response = await this.client.chat.completions.create({
      model: this.model,
      temperature: 0.7,
      messages,
      tools,
      tool_choice: 'auto',
    })

    const choice = response.choices[0]
    if (!choice) return { type: 'empty' }

    const message = choice.message

    const model = response.model

    if (message.tool_calls && message.tool_calls.length > 0) {
      const calls = parseToolCalls(message.tool_calls)
      log.debug({ calls: calls.map((c) => c.name) }, 'agent_tool_calls')
      return { type: 'tool_calls', calls, model }
    }

    const content = message.content?.trim()
    if (!content) return { type: 'empty' }

    return { type: 'text', content, model }
  }
}

export function createOpenAIAgentAdapter(): OpenAIAgentAdapter {
  const baseURL =
    process.env.LLM_AGENT_BASE_URL ??
    process.env.OPENAI_BASE_URL ??
    'http://127.0.0.1:8317/v1'
  const apiKey = process.env.LLM_AGENT_API_KEY ?? process.env.OPENAI_API_KEY ?? 'sk-local'
  const model = process.env.LLM_AGENT_MODEL ?? process.env.OPENAI_MODEL ?? 'gpt-5.1'
  return new OpenAIAgentAdapter(baseURL, apiKey, model)
}
