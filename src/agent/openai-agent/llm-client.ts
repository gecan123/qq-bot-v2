import OpenAI from 'openai'
import type {
  ChatCompletion,
  ChatCompletionContentPart,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
  ChatCompletionTool,
} from 'openai/resources/chat/completions/completions'
import type {
  LlmClient,
  LlmCallInput,
  LlmCallOutput,
  LlmStopReason,
} from '../llm-client.js'
import type {
  AgentMessage,
  AssistantToolCall,
  ToolResultContent,
  ToolResultContentBlock,
} from '../agent-context.types.js'
import type { Tool } from '../tool.js'
import { stripNullsFromOptionalFields, zodToOpenAIStrictToolJsonSchema } from '../tool-schema.js'
import { recordCurrentTokenUsage } from '../../llm/token-usage.js'

export interface CreateOpenAIAgentLlmClientInput {
  model: string
  contextWindowTokens: number
  baseURL: string
  apiKey: string
  client?: OpenAIChatCompletionClient
}

interface OpenAIChatCompletionClient {
  chat: {
    completions: {
      create(
        body: ChatCompletionCreateParamsNonStreaming,
        options?: { signal?: AbortSignal },
      ): Promise<ChatCompletion>
    }
  }
}

export function createOpenAIAgentLlmClient(input: CreateOpenAIAgentLlmClientInput): LlmClient {
  const client = input.client ?? new OpenAI({ baseURL: input.baseURL, apiKey: input.apiKey })

  return {
    async chat(req: LlmCallInput): Promise<LlmCallOutput> {
      try {
        const response = await client.chat.completions.create(
          buildOpenAIAgentRequest({
            model: input.model,
            systemPrompt: req.systemPrompt,
            messages: req.messages,
            tools: req.tools,
            maxOutputTokens: req.maxOutputTokens,
          }),
          req.signal ? { signal: req.signal } : undefined,
        )
        return toLlmCallOutput(response, input.model, input.contextWindowTokens, req.tools)
      } catch (error) {
        throw normalizeOpenAIError(error, input.contextWindowTokens)
      }
    },
  }
}

export function normalizeOpenAIError(error: unknown, contextWindowTokens: number): unknown {
  if (!error || typeof error !== 'object') return error
  const record = error as Record<string, unknown>
  const code = typeof record.code === 'string' ? record.code.toLowerCase() : ''
  const message = typeof record.message === 'string' ? record.message : ''
  const isOverflow = code === 'context_length_exceeded'
    || code === 'prompt_too_long'
    || /(?:maximum )?context length.*(?:exceed|limit)|prompt.*too long|too many input tokens/i.test(message)
  if (!isOverflow) return error
  try {
    Object.assign(record, { kind: 'context_overflow', contextWindowTokens })
    return error
  } catch {
    return Object.assign(new Error(message || 'model context window exceeded', { cause: error }), {
      kind: 'context_overflow' as const,
      contextWindowTokens,
      code: record.code,
    })
  }
}

export interface BuildOpenAIAgentRequestInput {
  model: string
  systemPrompt: string
  messages: AgentMessage[]
  tools: Tool[]
  maxOutputTokens?: number
}

export function buildOpenAIAgentRequest(input: BuildOpenAIAgentRequestInput): ChatCompletionCreateParamsNonStreaming {
  const messages: ChatCompletionMessageParam[] = [
    { role: 'developer', content: input.systemPrompt },
  ]
  for (const msg of input.messages) {
    messages.push(...toOpenAIMessage(msg))
  }

  return {
    model: input.model,
    messages,
    ...(input.tools.length > 0
      ? {
          tools: input.tools.map(toOpenAIToolDecl),
          tool_choice: 'required' as const,
        }
      : {}),
    prompt_cache_key: 'qq-bot-v2-main-agent',
    prompt_cache_retention: '24h',
    ...(input.maxOutputTokens != null
      ? { max_completion_tokens: Math.max(1, Math.floor(input.maxOutputTokens)) }
      : {}),
  }
}

function toOpenAIMessage(msg: AgentMessage): ChatCompletionMessageParam[] {
  if (msg.role === 'user') {
    return [{ role: 'user', content: msg.content }]
  }

  if (msg.role === 'assistant') {
    const hasToolCalls = msg.toolCalls.length > 0
    return [{
      role: 'assistant',
      content: msg.content.length > 0 ? msg.content : (hasToolCalls ? null : ''),
      ...(hasToolCalls ? { tool_calls: msg.toolCalls.map(toOpenAIToolCall) } : {}),
    }]
  }

  const { text, images } = splitToolResultContent(msg.content)
  const toolMessage: ChatCompletionMessageParam = {
    role: 'tool',
    tool_call_id: msg.toolCallId,
    content: images.length > 0
      ? `${text.length > 0 ? text : '[tool result]'}\n[图片见下一条 user image input]`
      : text,
  }
  if (images.length === 0) return [toolMessage]

  return [
    toolMessage,
    {
      role: 'user',
      content: [
        { type: 'text', text: `[tool result image: ${msg.toolCallId}]` },
        ...images.map(toOpenAIImagePart),
      ],
    },
  ]
}

function splitToolResultContent(content: ToolResultContent): {
  text: string
  images: Extract<ToolResultContentBlock, { type: 'image' }>[]
} {
  if (typeof content === 'string') return { text: content, images: [] }
  const textParts: string[] = []
  const images: Extract<ToolResultContentBlock, { type: 'image' }>[] = []
  for (const block of content) {
    if (block.type === 'text') {
      if (block.text.length > 0) textParts.push(block.text)
    } else if (block.type === 'image') {
      images.push(block)
    } else {
      textParts.push(JSON.stringify(block))
    }
  }
  return { text: textParts.join('\n'), images }
}

function toOpenAIImagePart(
  block: Extract<ToolResultContentBlock, { type: 'image' }>,
): ChatCompletionContentPart {
  return {
    type: 'image_url',
    image_url: {
      url: `data:${block.source.media_type};base64,${block.source.data}`,
    },
  }
}

function toOpenAIToolCall(call: AssistantToolCall): ChatCompletionMessageToolCall {
  return {
    id: call.id,
    type: 'function',
    function: {
      name: call.name,
      arguments: stableStringify(call.args),
    },
  }
}

function toOpenAIToolDecl(tool: Tool): ChatCompletionTool {
  return {
    type: 'function',
    function: {
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      parameters: zodToOpenAIStrictToolJsonSchema(tool.schema),
      strict: true,
    },
  }
}

function toLlmCallOutput(
  response: ChatCompletion,
  fallbackModel: string,
  contextWindowTokens: number,
  tools: Tool[],
): LlmCallOutput {
  const message = response.choices[0]?.message
  const toolByName = new Map(tools.map((tool) => [tool.name, tool]))
  const toolCalls = (message?.tool_calls ?? []).flatMap((call) => toAssistantToolCall(call, toolByName))
  const usage = response.usage
  const inputTokens = usage?.prompt_tokens ?? null
  const outputTokens = usage?.completion_tokens ?? null
  const cachedTokens = usage?.prompt_tokens_details?.cached_tokens ?? null

  if (inputTokens != null || outputTokens != null) {
    recordCurrentTokenUsage('agent.chat', {
      promptTokens: inputTokens ?? 0,
      completionTokens: outputTokens ?? 0,
      totalTokens: (inputTokens ?? 0) + (outputTokens ?? 0),
    })
  }

  return {
    content: typeof message?.content === 'string' ? message.content : '',
    toolCalls,
    usage: {
      inputTokens,
      cachedTokens,
      outputTokens,
    },
    model: response.model ?? fallbackModel,
    contextWindowTokens,
    stopReason: normalizeOpenAIStopReason(response.choices[0]?.finish_reason),
  }
}

export function normalizeOpenAIStopReason(value: string | null | undefined): LlmStopReason {
  switch (value) {
    case 'tool_calls':
    case 'function_call':
      return 'tool_use'
    case 'stop':
      return 'end_turn'
    case 'length':
      return 'max_tokens'
    case 'content_filter':
      return 'content_filter'
    default:
      return 'unknown'
  }
}

function toAssistantToolCall(
  call: ChatCompletionMessageToolCall,
  toolByName: ReadonlyMap<string, Tool>,
): AssistantToolCall[] {
  if (call.type !== 'function') return []
  const rawArgs = parseToolArguments(call.function.arguments)
  const tool = toolByName.get(call.function.name)
  return [{
    id: call.id,
    name: call.function.name,
    args: tool
      ? stripNullsFromOptionalFields(tool.schema, rawArgs) as Record<string, unknown>
      : rawArgs,
  }]
}

function parseToolArguments(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortJsonValue(value))
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue)
  if (!value || typeof value !== 'object') return value
  const input = value as Record<string, unknown>
  return Object.fromEntries(
    Object.keys(input).sort().map((key) => [key, sortJsonValue(input[key])]),
  )
}
